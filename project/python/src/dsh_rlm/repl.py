"""A small persistent CPython namespace for asynchronous code cells.

:class:`PersistentREPL` keeps one globals dictionary and runs each cell on the
caller's already-running asyncio event loop.  It does not create an event loop,
start a process, or speak a wire protocol.  Calls on one instance are
serialized, while normal ``asyncio`` tasks made by a cell remain scheduled on
the caller's loop after that cell returns.

The module installs one stable, process-wide stdout/stderr routing proxy.  The
proxy uses a ``ContextVar`` to send writes from the currently executing cell to
that cell's result.  A task created by a cell inherits its capture state, but
that state is closed when the cell returns; later writes therefore go to the
original stream rather than being swallowed or captured by a later cell.
Independent REPL instances can execute concurrently without cross-capturing.
Cell output, displays, and tracebacks are bounded by ``max_output_chars``.
"""

from __future__ import annotations
import __future__ as future_module

import ast
import asyncio
import inspect
import linecache
import sys
import threading
import traceback as traceback_module
from collections import deque
from contextvars import Context, ContextVar
from dataclasses import dataclass
from typing import Any, Mapping, TextIO

_TRUNCATION_MARKER = "... [truncated]"


def _truncate_text(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    marker_length = min(len(_TRUNCATION_MARKER), limit)
    prefix_length = limit - marker_length
    return text[:prefix_length] + _TRUNCATION_MARKER[:marker_length]


_FUTURE_FLAGS = 0
for _feature_name in future_module.all_feature_names:
    _FUTURE_FLAGS |= getattr(future_module, _feature_name).compiler_flag


def _bounded_repr(value: Any, limit: int, *, _depth: int = 0) -> str:
    """Render common values without invoking arbitrary user ``__repr__`` code."""
    if limit <= 0:
        return ""
    if value is None or isinstance(value, (bool, int, float, complex)):
        return _truncate_text(repr(value), limit)
    if isinstance(value, str):
        prefix = value[: max(1, limit // 4)]
        rendered = repr(prefix)
        if len(prefix) < len(value):
            rendered += _TRUNCATION_MARKER
        return _truncate_text(rendered, limit)
    if isinstance(value, bytes):
        prefix = value[: max(1, limit // 4)]
        rendered = repr(prefix)
        if len(prefix) < len(value):
            rendered += _TRUNCATION_MARKER
        return _truncate_text(rendered, limit)
    if _depth >= 4:
        return "..."

    item_limit = max(16, min(256, limit // 4))
    if isinstance(value, list):
        items = list(list.__iter__(value))[:20]
        rendered = "[" + ", ".join(
            _bounded_repr(item, item_limit, _depth=_depth + 1) for item in items
        )
        if len(value) > len(items):
            rendered += ", ..."
        return _truncate_text(rendered + "]", limit)
    if isinstance(value, tuple):
        items = list(tuple.__iter__(value))[:20]
        rendered = "(" + ", ".join(
            _bounded_repr(item, item_limit, _depth=_depth + 1) for item in items
        )
        if len(value) == 1:
            rendered += ","
        if len(value) > len(items):
            rendered += ", ..."
        return _truncate_text(rendered + ")", limit)
    if isinstance(value, dict):
        items = list(dict.items(value))[:20]
        rendered = "{" + ", ".join(
            f"{_bounded_repr(key, item_limit, _depth=_depth + 1)}: "
            f"{_bounded_repr(item, item_limit, _depth=_depth + 1)}"
            for key, item in items
        )
        if len(value) > len(items):
            rendered += ", ..."
        return _truncate_text(rendered + "}", limit)
    if isinstance(value, (set, frozenset)):
        iterator = (
            set.__iter__(value) if isinstance(value, set) else frozenset.__iter__(value)
        )
        items = list(iterator)[:20]
        rendered = "{" + ", ".join(
            _bounded_repr(item, item_limit, _depth=_depth + 1) for item in items
        )
        if len(value) > len(items):
            rendered += ", ..."
        return _truncate_text(rendered + "}", limit)

    value_type = type(value)
    return _truncate_text(
        f"<{value_type.__module__}.{value_type.__qualname__} object>", limit
    )


def _format_exception_bounded(error: BaseException, limit: int) -> str:
    lines: list[str] = []
    frames = traceback_module.extract_tb(error.__traceback__, limit=20)
    if frames:
        lines.append("Traceback (most recent call last):")
        for frame in frames:
            lines.append(
                f'  File "{_truncate_text(frame.filename, 300)}", line {frame.lineno}, '
                f"in {_truncate_text(frame.name, 200)}"
            )
            if frame.line:
                lines.append(f"    {_truncate_text(frame.line.strip(), 300)}")
    name = type(error).__name__
    if len(error.args) == 1 and isinstance(error.args[0], str):
        detail = _truncate_text(error.args[0], min(1_024, limit))
    elif len(error.args) == 1:
        detail = _bounded_repr(error.args[0], min(1_024, limit))
    elif error.args:
        detail = _bounded_repr(error.args, min(1_024, limit))
    else:
        detail = ""
    lines.append(f"{name}: {detail}" if detail else name)
    return _truncate_text("\n".join(lines) + "\n", limit)


class _BoundedBinaryBuffer:
    __slots__ = ("_text",)

    def __init__(self, text: _BoundedTextBuffer) -> None:
        self._text = text

    def write(self, data: bytes | bytearray | memoryview) -> int:
        payload = bytes(data)
        self._text.write(payload.decode("utf-8", errors="replace"))
        return len(payload)

    def flush(self) -> None:
        return None


class _BoundedTextBuffer:
    """A text sink with a bounded value and TextIO-compatible write counts."""

    __slots__ = ("_limit", "_chunks", "_length", "_truncated", "_binary")

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._chunks: list[str] = []
        self._length = 0
        self._truncated = False
        self._binary = _BoundedBinaryBuffer(self)

    @property
    def encoding(self) -> str:
        return "utf-8"

    @property
    def errors(self) -> str:
        return "replace"

    @property
    def buffer(self) -> _BoundedBinaryBuffer:
        return self._binary

    @property
    def closed(self) -> bool:
        return False

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        if not isinstance(text, str):
            raise TypeError(f"write() argument must be str, not {type(text).__name__}")
        written = len(text)
        if self._truncated or not text:
            return written
        if self._length + written <= self._limit:
            self._chunks.append(text)
            self._length += written
            return written

        current = "".join(self._chunks)
        marker_length = min(len(_TRUNCATION_MARKER), self._limit)
        prefix_length = self._limit - marker_length
        if len(current) < prefix_length:
            current += text[: prefix_length - len(current)]
        current = current[:prefix_length]
        self._chunks = [current, _TRUNCATION_MARKER[:marker_length]]
        self._length = self._limit
        self._truncated = True
        # A bounded result does not mean a short write to user code.  This is
        # important for print() and for code that checks write()'s return.
        return written

    def flush(self) -> None:
        return None

    def isatty(self) -> bool:
        return False

    def getvalue(self) -> str:
        return "".join(self._chunks)


@dataclass(slots=True)
class _CaptureState:
    stdout: _BoundedTextBuffer
    stderr: _BoundedTextBuffer
    closed: bool = False


_capture_state: ContextVar[_CaptureState | None] = ContextVar(
    "dsh_rlm_repl_capture_state", default=None
)
_task_owner: ContextVar[PersistentREPL | None] = ContextVar(
    "dsh_rlm_repl_task_owner", default=None
)
_task_factory_install_lock = threading.Lock()


class _TrackingTaskFactory:
    def __init__(self, previous: Any) -> None:
        self.previous = previous

    def __call__(
        self,
        loop: asyncio.AbstractEventLoop,
        coroutine: Any,
        *,
        context: Context | None = None,
    ) -> asyncio.Task[Any]:
        if self.previous is None:
            task = asyncio.Task(coroutine, loop=loop, context=context)
        else:
            task = self.previous(loop, coroutine, context=context)
        owner = context.get(_task_owner) if context is not None else _task_owner.get()
        if owner is not None:
            owner._track_background_task(task)
        return task


def _install_task_factory(loop: asyncio.AbstractEventLoop) -> None:
    with _task_factory_install_lock:
        current = loop.get_task_factory()
        if not isinstance(current, _TrackingTaskFactory):
            loop.set_task_factory(_TrackingTaskFactory(current))


class _RoutingStream:
    """Route writes using task-local state without swapping streams per cell."""

    def __init__(self, original: TextIO, stream_name: str) -> None:
        self._original = original
        self._stream_name = stream_name

    def _target(self) -> TextIO:
        state = _capture_state.get()
        if state is None or state.closed:
            return self._original
        return state.stdout if self._stream_name == "stdout" else state.stderr

    def write(self, text: str) -> int:
        return self._target().write(text)

    def flush(self) -> None:
        self._target().flush()

    def isatty(self) -> bool:
        return self._target().isatty()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._target(), name)


_routing_install_lock = threading.Lock()


def _install_routing_stream(name: str) -> None:
    """Install a router once when the first REPL is constructed."""
    with _routing_install_lock:
        current = getattr(sys, name)
        if not isinstance(current, _RoutingStream):
            setattr(sys, name, _RoutingStream(current, name))


@dataclass(frozen=True, slots=True)
class CellResult:
    """The captured result of one cell execution.

    ``value`` and ``display`` are populated only when the cell has a trailing
    expression whose value is not ``None``.  ``display`` is the value's
    ``repr`` and may end with a truncation marker.  A failed cell has its
    original exception in ``error`` and a formatted traceback in ``traceback``;
    execution errors are returned rather than raised.  Cancellation of the
    caller is not converted to a cell error.
    """

    stdout: str
    stderr: str
    value: Any = None
    display: str | None = None
    error: BaseException | None = None
    traceback: str | None = None

    @property
    def ok(self) -> bool:
        """Whether the cell completed without an execution error."""
        return self.error is None


class PersistentREPL:
    """Execute persistent Python cells on one caller-owned asyncio loop."""

    def __init__(
        self,
        initial_globals: Mapping[str, Any] | None = None,
        *,
        max_output_chars: int = 65_536,
    ) -> None:
        if isinstance(max_output_chars, bool) or not isinstance(max_output_chars, int):
            raise TypeError("max_output_chars must be a positive finite int")
        if max_output_chars <= 0:
            raise ValueError("max_output_chars must be a positive finite int")
        # Hosts such as test runners may replace sys.stdout after module import.
        # Re-establish the single router at component construction time, never
        # around an execute call where concurrent instances could race.
        _install_routing_stream("stdout")
        _install_routing_stream("stderr")
        self.max_output_chars = max_output_chars
        self.globals: dict[str, Any] = dict(initial_globals or {})
        self.globals.setdefault("__name__", "__main__")
        self.globals.setdefault("__builtins__", __builtins__)
        self._lock: asyncio.Lock | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._owner_task: asyncio.Task[Any] | None = None
        self._background_tasks: set[asyncio.Task[Any]] = set()
        self._future_flags = 0
        self._source_filenames: deque[str] = deque()
        self._cell_number = 0

    async def execute(self, source: str) -> CellResult:
        """Compile and execute one serialized cell on the owning event loop."""
        loop = asyncio.get_running_loop()
        current = asyncio.current_task()
        if current is self._owner_task:
            raise RuntimeError(
                "recursive execute on the same PersistentREPL is not allowed"
            )
        if self._loop is None:
            self._loop = loop
            _install_task_factory(loop)
        elif self._loop is not loop:
            raise RuntimeError("PersistentREPL must be used from one event loop")
        else:
            _install_task_factory(loop)
        if self._lock is None:
            self._lock = asyncio.Lock()

        async with self._lock:
            self._owner_task = current
            try:
                return await self._execute_serialized(source)
            finally:
                self._owner_task = None

    def _track_background_task(self, task: asyncio.Task[Any]) -> None:
        if task is self._owner_task:
            return
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    def pending_background_tasks(self) -> tuple[asyncio.Task[Any], ...]:
        """Return tasks created by cells or their descendants that are still live."""
        return tuple(task for task in self._background_tasks if not task.done())

    async def _execute_serialized(self, source: str) -> CellResult:
        self._cell_number += 1
        filename = f"<repl-{id(self):x}-{self._cell_number}>"
        state = _CaptureState(
            stdout=_BoundedTextBuffer(self.max_output_chars),
            stderr=_BoundedTextBuffer(self.max_output_chars),
        )
        capture_token = _capture_state.set(state)
        owner_token = _task_owner.set(self)
        try:
            try:
                codes, has_trailing, discovered_future_flags = self._compile_cell(
                    source, filename
                )
                value = await self._run_codes(codes)
                self._future_flags |= discovered_future_flags
                display: str | None = None
                displayed_value: Any = None
                if has_trailing and value is not None:
                    self.globals["_"] = value
                    display = _bounded_repr(value, self.max_output_chars)
                    displayed_value = value
                return CellResult(
                    stdout=state.stdout.getvalue(),
                    stderr=state.stderr.getvalue(),
                    value=displayed_value,
                    display=display,
                )
            except asyncio.CancelledError:
                raise
            except BaseException as exc:
                return CellResult(
                    stdout=state.stdout.getvalue(),
                    stderr=state.stderr.getvalue(),
                    error=exc,
                    traceback=_format_exception_bounded(exc, self.max_output_chars),
                )
        finally:
            state.closed = True
            _task_owner.reset(owner_token)
            _capture_state.reset(capture_token)

    def _compile_cell(self, source: str, filename: str) -> tuple[list[Any], bool, int]:
        """Compile a cell while retaining CPython future flags."""
        linecache.cache[filename] = (
            len(source),
            None,
            source.splitlines(keepends=True),
            filename,
        )
        self._source_filenames.append(filename)
        while len(self._source_filenames) > 128:
            linecache.cache.pop(self._source_filenames.popleft(), None)

        tree = ast.parse(source, filename=filename, mode="exec")
        trailing = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            trailing = tree.body.pop()

        flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT | self._future_flags
        codes: list[Any] = []
        discovered_future_flags = 0
        if tree.body:
            statements = compile(tree, filename, "exec", flags=flags, dont_inherit=True)
            codes.append(statements)
            discovered_future_flags = statements.co_flags & _FUTURE_FLAGS
        if trailing is not None:
            expression = ast.Expression(body=trailing.value)
            ast.copy_location(expression, trailing)
            ast.fix_missing_locations(expression)
            codes.append(
                compile(
                    expression,
                    filename,
                    "eval",
                    flags=flags | discovered_future_flags,
                    dont_inherit=True,
                )
            )
        return codes, trailing is not None, discovered_future_flags

    async def _run_codes(self, codes: list[Any]) -> Any:
        value: Any = None
        for code in codes:
            value = eval(code, self.globals)  # noqa: S307 - this is the REPL
            if code.co_flags & inspect.CO_COROUTINE:
                value = await value
        return value


__all__ = ["CellResult", "PersistentREPL"]
