"""Bounded, best-effort checkpoints for trusted local REPL state.

A checkpoint stores each top-level value as a separate ``dill`` byte string.
This means one value that cannot be serialized does not prevent other values
from being saved.  It also means that object identity shared by two names is
not guaranteed after restore: each name is loaded independently.  Loading a
checkpoint is deliberately limited to trusted local files because ``dill``
loading can execute arbitrary code.

This module does not attempt to interrupt serialization.  A caller that needs
a host deadline must compose this synchronous component with its own timeout
or worker policy.
"""

from __future__ import annotations

import asyncio
import inspect
import io
import os
import socket
import tempfile
import types
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, MutableMapping

import dill

DEFAULT_MAX_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_VALUE_BYTES = 16 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class CheckpointLimits:
    """Limits applied while making one checkpoint.

    ``max_bytes`` bounds the complete on-disk payload, while
    ``max_value_bytes`` bounds each independently serialized value.  A zero
    limit is valid and can be useful to deliberately make an empty snapshot;
    in practice ``max_bytes`` must still fit the small payload header.
    """

    max_bytes: int = DEFAULT_MAX_BYTES
    max_value_bytes: int = DEFAULT_MAX_VALUE_BYTES

    def __post_init__(self) -> None:
        for name, value in (
            ("max_bytes", self.max_bytes),
            ("max_value_bytes", self.max_value_bytes),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{name} must be a non-negative integer")


@dataclass(frozen=True, slots=True)
class ValueIssue:
    """A name omitted from a snapshot or a name that failed to restore."""

    name: str
    reason: str


@dataclass(frozen=True, slots=True)
class CheckpointReport:
    """Result of :meth:`CheckpointStore.save`.

    ``saved`` contains only names whose generation was atomically published.
    ``skipped`` describes values omitted without making the old checkpoint
    unusable.  A non-``None`` ``error`` means no new generation was published.
    """

    saved: tuple[str, ...] = ()
    skipped: tuple[ValueIssue, ...] = ()
    # Populated by LocalKernel relative to the preceding successful checkpoint.
    # ``skipped`` remains the complete queryable inventory.
    newly_skipped: tuple[ValueIssue, ...] = ()
    # A newly observed save failure for automatic reporting; ``error`` remains
    # the complete current status even after an identical failure is reported.
    notice_error: str | None = None
    byte_count: int = 0
    checkpoint_id: str = ""
    created_at: str = ""
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None


@dataclass(frozen=True, slots=True)
class RestoreReport:
    """Result of :meth:`CheckpointStore.restore`.

    Values are staged first and applied to the supplied namespace only after
    every value has had an independent load attempt.  Existing names are not
    deleted or pruned.
    """

    restored: tuple[str, ...] = ()
    skipped: tuple[ValueIssue, ...] = ()
    failed: tuple[ValueIssue, ...] = ()
    checkpoint_id: str | None = None
    created_at: str | None = None
    reason: str | None = None

    @property
    def ok(self) -> bool:
        return not self.failed


# These two narrow hooks are intentionally module-level.  They keep the public
# API small while giving callers/tests a safe way to inject a serializer or a
# publication fault without replacing a live checkpoint first.
def _dill_dump(value: Any, stream: Any) -> None:
    dill.dump(value, stream, recurse=True)


def _atomic_write(path: Path, payload: bytes) -> None:
    """Write *payload* beside *path*, then atomically replace *path*."""
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(parent)
    )
    temporary_path = Path(temporary)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
        # Directory fsync is best effort.  It is not available on every host
        # and atomic replacement itself is the important invariant here.
        try:
            directory_fd = os.open(parent, os.O_RDONLY)
        except OSError:
            pass
        else:
            try:
                os.fsync(directory_fd)
            except OSError:
                pass
            finally:
                os.close(directory_fd)
    finally:
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass


def _safe_reason(error: BaseException) -> str:
    try:
        detail = str(error)
    except BaseException:
        detail = "unable to describe error"
    if not detail:
        detail = type(error).__name__
    return f"{type(error).__name__}: {detail[:200]}"


