"""Bounded JSON-lines subprocess bridge for :class:`dsh_rlm.LocalKernel`.

The bridge owns one kernel and one lifetime stdin router. Standard output is
reserved for serialized protocol messages. Cell output is returned in its
``cell`` result instead of being mixed with the JSON stream.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Callable, TextIO

from .checkpoint import CheckpointReport, ValueIssue
from .kernel import LocalKernel
from .repl import CellResult

MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_SOURCE_BYTES = 1024 * 1024
MAX_CALLBACK_BYTES = 1024 * 1024
MAX_ID_CHARS = 1024
MAX_CALLBACKS_PER_EXECUTE = 64
MAX_CALLBACKS_INFLIGHT = 32
MAX_PENDING_REQUESTS = 1024
_MAX_CAPABILITIES = 64
_MAX_CHECKPOINT_ITEMS = 128
_MAX_CHECKPOINT_TEXT_CHARS = 512
_MAX_PROTOCOL_TEXT_CHARS = 65_536
_CALLBACK_CAPABILITY = "host-callback-v1"
_CALLBACK_METHODS = frozenset(("tools.list", "tools.call", "models.complete"))
_EOF = object()
_MAX_SAFE_INTEGER = (1 << 53) - 1
_FORCED_EXIT_CODE = 70
_FORCED_EXIT_GRACE_SECONDS = 1.0


class ProtocolError(Exception):
    """A request that is invalid without being fatal to the bridge."""

    def __init__(self, code: str, message: str, *, request_id: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.request_id = request_id


class HostCallbackError(Exception):
    """A bounded error returned by the callback host or its transport."""

    def __init__(self, code: str, message: str):
        self.code = _truncate(code, 200)
        self.message = _truncate(message, 2_048)
        super().__init__(f"{self.code}: {self.message}")


@dataclass(frozen=True, slots=True)
class _Request:
    id: str
    method: str
    source: str | None = None
    capabilities: frozenset[str] = frozenset()


@dataclass(frozen=True, slots=True)
class _Inbound:
    line: bytes
    oversized: bool = False


def _truncate(text: str, limit: int = _MAX_PROTOCOL_TEXT_CHARS) -> str:
    if len(text) <= limit:
        return text
    marker = "... [truncated]"
    return text[: limit - len(marker)] + marker


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number: {value}")


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def _decode_json(line: bytes) -> Any:
    try:
        text = line.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ProtocolError(
            "INVALID_ENCODING", "request must be valid UTF-8"
        ) from error
    try:
        return json.loads(
            text,
            parse_constant=_reject_constant,
            object_pairs_hook=_strict_object,
        )
    except (json.JSONDecodeError, RecursionError, ValueError) as error:
        raise ProtocolError(
            "INVALID_JSON", "request must be one JSON object"
        ) from error


def _error_message(result: CellResult) -> str | None:
    """Extract a useful message without calling user exception methods."""
    if result.error is None or not result.traceback:
        return None
    lines = result.traceback.rstrip().splitlines()
    if not lines:
        return None
    final = lines[-1]
    prefix = f"{type(result.error).__name__}:"
    if final.startswith(prefix):
        final = final[len(prefix) :].lstrip()
    return final or None


def _cell_summary(result: CellResult) -> dict[str, Any]:
    return {
        "ok": result.ok,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "display": result.display,
        "error_type": type(result.error).__name__ if result.error is not None else None,
        "error_message": _error_message(result),
        "traceback": result.traceback,
    }


def _issue_summary(issue: ValueIssue) -> dict[str, str]:
    return {
        "name": _truncate(issue.name, _MAX_CHECKPOINT_TEXT_CHARS),
        "reason": _truncate(issue.reason, _MAX_CHECKPOINT_TEXT_CHARS),
    }


def _checkpoint_summary(report: CheckpointReport | None) -> dict[str, Any] | None:
    if report is None:
        return None
    saved = [
        _truncate(name, _MAX_CHECKPOINT_TEXT_CHARS)
        for name in report.saved[:_MAX_CHECKPOINT_ITEMS]
    ]
    if len(report.saved) > len(saved):
        saved.append(f"... ({len(report.saved) - len(saved)} omitted)")
    skipped = [
        _issue_summary(issue) for issue in report.skipped[:_MAX_CHECKPOINT_ITEMS]
    ]
    if len(report.skipped) > len(skipped):
        skipped.append(
            {"name": "...", "reason": f"{len(report.skipped) - len(skipped)} omitted"}
        )
    return {
        "ok": report.ok,
        "checkpoint_id": report.checkpoint_id,
        "created_at": report.created_at,
        "byte_count": report.byte_count,
        "saved": saved,
        "skipped": skipped,
        "error": (
            _truncate(report.error, _MAX_CHECKPOINT_TEXT_CHARS)
            if report.error is not None
            else None
        ),
    }


def _failure(
    code: str, message: str, *, request_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": request_id,
        "ok": False,
        "error": {"code": code, "message": _truncate(message)},
    }


def _parse_capabilities(value: Any, request_id: str) -> frozenset[str]:
    if not isinstance(value, list):
        raise ProtocolError(
            "INVALID_REQUEST",
            "execute capabilities must be a list of strings",
            request_id=request_id,
        )
    if len(value) > _MAX_CAPABILITIES:
        raise ProtocolError(
            "INVALID_REQUEST", "too many execute capabilities", request_id=request_id
        )
    capabilities: set[str] = set()
    for capability in value:
        if not isinstance(capability, str) or not capability:
            raise ProtocolError(
                "INVALID_REQUEST",
                "execute capabilities must be non-empty strings",
                request_id=request_id,
            )
        if len(capability) > 256:
            raise ProtocolError(
                "INVALID_REQUEST",
                "execute capability is too long",
                request_id=request_id,
            )
        capabilities.add(capability)
    return frozenset(capabilities)


def _parse_request(line: bytes) -> _Request:
    value = _decode_json(line)
    if not isinstance(value, dict):
        raise ProtocolError("INVALID_REQUEST", "request must be a JSON object")

    raw_id = value.get("id")
    request_id = raw_id if isinstance(raw_id, str) else None
    if not isinstance(raw_id, str) or not raw_id:
        raise ProtocolError(
            "INVALID_REQUEST", "id must be a non-empty string", request_id=request_id
        )
    if len(raw_id) > MAX_ID_CHARS:
        raise ProtocolError("INVALID_REQUEST", "id is too long", request_id=request_id)

    method = value.get("method")
    if not isinstance(method, str):
        raise ProtocolError(
            "INVALID_REQUEST", "method must be a string", request_id=raw_id
        )
    if method == "close":
        return _Request(raw_id, method)
    if method != "execute":
        raise ProtocolError(
            "METHOD_NOT_FOUND",
            f"unknown method: {_truncate(method, 200)}",
            request_id=raw_id,
        )

    source = value.get("source")
    if not isinstance(source, str):
        raise ProtocolError(
            "INVALID_REQUEST", "execute source must be a string", request_id=raw_id
        )
    try:
        source_bytes = source.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ProtocolError(
            "INVALID_ENCODING", "source must be valid UTF-8", request_id=raw_id
        ) from error
    if len(source_bytes) > MAX_SOURCE_BYTES:
        raise ProtocolError(
            "SOURCE_TOO_LARGE",
            f"source exceeds {MAX_SOURCE_BYTES} UTF-8 bytes",
            request_id=raw_id,
        )
    capabilities = (
        _parse_capabilities(value["capabilities"], raw_id)
        if "capabilities" in value
        else frozenset()
    )
    return _Request(raw_id, method, source, capabilities)


async def _read_line(stream: BinaryIO) -> tuple[bytes, bool]:
    """Read one bounded line and consume an oversized line's remainder."""
    line = await asyncio.to_thread(stream.readline, MAX_REQUEST_BYTES + 1)
    if not line:
        return b"", False
    oversized = len(line) > MAX_REQUEST_BYTES
    if line.endswith(b"\n"):
        return line, oversized
    if len(line) == MAX_REQUEST_BYTES + 1:
        oversized = True
        while True:
            remainder = await asyncio.to_thread(stream.readline, MAX_REQUEST_BYTES + 1)
            if not remainder or remainder.endswith(b"\n"):
                break
    return line, oversized


