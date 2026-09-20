"""Bounded, in-process mailboxes used by the local runtime."""

from __future__ import annotations

import asyncio
import datetime as _datetime
import inspect
import json
import math
import uuid
from collections import deque
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Generic, Literal, TypeVar

from .errors import (
    MailboxClosedError,
    MailboxFullError,
    MailboxInUseError,
    MailboxNotFoundError,
    MessageValidationError,
    PermissionDeniedError,
    UnsupportedDeliveryModeError,
)

if TYPE_CHECKING:
    from .runtime import Runtime

M = TypeVar("M")
# Public annotation used by callers that want an untyped JSON mailbox value.
JsonValue = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]

DeliveryMode = Literal["steer", "followup", "inject"]
_DELIVERY_MODES = frozenset(("steer", "followup", "inject"))


def _json_clone(value: Any, *, field: str | None = None) -> Any:
    """Copy a value through the strict JSON value subset.

    ``json.dumps`` alone accepts tuples and silently stringifies non-string
    mapping keys.  Mailboxes use an explicit walk so those Python-only values
    cannot cross the message boundary.
    """
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise MessageValidationError("JSON numbers must be finite", field=field)
        return value
    if isinstance(value, list):
        return [_json_clone(item, field=field) for item in value]
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise MessageValidationError(
                    "JSON object keys must be strings", field=field
                )
            result[key] = _json_clone(item, field=f"{field}.{key}" if field else key)
        return result
    raise MessageValidationError(
        f"value of type {type(value).__name__} is not a JSON value", field=field
    )


def _json_size(value: Any) -> int:
    # Pydantic receivers retain a reconstructed model object, while its size
    # is measured on the JSON representation that crossed the boundary.
    if hasattr(value, "model_dump"):
        try:
            value = _json_clone(value.model_dump(mode="json"))
        except Exception as exc:
            raise MessageValidationError(
                f"value cannot be represented as JSON: {exc}"
            ) from exc
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:  # defensive: _json_clone did the walk
        raise MessageValidationError(f"value cannot be encoded as JSON: {exc}") from exc
    return len(encoded)


def _pydantic_model_type(value: Any) -> bool:
    try:
        from pydantic import BaseModel
    except ImportError:
        return False
    return inspect.isclass(value) and issubclass(value, BaseModel)


