"""The pure-Python asyncio runtime core."""

from __future__ import annotations

import asyncio
import contextvars
import inspect
import uuid
import weakref
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Generic, Literal, TypeVar

from .errors import (
    MailboxClosedError,
    MailboxNotFoundError,
    NoParentError,
    PermissionDeniedError,
    RuntimeUnavailableError,
    UnsupportedOperationError,
)
from .mailbox import (
    Mailbox,
    MailboxConfig,
    Mailboxes,
    MailboxRef,
    SendReceipt,
    _MailboxRegistry,
    _validate_send_timeout,
)

T = TypeVar("T")
M = TypeVar("M")
AgentStatus = Literal[
    "starting",
    "running",
    "idle",
    "stopping",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "unknown",
]

_CURRENT_RUNTIME: contextvars.ContextVar[Runtime[Any] | None] = contextvars.ContextVar(
    "dsh_rlm_current_runtime", default=None
)
_LIVE_RUNTIMES: weakref.WeakValueDictionary[str, Runtime[Any]] = (
    weakref.WeakValueDictionary()
)

_HostCallback = Callable[[str, str, dict[str, Any]], Awaitable[Any]]


@dataclass(slots=True)
class _HostCallbackScope:
    state: _RuntimeState
    parent_id: str
    callback: _HostCallback
    active: bool = True
    calls: int = 0


_HOST_CALLBACK_SCOPE: contextvars.ContextVar[_HostCallbackScope | None] = (
    contextvars.ContextVar("dsh_rlm_host_callback_scope", default=None)
)


@dataclass(frozen=True)
class AgentRef:
    id: str
    name: str | None
    session_id: str | None
    mailbox: MailboxRef


@dataclass(frozen=True)
class AgentHandle(AgentRef, Generic[T]):
    """Identity plus the actual asyncio task for a local agent run."""

    task: asyncio.Task[T]
    _runtime: Runtime[Any] = field(repr=False, compare=False, default=None)

    async def status(self) -> AgentStatus:
        if self._runtime is None:
            return "unknown"
        if self.task.cancelled():
            return "cancelled"
        if self.task.done():
            try:
                failed = self.task.exception() is not None
            except asyncio.CancelledError:
                return "cancelled"
            return "failed" if failed else "completed"
        return self._runtime._status


class _RuntimeState:
    def __init__(self) -> None:
        self.registry = _MailboxRegistry()


async def _invoke_host_callback(
    runtime: Runtime[Any], method: str, params: dict[str, Any]
) -> Any:
    scope = _HOST_CALLBACK_SCOPE.get()
    if scope is None or scope.state is not runtime._state or not scope.active:
        raise UnsupportedOperationError(
            f"{method} requires an active bridge execute cell with "
            'capability "host-callback-v1"'
        )
    return await scope.callback(scope.parent_id, method, params)


class Tools:
    """Host tools available to an opted-in bridge execute cell."""

    def __init__(self, runtime: Runtime[Any]) -> None:
        self._runtime = runtime

    async def list(self) -> Any:
        return await _invoke_host_callback(self._runtime, "tools.list", {})

    async def call(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        if not isinstance(name, str) or not name:
            raise TypeError("name must be a non-empty string")
        if name in {"execute_python", "subagent_fork"}:
            raise UnsupportedOperationError(
                f"tool {name!r} is not callable from Python"
            )
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            raise TypeError("arguments must be a dictionary")
        return await _invoke_host_callback(
            self._runtime,
            "tools.call",
            {"name": name, "arguments": arguments},
        )


class Models:
    """Host model completion available to an opted-in bridge execute cell."""

    def __init__(self, runtime: Runtime[Any]) -> None:
        self._runtime = runtime

    async def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        reasoning_effort: str | None = None,
        max_tokens: int | None = None,
    ) -> Any:
        if not isinstance(prompt, str):
            raise TypeError("prompt must be a string")
        for name, value in (
            ("system", system),
            ("provider", provider),
            ("model", model),
            ("reasoning_effort", reasoning_effort),
        ):
            if value is not None and not isinstance(value, str):
                raise TypeError(f"{name} must be a string or None")
        if (provider is None) != (model is None):
            raise ValueError("provider and model must be supplied together")
        if max_tokens is not None and (
            isinstance(max_tokens, bool)
            or not isinstance(max_tokens, int)
            or max_tokens <= 0
            or max_tokens > 1_000_000
        ):
            raise TypeError(
                "max_tokens must be an integer from 1 through 1000000 or None"
            )
        params: dict[str, Any] = {"prompt": prompt}
        for name, value in (
            ("system", system),
            ("provider", provider),
            ("model", model),
            ("reasoning_effort", reasoning_effort),
            ("max_tokens", max_tokens),
        ):
            if value is not None:
                params[name] = value
        return await _invoke_host_callback(self._runtime, "models.complete", params)


