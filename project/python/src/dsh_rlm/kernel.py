"""A small local, checkpointed Python kernel for RLM sessions."""

from __future__ import annotations

import asyncio
import errno
import fcntl
import json
import math
import multiprocessing
import os
import pickle
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

from .checkpoint import CheckpointReport, CheckpointStore, RestoreReport, ValueIssue
from .recovery import RecoveryReport
from .repl import CellResult, PersistentREPL
from .runtime import Runtime

_RUN_STATE_NAME = "dirty-run"
_SESSION_LOCK_NAME = "session.lock"


def _atomic_write(path: Path, payload: bytes) -> None:
    """Publish a complete run-state file, never a partial JSON document."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    temporary_path = Path(temporary)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY)
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


def _safe_text(error: BaseException) -> str:
    try:
        detail = str(error)
    except Exception:
        detail = "unable to describe error"
    return f"{type(error).__name__}: {detail[:200]}" if detail else type(error).__name__


def _checkpoint_worker(
    store: CheckpointStore,
    namespace: dict[str, Any],
    report_path: str,
) -> None:
    try:
        report = store.save(namespace)
    except BaseException as error:
        report = CheckpointReport(error=_safe_text(error))
    try:
        with open(report_path, "wb") as stream:
            pickle.dump(report, stream)
    except BaseException:
        # The parent treats a missing report as a worker failure.
        pass


class LocalKernel:
    """One RLM runtime and one persistent REPL with best-effort recovery.

    Only completed values are recovered.  Tasks, mailboxes, handles, and
    external actions from a prior process are never replayed or revived.
    """

    def __init__(
        self,
        session_dir: str | os.PathLike[str],
        *,
        checkpoint_path: str | os.PathLike[str] | None = None,
        max_output_chars: int = 65_536,
        checkpoint_timeout: float = 10.0,
        initial_globals: Mapping[str, Any] | None = None,
    ) -> None:
        self.session_dir = Path(session_dir)
        self.session_dir.mkdir(parents=True, exist_ok=True)
        if (
            isinstance(checkpoint_timeout, bool)
            or not isinstance(checkpoint_timeout, (int, float))
            or not math.isfinite(checkpoint_timeout)
            or checkpoint_timeout <= 0
        ):
            raise ValueError("checkpoint_timeout must be a finite positive number")
        self.checkpoint_timeout = float(checkpoint_timeout)
        self.checkpoint_path = (
            Path(checkpoint_path)
            if checkpoint_path is not None
            else self.session_dir / "checkpoint"
        )
        self.dirty_marker_path = self.session_dir / _RUN_STATE_NAME

        self.checkpoint_store = CheckpointStore(self.checkpoint_path)
        self.runtime = Runtime(rlm=True)
        seeded_globals = dict(initial_globals or {})
        seeded_globals["runtime"] = self.runtime
        self.repl = PersistentREPL(seeded_globals, max_output_chars=max_output_chars)

        self._closed = False
        self._operation_lock: asyncio.Lock | None = None
        self._close_lock: asyncio.Lock | None = None
        self._active_execution: asyncio.Task[Any] | None = None
        self._latest_cell_ok: bool | None = None
        self._session_lock_fd: int | None = None
        self._notice_taken = False
        self._run_id = uuid.uuid4().hex
        self._started_at = datetime.now(timezone.utc).isoformat()
        self.last_checkpoint: CheckpointReport | None = None
        self._checkpoint_id: str | None = None
        self._checkpoint_created_at: str | None = None
        self._checkpoint_error: str | None = None
        self.recovery_report: RecoveryReport | None
        self.recovery_notice: str | None

        self._acquire_session_lock()
        try:
            prior_state, prior_state_corrupt = self._read_run_state()
            prior_marker_exists = self.dirty_marker_path.exists()
            prior_interrupted = bool(
                prior_state is not None and prior_state.get("state") == "interrupted"
            )
            prior_dirty = prior_marker_exists and (
                prior_state_corrupt
                or prior_state is None
                or prior_state.get("state") != "clean"
            )
            self._write_dirty_state()

            try:
                restore_report = self.checkpoint_store.restore(self.repl.globals)
            except BaseException as error:  # defensive for alternate store adapters
                restore_report = RestoreReport(
                    failed=(
                        ValueIssue(
                            "<checkpoint>", f"restore failed: {_safe_text(error)}"
                        ),
                    ),
                    reason="restore failed",
                )
            self.restore_report = restore_report
            self._checkpoint_id = restore_report.checkpoint_id
            self._checkpoint_created_at = restore_report.created_at
            # Never retain a runtime, mailbox, or handle from a trusted snapshot.
            self.repl.globals["runtime"] = self.runtime

            expected_checkpoint_id = (
                prior_state.get("expected_checkpoint_id")
                if prior_state is not None
                else None
            )
            checkpoint_mismatch = bool(
                isinstance(expected_checkpoint_id, str)
                and restore_report.checkpoint_id != expected_checkpoint_id
            )
            if checkpoint_mismatch:
                prior_dirty = True
            prior_checkpoint_error = None
            final_save_error = None
            prior_cause = None
            if prior_state is not None:
                raw_checkpoint_error = prior_state.get("checkpoint_error")
                if isinstance(raw_checkpoint_error, str) and raw_checkpoint_error:
                    prior_checkpoint_error = raw_checkpoint_error
                raw_final_error = prior_state.get("final_save_error")
                if isinstance(raw_final_error, str) and raw_final_error:
                    final_save_error = raw_final_error
                raw_cause = prior_state.get("cause")
                if isinstance(raw_cause, str) and raw_cause:
                    prior_cause = raw_cause
            if checkpoint_mismatch:
                prior_cause = (
                    "the expected checkpoint was missing, corrupt, or replaced"
                )
            elif prior_interrupted and prior_cause is None:
                prior_cause = "work was still active during shutdown"
            elif prior_dirty and prior_cause is None:
                prior_cause = "unknown"

            checkpoint_exists = self.checkpoint_path.exists()
            has_prior_state = prior_marker_exists
            if has_prior_state or checkpoint_exists:
                self.recovery_report = RecoveryReport(
                    interrupted=prior_dirty,
                    cause=prior_cause,
                    checkpoint_id=restore_report.checkpoint_id,
                    created_at=restore_report.created_at,
                    restored=tuple(sorted(restore_report.restored)),
                    skipped=tuple(
                        sorted(restore_report.skipped, key=lambda issue: issue.name)
                    ),
                    failed=tuple(
                        sorted(restore_report.failed, key=lambda issue: issue.name)
                    ),
                    reason=restore_report.reason,
                    final_save_error=final_save_error,
                    checkpoint_error=prior_checkpoint_error,
                )
                self.recovery_notice = self.recovery_report.render_notice()
            else:
                self.recovery_report = None
                self.recovery_notice = None
            self.runtime.recovery = self.recovery_report
        except BaseException:
            self._release_session_lock()
            raise

    @classmethod
    async def open(
        cls, session_dir: str | os.PathLike[str], **kwargs: Any
    ) -> "LocalKernel":
        """Construct and enter a kernel."""
        kernel = await asyncio.to_thread(cls, session_dir, **kwargs)
        await kernel.__aenter__()
        return kernel

    @property
    def closed(self) -> bool:
        return self._closed

    def _get_operation_lock(self) -> asyncio.Lock:
        if self._operation_lock is None:
            self._operation_lock = asyncio.Lock()
        return self._operation_lock

    def _get_close_lock(self) -> asyncio.Lock:
        if self._close_lock is None:
            self._close_lock = asyncio.Lock()
        return self._close_lock

    def _acquire_session_lock(self) -> None:
        lock_path = self.session_dir / _SESSION_LOCK_NAME
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            os.close(descriptor)
            if error.errno in {errno.EACCES, errno.EAGAIN}:
                raise RuntimeError(
                    f"session is already open: {self.session_dir}"
                ) from error
            raise
        self._session_lock_fd = descriptor

    def _release_session_lock(self) -> None:
        descriptor = self._session_lock_fd
        if descriptor is None:
            return
        self._session_lock_fd = None
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)

    async def __aenter__(self) -> "LocalKernel":
        async with self._get_operation_lock():
            if self._closed:
                raise RuntimeError("LocalKernel is closed")
            return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.close()

    def _read_run_state(self) -> tuple[dict[str, Any] | None, bool]:
        if not self.dirty_marker_path.exists():
            return None, False
        try:
            with self.dirty_marker_path.open("rb") as stream:
                state = json.load(stream)
            if not isinstance(state, dict) or state.get("state") not in {
                "dirty",
                "clean",
                "interrupted",
            }:
                return None, True
            return state, False
        except Exception:
            return None, True

    def _write_dirty_state(self, checkpoint_error: str | None = None) -> None:
        state: dict[str, Any] = {
            "state": "dirty",
            "run_id": self._run_id,
            "started_at": self._started_at,
            "pid": os.getpid(),
            "checkpoint_error": checkpoint_error,
        }
        if self._checkpoint_id is not None:
            state["expected_checkpoint_id"] = self._checkpoint_id
        _atomic_write(
            self.dirty_marker_path,
            (json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n").encode(),
        )

    def _write_end_state(
        self,
        final_save_error: str | None,
        *,
        interrupted: bool,
        cause: str | None,
        checkpoint_error: str | None,
    ) -> None:
        state: dict[str, Any] = {
            "state": "interrupted" if interrupted else "clean",
            "run_id": self._run_id,
            "closed_at": datetime.now(timezone.utc).isoformat(),
            "final_save_error": final_save_error,
            "checkpoint_error": checkpoint_error,
        }
        if cause:
            state["cause"] = cause
        if self._checkpoint_id is not None:
            state["expected_checkpoint_id"] = self._checkpoint_id
            state["expected_checkpoint_created_at"] = self._checkpoint_created_at
        _atomic_write(
            self.dirty_marker_path,
            (json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n").encode(),
        )

    async def _save_checkpoint(self) -> CheckpointReport:
        """Serialize in a killable fork worker so user hooks cannot stall the loop."""
        context = multiprocessing.get_context("fork")
        descriptor, report_name = tempfile.mkstemp(
            prefix=".checkpoint-report.", suffix=".pickle", dir=self.session_dir
        )
        os.close(descriptor)
        os.unlink(report_name)
        process = context.Process(
            target=_checkpoint_worker,
            args=(self.checkpoint_store, dict(self.repl.globals), report_name),
            daemon=True,
        )
        process.start()
        join_task = asyncio.create_task(asyncio.to_thread(process.join))
        try:
            await asyncio.wait_for(asyncio.shield(join_task), self.checkpoint_timeout)
        except TimeoutError:
            if process.is_alive():
                process.terminate()
            await join_task
            return CheckpointReport(
                error=f"checkpoint worker exceeded {self.checkpoint_timeout:g} seconds"
            )
        except asyncio.CancelledError:
            if process.is_alive():
                process.terminate()
            await asyncio.shield(join_task)
            raise
        finally:
            if process.is_alive():
                process.terminate()
                await asyncio.shield(asyncio.to_thread(process.join))

        try:
            with open(report_name, "rb") as stream:
                report = pickle.load(stream)
        except BaseException as error:
            return CheckpointReport(
                error=f"checkpoint worker failed: {_safe_text(error)}"
            )
        finally:
            try:
                os.unlink(report_name)
            except FileNotFoundError:
                pass
        if not isinstance(report, CheckpointReport):
            return CheckpointReport(
                error="checkpoint worker returned an invalid report"
            )
        return report

    async def execute(
        self,
        source: str,
        *,
        callback_parent_id: str | None = None,
        host_callback: Callable[[str, str, dict[str, Any]], Awaitable[Any]]
        | None = None,
    ) -> CellResult:
        """Execute one cell and checkpoint it only when it succeeds.

        Host callbacks are enabled only while the REPL is evaluating the cell.
        The bridge supplies both callback arguments together for an opted-in
        execute request; ordinary local kernels remain unsupported.
        """
        if (callback_parent_id is None) != (host_callback is None):
            raise ValueError(
                "callback_parent_id and host_callback must be supplied together"
            )
        async with self._get_operation_lock():
            if self._closed:
                raise RuntimeError("LocalKernel is closed")
            current = asyncio.current_task()
            if current is None:  # pragma: no cover - execute always needs a loop
                raise RuntimeError("LocalKernel.execute requires an asyncio task")
            self._active_execution = current
            self._latest_cell_ok = False
            try:
                async with self.runtime.bind():
                    if host_callback is None or callback_parent_id is None:
                        result = await self.repl.execute(source)
                    else:
                        async with self.runtime._bind_host_callbacks(
                            callback_parent_id, host_callback
                        ):
                            result = await self.repl.execute(source)
                if self._closed:
                    return result
                self._latest_cell_ok = result.ok
                if result.ok:
                    self.repl.globals["runtime"] = self.runtime
                    try:
                        report = await self._save_checkpoint()
                    except BaseException as error:
                        report = CheckpointReport(error=_safe_text(error))
                    self.last_checkpoint = report
                    if report.ok:
                        self._checkpoint_id = report.checkpoint_id
                        self._checkpoint_created_at = report.created_at
                        self._checkpoint_error = None
                    else:
                        self._checkpoint_error = report.error
                    # Persist a failed checkpoint attempt before returning the
                    # successful cell, so abrupt recovery cannot hide it.
                    self._write_dirty_state(self._checkpoint_error)
                return result
            finally:
                if self._active_execution is current:
                    self._active_execution = None

    def take_recovery_notice(self) -> str | None:
        """Return recovery context once, including a deliberate ``None``."""
        if self._notice_taken:
            return None
        self._notice_taken = True
        return self.recovery_notice

    async def close(self, *, interruption_cause: str | None = None) -> None:
        """Stop owned work without waiting behind an unbounded user cell.

        ``interruption_cause`` records a transport-forced shutdown even if the
        active cell finishes at the same time cancellation is requested.
        """
        async with self._get_close_lock():
            if self._closed:
                return
            self._closed = True
            active = self._active_execution
            active_interrupted = active is not None and not active.done()
            if active_interrupted and active is not asyncio.current_task():
                active.cancel()

            raw_tasks = self.repl.pending_background_tasks()
            raw_tasks_interrupted = bool(raw_tasks)
            for task in raw_tasks:
                task.cancel()
            runtime_tasks_interrupted = any(
                child._handle is not None and not child._handle.task.done()
                for child in tuple(self.runtime._children)
            )

            final_save_error: str | None = None
            marker_error: BaseException | None = None
            runtime_error: BaseException | None = None
            try:
                if not active_interrupted and self._latest_cell_ok is True:
                    self.repl.globals["runtime"] = self.runtime
                    try:
                        report = await self._save_checkpoint()
                    except BaseException as error:
                        report = CheckpointReport(error=_safe_text(error))
                    self.last_checkpoint = report
                    if report.ok:
                        self._checkpoint_id = report.checkpoint_id
                        self._checkpoint_created_at = report.created_at
                        self._checkpoint_error = None
                    else:
                        final_save_error = report.error

                try:
                    await self.runtime.close()
                    # Give raw task cancellation one cooperative turn too.
                    await asyncio.sleep(0)
                except BaseException as error:
                    runtime_error = error

                surviving_raw = any(not task.done() for task in raw_tasks)
                surviving_runtime = any(
                    child._handle is not None and not child._handle.task.done()
                    for child in tuple(self.runtime._children)
                )
                interrupted = (
                    interruption_cause is not None
                    or active_interrupted
                    or raw_tasks_interrupted
                    or runtime_tasks_interrupted
                    or surviving_raw
                    or surviving_runtime
                )
                causes: list[str] = []
                if interruption_cause is not None:
                    causes.append(interruption_cause)
                if active_interrupted:
                    causes.append("a cell execution was interrupted")
                if raw_tasks_interrupted or runtime_tasks_interrupted:
                    causes.append("background tasks were interrupted")
                if surviving_raw or surviving_runtime:
                    causes.append("some tasks did not stop after cancellation")
                cause = "; ".join(causes) or None

                if runtime_error is None:
                    try:
                        self._write_end_state(
                            final_save_error,
                            interrupted=interrupted,
                            cause=cause,
                            checkpoint_error=self._checkpoint_error,
                        )
                    except BaseException as error:
                        marker_error = error
            finally:
                self._release_session_lock()

            if marker_error is not None:
                raise marker_error
            if runtime_error is not None:
                raise runtime_error


__all__ = ["LocalKernel"]