def _validate_json(value: Any, ancestors: set[int] | None = None) -> None:
    """Reject values that JSON would coerce or JavaScript would misread."""
    if value is None or type(value) in {bool, str}:
        return
    if type(value) is int:
        if not -_MAX_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER:
            raise ValueError("JSON integer is outside the safe integer range")
        return
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError("JSON number must be finite")
        return
    if type(value) not in {list, dict}:
        raise TypeError(f"unsupported JSON value: {type(value).__name__}")

    if ancestors is None:
        ancestors = set()
    identity = id(value)
    if identity in ancestors:
        raise ValueError("circular JSON value")
    ancestors.add(identity)
    try:
        if type(value) is list:
            for item in value:
                _validate_json(item, ancestors)
        else:
            for key, item in value.items():
                if type(key) is not str:
                    raise TypeError("JSON object keys must be strings")
                _validate_json(item, ancestors)
    finally:
        ancestors.remove(identity)


def _encode_message(message: dict[str, Any]) -> str:
    _validate_json(message)
    return json.dumps(
        message,
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
    )


def _write_response(stream: TextIO, response: dict[str, Any]) -> None:
    """Compatibility helper for tests and non-concurrent callers."""
    stream.write(_encode_message(response) + "\n")
    stream.flush()


class _ProtocolConnection:
    """Own the sole reader, writer, and callback correlation table."""

    def __init__(self, input_stream: BinaryIO, output_stream: TextIO) -> None:
        self.input_stream = input_stream
        self.output_stream = output_stream
        self.requests: asyncio.Queue[_Inbound] = asyncio.Queue(
            maxsize=MAX_PENDING_REQUESTS
        )
        self.pending: dict[str, asyncio.Future[Any]] = {}
        self.closed = asyncio.Event()
        self.input_eof = asyncio.Event()
        self.reader_done = asyncio.Event()
        self.fatal_error: HostCallbackError | None = None
        self._accepted_close = False
        self._cancelled_ids: set[str] = set()
        self._cancelled_order: list[str] = []
        self._write_lock = asyncio.Lock()
        self._reader_task: asyncio.Task[None] | None = None
        self._pipe_reader: asyncio.StreamReader | None = None
        self._pipe_transport: asyncio.Transport | None = None
        self._pipe_buffer = bytearray()
        self._pipe_oversized = False
        self._use_thread_reader = False

    def start(self) -> None:
        self._reader_task = asyncio.create_task(self._read_forever())

    async def write(self, message: dict[str, Any], *, limit: int | None = None) -> None:
        try:
            payload = _encode_message(message)
        except (TypeError, ValueError, RecursionError) as error:
            raise HostCallbackError(
                "INVALID_CALLBACK_PAYLOAD", "callback payload is not strict JSON"
            ) from error
        if limit is not None and len(payload.encode("utf-8")) > limit:
            raise HostCallbackError(
                "CALLBACK_PAYLOAD_TOO_LARGE",
                f"callback payload exceeds {limit} UTF-8 bytes",
            )
        async with self._write_lock:
            self.output_stream.write(payload + "\n")
            self.output_stream.flush()

    def _fail_all(self, error: HostCallbackError) -> None:
        pending = tuple(self.pending.values())
        self.pending.clear()
        for future in pending:
            if not future.done():
                future.set_exception(error)

    def _remember_cancelled(self, callback_id: str) -> None:
        self._cancelled_ids.add(callback_id)
        self._cancelled_order.append(callback_id)
        if len(self._cancelled_order) > 256:
            expired = self._cancelled_order.pop(0)
            self._cancelled_ids.discard(expired)

    def cancel(self, callback_ids: set[str]) -> None:
        for callback_id in tuple(callback_ids):
            future = self.pending.pop(callback_id, None)
            if future is not None:
                self._remember_cancelled(callback_id)
            if future is not None and not future.done():
                future.set_exception(
                    HostCallbackError(
                        "CALLBACK_CELL_ENDED", "execute cell ended before callback"
                    )
                )

    def _poison(self, code: str, message: str) -> None:
        # Keep the first transport failure as the durable interruption cause.
        if self.fatal_error is None:
            self.fatal_error = HostCallbackError(code, message)
        self.closed.set()

    def _queue_request(self, inbound: _Inbound) -> bool:
        try:
            self.requests.put_nowait(inbound)
        except asyncio.QueueFull:
            self._poison(
                "REQUEST_QUEUE_OVERFLOW",
                f"more than {MAX_PENDING_REQUESTS} requests were pending",
            )
            return False
        return True

    def _accept_callback_result(self, value: dict[str, Any]) -> bool:
        raw_id = value.get("id")
        callback_id = raw_id if type(raw_id) is str else None
        if callback_id is None or not callback_id or len(callback_id) > MAX_ID_CHARS:
            self._poison("INVALID_CALLBACK_RESULT", "invalid callback result id")
            return False

        ok = value.get("ok")
        if type(ok) is not bool:
            self._poison("INVALID_CALLBACK_RESULT", "ok must be a boolean")
            return False
        expected = {"kind", "id", "ok", "result" if ok else "error"}
        if set(value) != expected:
            self._poison(
                "INVALID_CALLBACK_RESULT",
                "callback result contains missing or unknown fields",
            )
            return False
        if not ok:
            error = value["error"]
            if not isinstance(error, dict) or set(error) != {"code", "message"}:
                self._poison(
                    "INVALID_CALLBACK_RESULT",
                    "callback error must contain exactly code and message",
                )
                return False
            if type(error["code"]) is not str or type(error["message"]) is not str:
                self._poison(
                    "INVALID_CALLBACK_RESULT",
                    "error code and message must be strings",
                )
                return False

        future = self.pending.pop(callback_id, None)
        if future is None:
            if callback_id in self._cancelled_ids:
                self._cancelled_ids.discard(callback_id)
                return True
            self._poison("UNKNOWN_CALLBACK_RESULT", "unknown callback result id")
            return False
        if ok:
            future.set_result(value["result"])
        else:
            error = value["error"]
            future.set_exception(HostCallbackError(error["code"], error["message"]))
        return True

    async def _initialize_reader(self) -> None:
        try:
            self.input_stream.fileno()
        except (AttributeError, OSError):
            self._use_thread_reader = True
            return
        reader = asyncio.StreamReader(limit=MAX_REQUEST_BYTES + 1)
        protocol = asyncio.StreamReaderProtocol(reader)
        loop = asyncio.get_running_loop()
        try:
            transport, _ = await loop.connect_read_pipe(
                lambda: protocol, self.input_stream
            )
        except (AttributeError, OSError, ValueError):
            self._use_thread_reader = True
            return
        self._pipe_reader = reader
        self._pipe_transport = transport

    async def _next_line(self) -> tuple[bytes, bool]:
        if self._use_thread_reader:
            return await _read_line(self.input_stream)
        reader = self._pipe_reader
        assert reader is not None
        while True:
            newline = self._pipe_buffer.find(b"\n")
            if newline >= 0:
                if self._pipe_oversized:
                    del self._pipe_buffer[: newline + 1]
                    self._pipe_oversized = False
                    return b"", True
                line = bytes(self._pipe_buffer[: newline + 1])
                del self._pipe_buffer[: newline + 1]
                return line, len(line) > MAX_REQUEST_BYTES
            if len(self._pipe_buffer) > MAX_REQUEST_BYTES:
                self._pipe_buffer.clear()
                self._pipe_oversized = True
            chunk = await reader.read(65_536)
            if chunk:
                self._pipe_buffer.extend(chunk)
                continue
            if self._pipe_oversized:
                self._pipe_buffer.clear()
                self._pipe_oversized = False
                return b"", True
            if self._pipe_buffer:
                line = bytes(self._pipe_buffer)
                self._pipe_buffer.clear()
                return line, len(line) > MAX_REQUEST_BYTES
            return b"", False

    async def _read_forever(self) -> None:
        try:
            await self._initialize_reader()
            while True:
                line, oversized = await self._next_line()
                if not line and not oversized:
                    self.input_eof.set()
                    if self.pending:
                        self._poison(
                            "CALLBACK_TRANSPORT_CLOSED",
                            "bridge input reached EOF while a callback was pending",
                        )
                    return
                if oversized:
                    if self.pending:
                        self._poison(
                            "CALLBACK_RESULT_TOO_LARGE",
                            f"callback result exceeds {MAX_REQUEST_BYTES} bytes",
                        )
                        return
                    if not self._queue_request(_Inbound(line, True)):
                        return
                    continue
                try:
                    value = _decode_json(line)
                except ProtocolError:
                    if self.pending:
                        self._poison(
                            "INVALID_CALLBACK_RESULT",
                            "host sent invalid JSON while callback was pending",
                        )
                        return
                    if not self._queue_request(_Inbound(line)):
                        return
                    continue
                if isinstance(value, dict) and value.get("kind") == "callback_result":
                    payload_size = len(line[:-1] if line.endswith(b"\n") else line)
                    if payload_size > MAX_CALLBACK_BYTES:
                        self._poison(
                            "CALLBACK_RESULT_TOO_LARGE",
                            f"callback result exceeds {MAX_CALLBACK_BYTES} UTF-8 bytes",
                        )
                        return
                    if not self._accept_callback_result(value):
                        return
                    continue
                if not self._queue_request(_Inbound(line)):
                    return
        except asyncio.CancelledError:
            if not self._accepted_close:
                raise
        except BaseException as error:
            self._poison(
                "CALLBACK_TRANSPORT_ERROR",
                f"{type(error).__name__}: bridge input failed",
            )
        finally:
            if self._accepted_close:
                self._fail_all(
                    HostCallbackError(
                        "CALLBACK_TRANSPORT_CLOSED", "bridge input closed"
                    )
                )
            self.reader_done.set()

    async def next_inbound(self) -> _Inbound | object:
        """Return ordered input, but surface poison ahead of queued requests."""
        while True:
            if self.fatal_error is not None:
                return _EOF
            try:
                return self.requests.get_nowait()
            except asyncio.QueueEmpty:
                pass
            if self.reader_done.is_set():
                return _EOF

            request_wait = asyncio.create_task(self.requests.get())
            reader_wait = asyncio.create_task(self.reader_done.wait())
            poison_wait = asyncio.create_task(self.closed.wait())
            done, pending = await asyncio.wait(
                (request_wait, reader_wait, poison_wait),
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            if self.fatal_error is not None:
                return _EOF
            if request_wait in done:
                return request_wait.result()

    def accept_close(self) -> None:
        """Stop reading only after serve has validated the close request."""
        self._accepted_close = True
        transport = self._pipe_transport
        if transport is not None:
            transport.close()
        task = self._reader_task
        if task is not None and not task.done():
            task.cancel()

    async def finish(self) -> None:
        task = self._reader_task
        if task is None:
            return
        if not task.done():
            task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


class _CellCallbacks:
    """One revocable execute-cell callback lease."""

    def __init__(self, connection: _ProtocolConnection, parent_id: str) -> None:
        self.connection = connection
        self.parent_id = parent_id
        self.active = True
        self.total = 0
        self.callback_ids: set[str] = set()

    async def __call__(
        self, parent_id: str, method: str, params: dict[str, Any]
    ) -> Any:
        if not self.active or parent_id != self.parent_id:
            raise HostCallbackError("CALLBACK_CELL_ENDED", "execute cell is not active")
        if self.connection.input_eof.is_set():
            self.connection._poison(
                "CALLBACK_TRANSPORT_CLOSED",
                "host callback was attempted after bridge input reached EOF",
            )
            raise self.connection.fatal_error or HostCallbackError(
                "CALLBACK_TRANSPORT_CLOSED", "bridge input reached EOF"
            )
        if method not in _CALLBACK_METHODS:
            raise HostCallbackError(
                "CALLBACK_METHOD_DENIED", "callback method is denied"
            )
        if self.total >= MAX_CALLBACKS_PER_EXECUTE:
            raise HostCallbackError(
                "CALLBACK_LIMIT", "execute callback count limit exceeded"
            )
        if len(self.connection.pending) >= MAX_CALLBACKS_INFLIGHT:
            raise HostCallbackError(
                "CALLBACK_INFLIGHT_LIMIT", "callback inflight limit exceeded"
            )
        self.total += 1
        callback_id = "cb-" + uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        self.connection.pending[callback_id] = future
        self.callback_ids.add(callback_id)
        frame = {
            "kind": "callback",
            "id": callback_id,
            "parent_id": parent_id,
            "method": method,
            "params": params,
        }
        try:
            await self.connection.write(frame, limit=MAX_CALLBACK_BYTES)
            return await future
        finally:
            self.callback_ids.discard(callback_id)
            current = self.connection.pending.get(callback_id)
            if current is future:
                self.connection.pending.pop(callback_id, None)
                self.connection._remember_cancelled(callback_id)
            if not future.done():
                future.cancel()

    def close(self) -> None:
        if not self.active:
            return
        self.active = False
        self.connection.cancel(self.callback_ids)


async def serve(
    session_dir: str | os.PathLike[str],
    *,
    input_stream: BinaryIO,
    output_stream: TextIO,
    forced_exit: Callable[[int], None] | None = None,
    forced_exit_grace: float = _FORCED_EXIT_GRACE_SECONDS,
) -> None:
    """Serve requests until an accepted close or ordered EOF."""
    if (
        isinstance(forced_exit_grace, bool)
        or not isinstance(forced_exit_grace, (int, float))
        or not math.isfinite(forced_exit_grace)
        or forced_exit_grace < 0
    ):
        raise ValueError("forced_exit_grace must be a finite non-negative number")

    kernel = await LocalKernel.open(session_dir)
    connection = _ProtocolConnection(input_stream, output_stream)
    connection.start()

    def interruption_cause() -> str:
        error = connection.fatal_error
        if error is None:
            return "bridge input was interrupted"
        return f"{error.code}: {error.message}"

    def arm_forced_exit(execution: asyncio.Task[CellResult]) -> None:
        if forced_exit is None or execution.done():
            return
        loop = asyncio.get_running_loop()
        handle = loop.call_later(
            float(forced_exit_grace), forced_exit, _FORCED_EXIT_CODE
        )
        execution.add_done_callback(lambda _task: handle.cancel())

    try:
        while True:
            inbound = await connection.next_inbound()
            if inbound is _EOF:
                break
            assert isinstance(inbound, _Inbound)
            if inbound.oversized:
                await connection.write(
                    _failure(
                        "REQUEST_TOO_LARGE",
                        f"request line exceeds {MAX_REQUEST_BYTES} bytes",
                    )
                )
                continue
            try:
                request = _parse_request(inbound.line)
            except ProtocolError as error:
                await connection.write(
                    _failure(error.code, error.message, request_id=error.request_id)
                )
                continue

            if request.method == "close":
                connection.accept_close()
                try:
                    await kernel.close()
                except BaseException as error:
                    await connection.write(
                        _failure(
                            "CLOSE_FAILED",
                            f"{type(error).__name__}: kernel close failed",
                            request_id=request.id,
                        )
                    )
                else:
                    await connection.write(
                        {"id": request.id, "ok": True, "result": {"closed": True}}
                    )
                return

            callbacks = None
            if _CALLBACK_CAPABILITY in request.capabilities:
                callbacks = _CellCallbacks(connection, request.id)
            execution = asyncio.create_task(
                kernel.execute(
                    request.source or "",
                    callback_parent_id=request.id if callbacks is not None else None,
                    host_callback=callbacks,
                )
            )
            closed_wait = asyncio.create_task(connection.closed.wait())
            try:
                done, _ = await asyncio.wait(
                    (execution, closed_wait), return_when=asyncio.FIRST_COMPLETED
                )
                if connection.fatal_error is not None:
                    await kernel.close(interruption_cause=interruption_cause())
                    arm_forced_exit(execution)
                    return
                if closed_wait in done:
                    await kernel.close(
                        interruption_cause="bridge input was interrupted"
                    )
                    arm_forced_exit(execution)
                    return
                closed_wait.cancel()
                try:
                    await closed_wait
                except asyncio.CancelledError:
                    pass
                result = await execution
                recovery_notice = kernel.take_recovery_notice()
                checkpoint = _checkpoint_summary(
                    kernel.last_checkpoint if result.ok else None
                )
                response = {
                    "id": request.id,
                    "ok": True,
                    "result": {
                        "cell": _cell_summary(result),
                        "checkpoint": checkpoint,
                        "recovery_notice": recovery_notice,
                    },
                }
            except asyncio.CancelledError:
                raise
            except BaseException as error:
                response = _failure(
                    "EXECUTE_FAILED",
                    f"{type(error).__name__}: kernel execution failed",
                    request_id=request.id,
                )
            finally:
                if callbacks is not None:
                    callbacks.close()
                if not closed_wait.done():
                    closed_wait.cancel()
            await connection.write(response)
    finally:
        if not kernel.closed:
            if connection.fatal_error is None:
                await kernel.close()
            else:
                await kernel.close(interruption_cause=interruption_cause())
        await connection.finish()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the dsh_rlm JSONL bridge")
    parser.add_argument("--session-dir", required=True, type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    # Keep fd 1 exclusively for protocol output. Late background writes go to
    # stderr after the REPL capture context has closed.
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    protocol_output = os.fdopen(protocol_fd, "w", encoding="utf-8", buffering=1)
    protocol_input = sys.stdin.buffer
    sys.stdout = sys.stderr
    sys.__stdout__ = sys.stderr
    try:
        asyncio.run(
            serve(
                args.session_dir,
                input_stream=protocol_input,
                output_stream=protocol_output,
                forced_exit=os._exit,
            )
        )
    finally:
        protocol_output.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "MAX_CALLBACK_BYTES",
    "MAX_CALLBACKS_INFLIGHT",
    "MAX_CALLBACKS_PER_EXECUTE",
    "MAX_PENDING_REQUESTS",
    "MAX_REQUEST_BYTES",
    "MAX_SOURCE_BYTES",
    "main",
    "serve",
]