def _runtime_types() -> tuple[type[Any], ...]:
    """Return live runtime/resource types without making import-time cycles."""
    # Imports are local because runtime and mailbox are peers of this module.
    # Keep this list explicit: arbitrary user objects are not rejected merely
    # because they happen to have a similarly named attribute.
    try:
        from .mailbox import Mailbox, MailboxRef
    except Exception:  # pragma: no cover - only relevant during partial imports
        mailbox_types: tuple[type[Any], ...] = ()
    else:
        mailbox_types = (Mailbox, MailboxRef)
    try:
        from .runtime import AgentRef, ProgramAgentHandle, Runtime
    except Exception:  # pragma: no cover - only relevant during partial imports
        runtime_types: tuple[type[Any], ...] = ()
    else:
        runtime_types = (ProgramAgentHandle, AgentRef, Runtime)

    resource_types: list[type[Any]] = list(mailbox_types + runtime_types)
    # Process handles are not recoverable state.  They are imported here to
    # avoid adding a process API dependency to this small component.
    try:
        from multiprocessing.process import BaseProcess
    except Exception:  # pragma: no cover
        pass
    else:
        resource_types.append(BaseProcess)
    try:
        from subprocess import Popen
    except Exception:  # pragma: no cover
        pass
    else:
        resource_types.append(Popen)
    try:
        from asyncio.subprocess import Process
    except Exception:  # pragma: no cover
        pass
    else:
        resource_types.append(Process)
    return tuple(resource_types)


def _is_live_resource(value: Any) -> bool:
    if isinstance(value, (io.IOBase, socket.socket, asyncio.Task, asyncio.Future)):
        return True
    if inspect.iscoroutine(value) or inspect.isgenerator(value):
        return True
    if inspect.isasyncgen(value):
        return True
    return isinstance(value, _runtime_types())


def _contains_live_resource(value: Any) -> bool:
    """Inspect a bounded object graph without recursive Python calls."""
    pending = [value]
    seen: set[int] = set()
    inspected = 0
    while pending:
        current = pending.pop()
        if _is_live_resource(current):
            return True
        if current is None or isinstance(
            current,
            (bool, int, float, complex, str, bytes, bytearray, types.ModuleType),
        ):
            continue
        identity = id(current)
        if identity in seen:
            continue
        seen.add(identity)
        inspected += 1
        # A value too complex to inspect safely is skipped rather than risking
        # unbounded checkpoint work or hiding a deeply nested live handle.
        if inspected > 100_000:
            return True

        if isinstance(current, type):
            if current.__module__ == "builtins":
                continue
            for name, member in vars(current).items():
                if name in {"__dict__", "__weakref__", "__doc__", "__module__"}:
                    continue
                if isinstance(member, (staticmethod, classmethod)):
                    pending.append(member.__func__)
                elif isinstance(member, property):
                    pending.extend(
                        item
                        for item in (member.fget, member.fset, member.fdel)
                        if item is not None
                    )
                elif not inspect.isdatadescriptor(member):
                    pending.append(member)
            continue
        if inspect.isfunction(current):
            try:
                closure = inspect.getclosurevars(current)
            except (TypeError, ValueError):
                continue
            pending.extend(closure.globals.values())
            pending.extend(closure.nonlocals.values())
            pending.extend(current.__defaults__ or ())
            pending.extend((current.__kwdefaults__ or {}).values())
            continue
        if inspect.ismethod(current):
            pending.extend((current.__self__, current.__func__))
            continue
        if isinstance(current, dict):
            for key, item in dict.items(current):
                pending.extend((key, item))
            continue
        if isinstance(current, list):
            pending.extend(list.__iter__(current))
            continue
        if isinstance(current, tuple):
            pending.extend(tuple.__iter__(current))
            continue
        if isinstance(current, set):
            pending.extend(set.__iter__(current))
            continue
        if isinstance(current, frozenset):
            pending.extend(frozenset.__iter__(current))
            continue

        try:
            attributes = object.__getattribute__(current, "__dict__")
        except (AttributeError, TypeError):
            attributes = None
        if isinstance(attributes, dict):
            pending.extend(dict.values(attributes))

        for cls in type(current).__mro__:
            if cls.__module__ != "builtins":
                pending.append(cls)
            for descriptor in vars(cls).values():
                if not isinstance(descriptor, types.MemberDescriptorType):
                    continue
                try:
                    pending.append(descriptor.__get__(current, type(current)))
                except (AttributeError, TypeError):
                    continue
    return False


def _exclusion_reason(value: Any) -> str | None:
    """Describe why *value* cannot be recovered, if it cannot be."""
    if isinstance(value, types.ModuleType):
        return "imported module is not recoverable"
    if _contains_live_resource(value):
        return "runtime value is not recoverable"
    return None


def _issue(name: Any, reason: str) -> ValueIssue:
    return ValueIssue(name if isinstance(name, str) else repr(name), reason)