def _schema_contains_user_hook(value: Any) -> bool:
    if isinstance(value, dict):
        schema_type = value.get("type")
        if isinstance(schema_type, str) and (
            schema_type.startswith("function-")
            or schema_type in {"call", "is-instance"}
        ):
            return True
        return any(_schema_contains_user_hook(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return any(_schema_contains_user_hook(item) for item in value)
    return False


def _validate_model_registration(model_type: type[Any]) -> None:
    from pydantic import BaseModel, TypeAdapter

    if (
        model_type.__init__ is not BaseModel.__init__
        or model_type.model_dump is not BaseModel.model_dump
        or model_type.model_post_init is not BaseModel.model_post_init
    ):
        raise TypeError("custom Pydantic model hooks are not supported")
    decorators = getattr(model_type, "__pydantic_decorators__", None)
    if decorators is not None:
        hook_names = (
            "validators",
            "field_validators",
            "root_validators",
            "field_serializers",
            "model_serializers",
            "model_validators",
            "computed_fields",
        )
        if any(getattr(decorators, name, None) for name in hook_names):
            raise TypeError(
                "custom Pydantic validators and serializers are not supported"
            )
    adapter = TypeAdapter(model_type)
    try:
        adapter.json_schema()
    except Exception as error:
        raise TypeError("message model must have a JSON schema") from error
    if _schema_contains_user_hook(model_type.__pydantic_core_schema__):
        raise TypeError(
            "custom Pydantic validators and Python-only fields are not supported"
        )


def _validate_model(model_type: type[Any], body: Any) -> Any:
    """Validate and reconstruct a Pydantic model without input coercion."""
    try:
        from pydantic import TypeAdapter, ValidationError
    except ImportError as exc:  # registration prevents reaching this normally
        raise MessageValidationError(
            "typed model mailboxes require the pydantic package"
        ) from exc

    if isinstance(body, model_type):
        try:
            raw = body.model_dump(mode="json")
        except Exception as exc:
            raise MessageValidationError(
                f"model cannot be represented as JSON: {exc}"
            ) from exc
    else:
        raw = body
    # This also makes sender and receiver see the same JSON representation.
    raw = _json_clone(raw)
    try:
        adapter = TypeAdapter(model_type)
        # strict=True rejects e.g. {"count": "1"} for an int field.
        validated = adapter.validate_python(raw, strict=True)
    except ValidationError as exc:
        field = None
        if exc.errors():
            loc = exc.errors()[0].get("loc", ())
            field = ".".join(str(part) for part in loc) or None
        raise MessageValidationError(
            f"body does not match {model_type.__name__}: {exc}", field=field
        ) from exc
    try:
        canonical = _json_clone(validated.model_dump(mode="json"))
        # Reconstruct from canonical JSON so the queued value is detached from
        # a sender-owned model instance.
        return adapter.validate_python(canonical, strict=True)
    except (ValidationError, AttributeError, TypeError, ValueError) as exc:
        raise MessageValidationError(
            f"body for {model_type.__name__} cannot cross the JSON boundary: {exc}"
        ) from exc


@dataclass(frozen=True)
class MailboxConfig:
    message_type: type[Any] | None = None
    capacity: int = 64
    max_message_bytes: int = 65_536

    def __post_init__(self) -> None:
        if (
            not isinstance(self.capacity, int)
            or isinstance(self.capacity, bool)
            or self.capacity <= 0
        ):
            raise ValueError("mailbox capacity must be a positive integer")
        if self.capacity > 1_000_000:
            raise ValueError("mailbox capacity exceeds the host limit")
        if (
            not isinstance(self.max_message_bytes, int)
            or isinstance(self.max_message_bytes, bool)
            or self.max_message_bytes <= 0
        ):
            raise ValueError("max_message_bytes must be a positive integer")
        if self.max_message_bytes > 16 * 1024 * 1024:
            raise ValueError("max_message_bytes exceeds the host limit")
        if self.message_type is not None:
            if self.message_type is str:
                return
            if not _pydantic_model_type(self.message_type):
                raise TypeError(
                    "message_type must be str, a Pydantic BaseModel class, or None"
                )
            _validate_model_registration(self.message_type)


@dataclass(frozen=True)
class SendReceipt:
    message_id: str
    mailbox_id: str
    accepted_at: str


@dataclass(frozen=True)
class Message(Generic[M]):
    id: str
    sender: MailboxRef
    body: M


class MailboxRef:
    """An immutable address with the ability to admit a message."""

    __slots__ = ("_id", "_agent_id", "_backend")

    def __init__(
        self,
        mailbox_id: str,
        agent_id: str,
        backend: Mailbox[Any] | None = None,
    ) -> None:
        self._id = mailbox_id
        self._agent_id = agent_id
        self._backend = backend

    @property
    def id(self) -> str:
        return self._id

    @property
    def agent_id(self) -> str:
        return self._agent_id

    def __repr__(self) -> str:
        return f"MailboxRef(id={self.id!r}, agent_id={self.agent_id!r})"

    def __hash__(self) -> int:
        return hash(self.id)

    def __eq__(self, other: object) -> bool:
        return isinstance(other, MailboxRef) and self.id == other.id

    async def send(
        self,
        body: Any,
        *,
        mode: str | None = None,
        timeout: float = 5.0,
    ) -> SendReceipt:
        _validate_send_timeout(timeout)
        backend = self._backend
        if backend is None:
            raise MailboxNotFoundError(self.id)
        from .runtime import current_runtime

        sender_runtime = current_runtime()
        return backend._admit(body, sender_runtime.mailbox, mode=mode)


def _validate_send_timeout(timeout: float) -> None:
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        raise ValueError("send timeout must be a finite positive number")
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("send timeout must be a finite positive number")


class Mailbox(MailboxRef, Generic[M]):
    """An owned bounded mailbox with synchronous and asynchronous receive."""

    __slots__ = (
        "_owner_runtime",
        "_config",
        "_queue",
        "_waiters",
        "_closed",
        "_driver_managed",
    )

    def __init__(
        self,
        mailbox_id: str,
        agent_id: str,
        owner_runtime: Runtime,
        config: MailboxConfig,
        *,
        driver_managed: bool = False,
    ) -> None:
        super().__init__(mailbox_id, agent_id, None)
        self._owner_runtime = owner_runtime
        self._config = config
        self._queue: deque[Message[Any]] = deque()
        # Waiters are wake signals only.  Accepted messages always stay in
        # the bounded queue until receive() synchronously removes one.  This
        # preserves a message if cancellation wins after wakeup but before the
        # receiving task resumes.
        self._waiters: deque[asyncio.Future[None]] = deque()
        self._closed = False
        self._driver_managed = driver_managed
        self._backend = self  # MailboxRef.send resolves the concrete mailbox.

    @property
    def config(self) -> MailboxConfig:
        return self._config

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def driver_managed(self) -> bool:
        return self._driver_managed

    def _validate_receive_owner(self) -> None:
        from .runtime import current_runtime

        runtime = current_runtime()
        if runtime is not self._owner_runtime:
            raise PermissionDeniedError(
                f"runtime {getattr(runtime, 'agent_id', None)!r} cannot receive mailbox {self.id!r}"
            )
        if self._driver_managed:
            raise MailboxInUseError(self.id)

    def _validate_body(self, body: Any) -> Any:
        expected = self._config.message_type
        if expected is None:
            copied = _json_clone(body)
        elif expected is str:
            if not isinstance(body, str):
                raise MessageValidationError(
                    f"expected str, got {type(body).__name__}", field="body"
                )
            copied = body
        else:
            copied = _validate_model(expected, body)
        if _json_size(copied) > self._config.max_message_bytes:
            raise MessageValidationError(
                f"message exceeds max_message_bytes={self._config.max_message_bytes}",
                field="body",
            )
        return copied

    def _admit(
        self,
        body: Any,
        sender: Mailbox,
        *,
        mode: str | None = None,
    ) -> SendReceipt:
        if self._closed or not self._owner_runtime.authoritative:
            raise MailboxClosedError(self.id)
        if sender.closed or not sender._owner_runtime.authoritative:
            raise MailboxClosedError(sender.id)
        if mode is not None and mode not in _DELIVERY_MODES:
            raise UnsupportedDeliveryModeError(f"unknown delivery mode {mode!r}")
        if mode is not None and not self._driver_managed:
            raise UnsupportedDeliveryModeError(
                f"mailbox {self.id!r} does not support RLM delivery modes"
            )
        # mode=None is ordinary FIFO for code mailboxes and steer for a driver;
        # there is no model driver in this package, so both are admitted locally.
        copied = self._validate_body(body)
        # Pydantic validation and serialization can run user code.  Recheck
        # liveness after it returns so a reentrant close cannot accept a ghost
        # message.
        if self._closed or not self._owner_runtime.authoritative:
            raise MailboxClosedError(self.id)
        if sender.closed or not sender._owner_runtime.authoritative:
            raise MailboxClosedError(sender.id)
        message = Message(
            id=uuid.uuid4().hex,
            sender=sender,
            body=copied,
        )
        accepted_at = _datetime.datetime.now(_datetime.timezone.utc).isoformat()
        if len(self._queue) >= self._config.capacity:
            raise MailboxFullError(self.id, self._config.capacity)
        # Admission is complete only after the message is in the bounded
        # queue.  A waiter is merely nudged; it never owns the message.
        self._queue.append(message)
        self._wake_one_waiter()
        return SendReceipt(message.id, self.id, accepted_at)

    def receive_nowait(self) -> Message[M]:
        self._validate_receive_owner()
        if self._queue:
            return self._queue.popleft()  # type: ignore[return-value]
        if self._closed:
            raise MailboxClosedError(self.id)
        raise asyncio.QueueEmpty

    def _remove_waiter(self, waiter: asyncio.Future[None]) -> bool:
        try:
            self._waiters.remove(waiter)
        except ValueError:
            return False
        return True

    def _wake_one_waiter(self) -> None:
        if not self._queue:
            return
        while self._waiters:
            waiter = self._waiters.popleft()
            if waiter.done():
                continue
            waiter.set_result(None)
            return

    async def receive(self, *, timeout: float | None = None) -> Message[M]:
        self._validate_receive_owner()
        if timeout is not None:
            if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
                raise ValueError("receive timeout must be a non-negative finite number")
            if not math.isfinite(timeout) or timeout < 0:
                raise ValueError("receive timeout must be a non-negative finite number")

        if self._queue:
            return self._queue.popleft()  # type: ignore[return-value]
        if self._closed:
            raise MailboxClosedError(self.id)
        if timeout == 0:
            raise TimeoutError

        async def wait_for_message() -> Message[M]:
            while True:
                if self._queue:
                    return self._queue.popleft()  # type: ignore[return-value]
                if self._closed:
                    raise MailboxClosedError(self.id)
                loop = asyncio.get_running_loop()
                waiter: asyncio.Future[None] = loop.create_future()
                self._waiters.append(waiter)
                try:
                    await waiter
                except asyncio.CancelledError:
                    self._remove_waiter(waiter)
                    # If this waiter had already been woken, its message is
                    # still queued.  Pass the wakeup to another reader.
                    self._wake_one_waiter()
                    raise

        if timeout is None:
            return await wait_for_message()
        try:
            return await asyncio.wait_for(wait_for_message(), timeout)
        except asyncio.TimeoutError:
            # wait_for cancels the inner receive.  Its waiter is removed, but
            # any concurrently admitted message remains in _queue.
            raise

    def __aiter__(self):
        return self

    async def __anext__(self) -> Message[M]:
        try:
            return await self.receive()
        except MailboxClosedError as exc:
            raise StopAsyncIteration from exc

    async def close(self) -> None:
        """Close admission while leaving queued messages available to drain."""
        self._validate_receive_owner()
        self._close_for_runtime(discard=False)
        self._owner_runtime._state.registry.remove(self)
        self._owner_runtime._owned_mailboxes.discard(self)

    def _close_for_runtime(self, *, discard: bool) -> None:
        if self._closed:
            if discard:
                self._queue.clear()
            return
        self._closed = True
        if discard:
            self._queue.clear()
        while self._waiters:
            waiter = self._waiters.popleft()
            if waiter.done():
                continue
            # Wake the receiver to re-check queue/closed state.  Using a
            # normal result avoids an unobserved Future exception if a close
            # races cancellation before the receiver resumes.
            waiter.set_result(None)


class _MailboxRegistry:
    """A registry shared by all local runtimes in one task tree."""

    def __init__(self) -> None:
        self._mailboxes: dict[str, Mailbox[Any]] = {}

    def add(self, mailbox: Mailbox[Any]) -> None:
        self._mailboxes[mailbox.id] = mailbox

    def get_live(self, mailbox_id: str) -> Mailbox[Any]:
        mailbox = self._mailboxes.get(mailbox_id)
        if mailbox is None or mailbox.closed:
            raise MailboxNotFoundError(mailbox_id)
        return mailbox

    def remove(self, mailbox: Mailbox[Any]) -> None:
        # IDs are never reused, but identity checking keeps this safe if a
        # future registry implementation ever permits replacement.
        if self._mailboxes.get(mailbox.id) is mailbox:
            self._mailboxes.pop(mailbox.id, None)

    def live(self) -> list[MailboxRef]:
        return [mailbox for mailbox in self._mailboxes.values() if not mailbox.closed]


class Mailboxes:
    """Mailbox registration and lookup for one owning runtime tree."""

    def __init__(self, runtime: Runtime, registry: _MailboxRegistry) -> None:
        self._runtime = runtime
        self._registry = registry

    async def create(self, *, config: MailboxConfig | None = None) -> Mailbox[Any]:
        return self._create(config or MailboxConfig(), driver_managed=False)

    def _create(self, config: MailboxConfig, *, driver_managed: bool) -> Mailbox[Any]:
        if not self._runtime.authoritative:
            raise MailboxClosedError(self._runtime.mailbox.id)
        mailbox = Mailbox(
            uuid.uuid4().hex,
            self._runtime.agent_id,
            self._runtime,
            config,
            driver_managed=driver_managed,
        )
        self._registry.add(mailbox)
        self._runtime._owned_mailboxes.add(mailbox)
        return mailbox

    async def get(self, address: str) -> MailboxRef:
        return self._registry.get_live(address)

    async def list(self) -> list[MailboxRef]:
        return self._registry.live()