class _UnavailableNamespace:
    """Explicit placeholder for bridges outside this pure-Python milestone."""

    def __init__(self, name: str) -> None:
        self._name = name

    def __getattr__(self, operation: str):
        if operation.startswith("__"):
            raise AttributeError(operation)

        async def unavailable(*args: Any, **kwargs: Any) -> Any:
            raise UnsupportedOperationError(
                f"{self._name}.{operation} is not implemented by the local core"
            )

        return unavailable


class Runtime(Generic[M]):
    """A local runtime whose children are cooperative asyncio tasks.

    A Runtime object can be used directly to admit children.  ``run`` and the
    async context-manager form are convenience ways to make that runtime the
    current task-local runtime for an owning entrypoint.
    """

    def __init__(
        self,
        *,
        agent_id: str | None = None,
        name: str | None = None,
        session_id: str | None = None,
        parent: AgentRef | None = None,
        mailbox: MailboxConfig | None = None,
        rlm: bool = False,
        _state: _RuntimeState | None = None,
        _parent_runtime: Runtime[Any] | None = None,
    ) -> None:
        self.agent_id = agent_id or uuid.uuid4().hex
        existing = _LIVE_RUNTIMES.get(self.agent_id)
        if existing is not None and not existing.closed:
            raise ValueError(f"runtime ID is already live: {self.agent_id}")
        _LIVE_RUNTIMES[self.agent_id] = self
        self.name = name
        self.session_id = session_id
        self.parent = parent
        self._parent_runtime = _parent_runtime
        self._state = _state or _RuntimeState()
        self._closed = False
        self._status: AgentStatus = (
            "starting" if _parent_runtime is not None else "running"
        )
        self._children: set[Runtime[Any]] = set()
        self._owned_mailboxes: set[Mailbox[Any]] = set()
        self._context_token: contextvars.Token[Runtime[Any] | None] | None = None
        self._handle: AgentHandle[Any] | None = None
        self._rlm = rlm
        self.tools = Tools(self)
        self.models = Models(self)
        self.processes = _UnavailableNamespace("processes")
        self.recovery = None
        self.mailboxes = Mailboxes(self, self._state.registry)
        self.mailbox = self.mailboxes._create(
            mailbox or MailboxConfig(), driver_managed=rlm
        )

    @property
    def ref(self) -> AgentRef:
        return AgentRef(self.agent_id, self.name, self.session_id, self.mailbox)

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def authoritative(self) -> bool:
        return not self._closed and _LIVE_RUNTIMES.get(self.agent_id) is self

    async def spawn(
        self,
        entry: Callable[[Runtime[Any]], Awaitable[T]],
        *,
        name: str | None = None,
        mailbox: MailboxConfig | None = None,
    ) -> AgentHandle[T]:
        """Admit and schedule one child without waiting for user code."""
        if not self.authoritative:
            raise MailboxClosedError(self.mailbox.id)
        if not callable(entry):
            raise TypeError("entry must be an async callable accepting a Runtime")
        loop = asyncio.get_running_loop()
        child = Runtime(
            name=name,
            parent=self.ref,
            mailbox=mailbox,
            rlm=False,
            _state=self._state,
            _parent_runtime=self,
        )
        task: asyncio.Task[T] = loop.create_task(child._execute(entry), name=name)
        handle: AgentHandle[T] = AgentHandle(
            child.agent_id,
            child.name,
            child.session_id,
            child.mailbox,
            task,
            child,
        )
        child._handle = handle
        self._children.add(child)
        task.add_done_callback(child._task_done)
        return handle

    async def spawn_rlm(
        self,
        prompt: str,
        *,
        name: str | None = None,
        model: str | None = None,
        thinking: str | None = None,
    ) -> AgentHandle[str]:
        raise UnsupportedOperationError("spawn_rlm is outside the pure-Python core")

    async def send(
        self,
        body: Any,
        *,
        to: MailboxRef | str | None = None,
        mode: str | None = None,
        timeout: float = 5.0,
    ) -> SendReceipt:
        """Send to an explicit mailbox or this run's parent by default."""
        _validate_send_timeout(timeout)
        sender_runtime = current_runtime()
        if not self.authoritative:
            raise MailboxClosedError(self.mailbox.id)
        if sender_runtime is not self:
            raise PermissionDeniedError(
                f"runtime {sender_runtime.agent_id!r} cannot send as {self.agent_id!r}"
            )
        if to is None:
            if self.parent is None:
                raise NoParentError("runtime has no parent mailbox")
            target = self.parent.mailbox
        elif isinstance(to, str):
            target = await self.mailboxes.get(to)
        elif isinstance(to, MailboxRef):
            target = to
        else:
            raise TypeError("to must be a MailboxRef, mailbox ID, or None")
        backend = target._backend
        if backend is None:
            raise MailboxNotFoundError(target.id)
        return backend._admit(body, sender_runtime.mailbox, mode=mode)

    async def run(
        self,
        entry: Callable[[Runtime[Any]], Awaitable[T]],
    ) -> T:
        """Run an owning entrypoint in this runtime and then shut it down."""
        if not self.authoritative:
            raise MailboxClosedError(self.mailbox.id)
        token = _CURRENT_RUNTIME.set(self)
        try:
            result = await _call_entry(entry, self)
            return result
        finally:
            self._finalize()
            _CURRENT_RUNTIME.reset(token)
            # Run cancellation callbacks without awaiting arbitrary child code.
            await asyncio.sleep(0)

    async def __aenter__(self) -> Runtime[M]:
        if not self.authoritative:
            raise MailboxClosedError(self.mailbox.id)
        if self._context_token is not None:
            raise RuntimeError("Runtime context is already entered")
        self._context_token = _CURRENT_RUNTIME.set(self)
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self._finalize()
        if self._context_token is not None:
            _CURRENT_RUNTIME.reset(self._context_token)
            self._context_token = None
        # Give cancellation callbacks and mailbox wakeups one scheduling turn.
        await asyncio.sleep(0)

    @asynccontextmanager
    async def bind(self) -> AsyncIterator[Runtime[M]]:
        """Bind this live runtime to the current task without closing it."""
        if not self.authoritative:
            raise MailboxClosedError(self.mailbox.id)
        token = _CURRENT_RUNTIME.set(self)
        try:
            yield self
        finally:
            _CURRENT_RUNTIME.reset(token)

    @asynccontextmanager
    async def _bind_host_callbacks(
        self, parent_id: str, callback: _HostCallback
    ) -> AsyncIterator[None]:
        """Enable bridge callbacks for this cell and its task descendants."""
        scope = _HostCallbackScope(self._state, parent_id, callback)
        token = _HOST_CALLBACK_SCOPE.set(scope)
        try:
            yield
        finally:
            scope.active = False
            close = getattr(callback, "close", None)
            if close is not None:
                close()
            _HOST_CALLBACK_SCOPE.reset(token)

    async def close(self) -> None:
        """Close this run and request cancellation of its children.

        Child cleanup is cooperative.  ``close`` never waits on arbitrary user
        code, so a task that suppresses cancellation cannot stall shutdown.
        """
        self._finalize()
        # Give cancellation callbacks and mailbox wakeups one scheduling turn,
        # but never await arbitrary child cleanup.
        await asyncio.sleep(0)

    async def _execute(
        self,
        entry: Callable[[Runtime[Any]], Awaitable[T]],
    ) -> T:
        token = _CURRENT_RUNTIME.set(self)
        try:
            self._status = "running"
            return await _call_entry(entry, self)
        finally:
            self._finalize()
            _CURRENT_RUNTIME.reset(token)

    def _task_done(self, task: asyncio.Task[Any]) -> None:
        # A task can be cancelled before _execute gets a chance to run.
        if task.cancelled():
            self._status = "cancelled"
        else:
            try:
                exception = task.exception()
            except asyncio.CancelledError:
                self._status = "cancelled"
            else:
                self._status = "failed" if exception is not None else "completed"
        self._finalize()
        if self._parent_runtime is not None:
            self._parent_runtime._children.discard(self)

    def _finalize(self) -> None:
        if self._closed:
            return
        self._closed = True
        if _LIVE_RUNTIMES.get(self.agent_id) is self:
            _LIVE_RUNTIMES.pop(self.agent_id, None)
        if self._status in ("running", "starting"):
            # A normal return is changed to completed by _task_done.  During
            # finally this remains running until that callback executes.
            pass
        current = asyncio.current_task()
        for child in tuple(self._children):
            task = child._handle.task if child._handle is not None else None
            if task is not None and task is not current and not task.done():
                child._status = "stopping"
                task.cancel()
        # Closing admission and dropping pending messages is run cleanup.  It
        # does not await receivers or children.
        for mailbox in tuple(self._owned_mailboxes):
            mailbox._close_for_runtime(discard=True)
            self._state.registry.remove(mailbox)
            self._owned_mailboxes.discard(mailbox)


def _call_entry(
    entry: Callable[[Runtime[Any]], Awaitable[T]], runtime: Runtime[Any]
) -> Awaitable[T]:
    result = entry(runtime)
    if not inspect.isawaitable(result):
        raise TypeError("entry must return an awaitable")
    return result


def current_runtime() -> Runtime[Any]:
    runtime = _CURRENT_RUNTIME.get()
    if runtime is None:
        raise RuntimeUnavailableError(
            "no dsh_rlm Runtime is bound to the current asyncio task"
        )
    return runtime


@asynccontextmanager
async def connect():
    """Reserved for the external DSH bridge; importing it starts nothing."""
    raise UnsupportedOperationError("connect is outside the pure-Python core")
    yield  # pragma: no cover