def _encode_payload(
    values: Mapping[str, bytes],
    *,
    checkpoint_id: str,
    created_at: str,
    skipped: tuple[ValueIssue, ...],
) -> bytes:
    # The format is one dill object with independently serialized value blobs.
    # ``values`` is copied to make accidental mutation during serialization
    # impossible and to keep ordering deterministic.  Save-time skips are
    # retained so recovery can explain why a live value is absent.
    payload = {
        "version": 1,
        "checkpoint_id": checkpoint_id,
        "created_at": created_at,
        "skipped": [{"name": issue.name, "reason": issue.reason} for issue in skipped],
        "values": dict(values),
    }
    output = io.BytesIO()
    _dill_dump(payload, output)
    return output.getvalue()


def _decode_payload(
    path: Path,
    *,
    max_bytes: int,
) -> tuple[Mapping[Any, Any], tuple[ValueIssue, ...], str | None, str | None]:
    with path.open("rb") as stream:
        if os.fstat(stream.fileno()).st_size > max_bytes:
            raise ValueError("checkpoint exceeds aggregate byte cap")
        payload = dill.load(stream)
    if not isinstance(payload, dict):
        raise ValueError("checkpoint payload is not a dictionary")
    if payload.get("version") != 1:
        raise ValueError("unsupported checkpoint version")
    values = payload.get("values")
    if not isinstance(values, dict):
        raise ValueError("checkpoint values are not a dictionary")
    checkpoint_id = payload.get("checkpoint_id")
    created_at = payload.get("created_at")
    if not isinstance(checkpoint_id, str) or not isinstance(created_at, str):
        raise ValueError("checkpoint metadata is invalid")
    raw_skipped = payload.get("skipped", [])
    if not isinstance(raw_skipped, list):
        raise ValueError("checkpoint skipped metadata is invalid")
    skipped: list[ValueIssue] = []
    for item in raw_skipped:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("name"), str)
            or not isinstance(item.get("reason"), str)
        ):
            raise ValueError("checkpoint skipped metadata is invalid")
        skipped.append(ValueIssue(item["name"], item["reason"]))
    return values, tuple(skipped), checkpoint_id, created_at


class CheckpointStore:
    """Save and restore bounded snapshots at one trusted local path."""

    def __init__(
        self,
        path: str | os.PathLike[str],
        limits: CheckpointLimits = CheckpointLimits(),
    ) -> None:
        if not isinstance(limits, CheckpointLimits):
            raise TypeError("limits must be CheckpointLimits")
        self.path = Path(path)
        self.limits = limits

    def save(self, namespace: Mapping[str, Any]) -> CheckpointReport:
        """Best-effort save of user values, without changing *namespace*.

        The old file remains untouched until a complete new payload has been
        serialized and atomically published.  Serialization failures for one
        value are reported as skips; publication failures report ``error``.
        """
        if not isinstance(namespace, Mapping):
            raise TypeError("namespace must be a mapping")
        checkpoint_id = uuid.uuid4().hex
        created_at = datetime.now(timezone.utc).isoformat()

        values: dict[str, bytes] = {}
        skipped: list[ValueIssue] = []
        total_value_bytes = 0
        for raw_name in sorted(namespace, key=lambda item: str(item)):
            if not isinstance(raw_name, str):
                skipped.append(_issue(raw_name, "name is not a string"))
                continue
            name = raw_name
            if name.startswith("_"):
                skipped.append(_issue(name, "internal name"))
                continue
            try:
                value = namespace[name]
            except BaseException as error:
                skipped.append(_issue(name, f"read failed: {_safe_reason(error)}"))
                continue
            try:
                exclusion_reason = _exclusion_reason(value)
            except BaseException as error:
                skipped.append(
                    _issue(name, f"resource inspection failed: {_safe_reason(error)}")
                )
                continue
            if exclusion_reason is not None:
                skipped.append(_issue(name, exclusion_reason))
                continue

            output = io.BytesIO()
            try:
                _dill_dump(value, output)
                blob = output.getvalue()
            except BaseException as error:
                skipped.append(
                    _issue(name, f"serialization failed: {_safe_reason(error)}")
                )
                continue
            if len(blob) > self.limits.max_value_bytes:
                skipped.append(_issue(name, "exceeds per-value byte cap"))
                continue
            if total_value_bytes + len(blob) > self.limits.max_bytes:
                skipped.append(_issue(name, "exceeds aggregate byte cap"))
                continue
            values[name] = blob
            total_value_bytes += len(blob)

        # Encode before opening a temporary file.  A serializer error therefore
        # cannot truncate or replace the prior generation.
        try:
            payload = _encode_payload(
                values,
                checkpoint_id=checkpoint_id,
                created_at=created_at,
                skipped=tuple(skipped),
            )
        except Exception as error:
            return CheckpointReport(
                skipped=tuple(skipped),
                checkpoint_id=checkpoint_id,
                created_at=created_at,
                error=f"serialization failed: {_safe_reason(error)}",
            )

        # The value-byte accounting above is useful and deterministic, but the
        # envelope itself also consumes bytes.  Keep the complete file bounded
        # by dropping values from the end (never the live namespace) if needed.
        if len(payload) > self.limits.max_bytes:
            for name in reversed(tuple(values)):
                del values[name]
                skipped.append(_issue(name, "exceeds aggregate byte cap"))
                try:
                    payload = _encode_payload(
                        values,
                        checkpoint_id=checkpoint_id,
                        created_at=created_at,
                        skipped=tuple(skipped),
                    )
                except Exception as error:
                    return CheckpointReport(
                        skipped=tuple(skipped),
                        checkpoint_id=checkpoint_id,
                        created_at=created_at,
                        error=f"serialization failed: {_safe_reason(error)}",
                    )
                if len(payload) <= self.limits.max_bytes:
                    break
            if len(payload) > self.limits.max_bytes:
                return CheckpointReport(
                    skipped=tuple(skipped),
                    checkpoint_id=checkpoint_id,
                    created_at=created_at,
                    error="aggregate byte cap is smaller than payload header",
                )

        try:
            _atomic_write(self.path, payload)
        except Exception as error:
            # ``_atomic_write`` owns only a temporary same-directory file until
            # os.replace succeeds, so this leaves the old generation intact.
            return CheckpointReport(
                skipped=tuple(skipped),
                checkpoint_id=checkpoint_id,
                created_at=created_at,
                error=f"write failed: {_safe_reason(error)}",
            )

        saved = tuple(sorted(values))
        # A name removed solely to satisfy the final envelope cap was already
        # reported above.  Keep issue order deterministic for callers.
        skipped.sort(key=lambda item: item.name)
        return CheckpointReport(
            saved=saved,
            skipped=tuple(skipped),
            byte_count=len(payload),
            checkpoint_id=checkpoint_id,
            created_at=created_at,
        )

    def restore(self, namespace: MutableMapping[str, Any]) -> RestoreReport:
        """Restore independently loadable values into *namespace*.

        The caller should pass a fresh namespace.  This method does not clear
        it, and never removes names that are absent from the checkpoint.
        """
        if not isinstance(namespace, MutableMapping):
            raise TypeError("namespace must be a mutable mapping")
        if not self.path.exists():
            return RestoreReport(reason="checkpoint not found")

        try:
            values, persisted_skipped, checkpoint_id, created_at = _decode_payload(
                self.path, max_bytes=self.limits.max_bytes
            )
        except BaseException as error:
            return RestoreReport(
                failed=(
                    ValueIssue("<checkpoint>", f"load failed: {_safe_reason(error)}"),
                ),
                reason="corrupt checkpoint",
            )

        staged: dict[str, Any] = {}
        skipped: list[ValueIssue] = list(persisted_skipped)
        failed: list[ValueIssue] = []
        for raw_name in sorted(values, key=lambda item: str(item)):
            if not isinstance(raw_name, str):
                failed.append(_issue(raw_name, "name is not a string"))
                continue
            name = raw_name
            if name.startswith("_"):
                skipped.append(_issue(name, "internal name"))
                continue
            blob = values[raw_name]
            if not isinstance(blob, bytes):
                failed.append(_issue(name, "stored value is not bytes"))
                continue
            if len(blob) > self.limits.max_value_bytes:
                failed.append(_issue(name, "stored value exceeds per-value byte cap"))
                continue
            try:
                value = dill.loads(blob)
            except BaseException as error:
                failed.append(
                    _issue(name, f"deserialization failed: {_safe_reason(error)}")
                )
                continue
            try:
                exclusion_reason = _exclusion_reason(value)
            except BaseException as error:
                failed.append(
                    _issue(name, f"resource inspection failed: {_safe_reason(error)}")
                )
                continue
            if exclusion_reason is not None:
                skipped.append(_issue(name, exclusion_reason))
                continue
            staged[name] = value

        # No namespace mutation happens during any dill load.  Apply only after
        # all independent entries have had their chance to load.
        restored: list[str] = []
        for name, value in staged.items():
            try:
                namespace[name] = value
            except BaseException as error:
                failed.append(_issue(name, f"restore failed: {_safe_reason(error)}"))
            else:
                restored.append(name)

        return RestoreReport(
            restored=tuple(sorted(restored)),
            skipped=tuple(sorted(skipped, key=lambda item: item.name)),
            failed=tuple(sorted(failed, key=lambda item: item.name)),
            checkpoint_id=checkpoint_id,
            created_at=created_at,
        )


__all__ = [
    "CheckpointLimits",
    "ValueIssue",
    "CheckpointReport",
    "RestoreReport",
    "CheckpointStore",
]
