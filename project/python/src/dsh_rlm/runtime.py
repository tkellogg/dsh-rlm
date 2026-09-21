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
from .inspection import (
    InspectionPage,
    ManagedLiveTaskRecord,
    TerminalRecordStore,
    page_managed_live_tasks,
)
from .host_workers import HostWorkers, worker_binding
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
    driver_mailbox_id: str
    owner_task: asyncio.Task[Any]
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
class ProgramAgentHandle(AgentRef, Generic[T]):
    """Control handle for a local program agent rooted at an async function."""

    task: asyncio.Task[T]
    _runtime: Runtime[Any] = field(repr=False, compare=False, default=None)

    async def status(self) -> AgentStatus:
        if self._runtime is None:
            return "unknown"
        if self.task.cancelled():
            return "cancelled"
        return self._runtime._status

    async def send(
        self,
        body: Any,
        *,
        mode: str | None = None,
        timeout: float = 5.0,
    ) -> SendReceipt:
        """Send from the current runtime to this agent's mailbox."""
        return await self.mailbox.send(body, mode=mode, timeout=timeout)

    def cancel(self, message: str | None = None) -> bool:
        """Request cooperative cancellation of this program agent task."""
        return self.task.cancel(message)

    def done(self) -> bool:
        return self.task.done()

    def cancelled(self) -> bool:
        return self.task.cancelled()

    async def wait(self) -> T:
        """Wait for the program agent result, failure, or cancellation."""
        return await self.task


# Compatibility name retained for existing callers; new code should use ProgramAgentHandle.
AgentHandle = ProgramAgentHandle


class _RuntimeState:
    def __init__(self) -> None:
        self.registry = _MailboxRegistry()
        self.terminal_records = TerminalRecordStore()


async def _invoke_host_callback(
    runtime: Runtime[Any], method: str, params: dict[str, Any]
) -> Any:
    # Worker authority is bound to the exact admitted asyncio task.  Context
    # inherited by a descendant never grants authority.
    lease,inherited_worker_context = worker_binding(runtime)
    if lease is not None:
        transport = runtime._host_worker_transport
        if transport is None:
            raise UnsupportedOperationError("host worker transport is unavailable")
        return await transport.invoke(lease, method, params)
    if inherited_worker_context:
        raise UnsupportedOperationError(
            f"{method} authority belongs to the exact admitted program-agent task"
        )
    scope = _HOST_CALLBACK_SCOPE.get()
    if scope is None or scope.state is not runtime._state or not scope.active:
        raise UnsupportedOperationError(
            f"{method} requires an active bridge execute cell with "
            'capability "host-callback-v1"'
        )
    if method == "mailbox.delivery" and params.get("mailbox_id") != scope.driver_mailbox_id:
        raise PermissionDeniedError(
            "mailbox delivery destination does not match the active driver"
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
        _driver_mailbox_id: str | None = None,
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
        self._handle: ProgramAgentHandle[Any] | None = None
        self._rlm = rlm
        self._started_at = __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat()
        self._terminal_sequence: int | None = None
        self._host_worker_transport: Any = None
        self._host_worker_tasks: set[asyncio.Task[Any]] = set()
        self._host_worker_cleanup_tasks: set[asyncio.Task[Any]] = set()
        self._host_worker_outcomes: list[dict[str, Any]] = []
        self.host_workers = HostWorkers(self)
        self.tools = Tools(self)
        self.models = Models(self)
        self.processes = _UnavailableNamespace("processes")
        self.recovery = None
        self.mailboxes = Mailboxes(self, self._state.registry)
        self.mailbox = self.mailboxes._create(
            mailbox or MailboxConfig(),
            driver_managed=rlm,
            mailbox_id=_driver_mailbox_id if rlm else None,
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

    async def spawn_program(
        self,
        entry: Callable[[Runtime[Any]], Awaitable[T]],
        *,
        name: str | None = None,
        mailbox: MailboxConfig | None = None,
    ) -> ProgramAgentHandle[T]:
        """Admit a program agent rooted at ``entry`` without waiting for it."""
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
        # A program agent admitted from an active bridged RLM receives its own
        # fresh, revocable host lease automatically.  The lease is bound to the
        # exact program-agent task; raw asyncio descendants cannot use it.
        scope = _HOST_CALLBACK_SCOPE.get()
        if (
            self._rlm
            and self._host_worker_transport is not None
            and _CURRENT_RUNTIME.get() is self
            and scope is not None
            and scope.active
            and scope.state is self._state
            and asyncio.current_task() is scope.owner_task
        ):
            child._host_worker_transport = self._host_worker_transport
            try:
                worker = await self.host_workers._spawn_bound(
                    lambda _child: child._execute(entry),
                    task_runtime=child,
                    name=name,
                    timeout=None,
                )
            except BaseException:
                child._finalize()
                raise
            task = worker.task
        else:
            task = loop.create_task(child._execute(entry), name=name)
        handle: ProgramAgentHandle[T] = ProgramAgentHandle(
            child.agent_id,
            child.name,
            child.session_id,
            child.mailbox,
            task,
            child,
        )
        child._handle = handle
        if not self.authoritative:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            child._finalize()
            raise MailboxClosedError(self.mailbox.id)
        self._children.add(child)
        task.add_done_callback(child._task_done)
        if task.done():
            # add_done_callback is scheduled, not invoked inline; avoid a stale
            # completed child during that scheduling gap.
            self._children.discard(child)
        return handle

    async def spawn(
        self,
        entry: Callable[[Runtime[Any]], Awaitable[T]],
        *,
        name: str | None = None,
        mailbox: MailboxConfig | None = None,
    ) -> ProgramAgentHandle[T]:
        """Backward-compatible alias for :meth:`spawn_program`."""
        return await self.spawn_program(entry, name=name, mailbox=mailbox)

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
        if backend.driver_managed:
            return await backend._deliver_driver(
                body, sender_runtime.mailbox, mode=mode, timeout=timeout
            )
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
        owner_task = asyncio.current_task()
        if owner_task is None:
            raise RuntimeError("host callback scope requires an asyncio task")
        scope = _HostCallbackScope(
            self._state, parent_id, callback, self.mailbox.id, owner_task
        )
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
            result = await _call_entry(entry, self)
        except asyncio.CancelledError:
            self._status = "cancelled"
            self._record_terminal()
            raise
        except BaseException as error:
            self._status = "failed"
            self._record_terminal(error)
            raise
        else:
            self._status = "completed"
            self._record_terminal()
            return result
        finally:
            self._finalize()
            _CURRENT_RUNTIME.reset(token)

    def _record_terminal(self, error: BaseException | None = None) -> None:
        if self._terminal_sequence is not None:
            return
        error_type = None
        error_message = None
        if error is not None:
            try:
                error_class = object.__getattribute__(error, "__class__")
                class_name = type.__getattribute__(error_class, "__name__")
                if type(class_name) is str:
                    error_type = class_name
                args = BaseException.args.__get__(error, error_class)
                if type(args) is tuple and args and type(args[0]) is str:
                    error_message = args[0]
            except BaseException:
                # Metadata capture must never replace the original failure.
                error_type = None
                error_message = None
        try:
            record = self._state.terminal_records.append(
            task_id=self.agent_id,
            parent_id=self.parent.id if self.parent is not None else None,
            name=self.name,
            state=self._status if self._status in {"completed", "failed", "cancelled", "interrupted", "unknown"} else "unknown",
            started_at=self._started_at,
            error_type=error_type,
            error_message=error_message,
            )
        except BaseException:
            return
        self._terminal_sequence = record.sequence

    def inspect_tasks(self, *, after: int | None = None, offset: int = 0, limit: int = 100) -> InspectionPage[Any]:
        """Inspect this owner's children; inspection never observes failures."""
        if not self.authoritative:
            raise RuntimeUnavailableError("runtime is not authoritative")
        return self._state.terminal_records.inspect(
            owner_id=self.agent_id, after=after, offset=offset, limit=limit
        )

    def inspect_live_tasks(self, *, offset: int = 0, limit: int = 100) -> InspectionPage[ManagedLiveTaskRecord]:
        """Inspect directly owned live children without touching task results."""
        if not self.authoritative:
            raise RuntimeUnavailableError("runtime is not authoritative")
        records = tuple(
            ManagedLiveTaskRecord(
                child.agent_id,
                self.agent_id,
                (
                    child.name
                    if type(child.name) is str and len(child.name) <= 512
                    else child.name[:511] + "…"
                    if type(child.name) is str
                    else None
                ),
                child._status if child._status in {"starting", "running", "idle", "stopping"} else "stopping",
                child._started_at,
            )
            for child in tuple(self._children)
            if child._handle is not None and not child._handle.task.done()
        )
        return page_managed_live_tasks(
            records, owner_id=self.agent_id, offset=offset, limit=limit
        )

    def _task_done(self, task: asyncio.Task[Any]) -> None:
        # A task can be cancelled before _execute gets a chance to run.
        if task.cancelled():
            self._status = "cancelled"
            self._record_terminal()
        elif self._status not in ("completed", "failed"):
            # Cancellation before _execute starts has no wrapper outcome.
            self._status = "unknown"
            self._record_terminal()
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
        if self._rlm and self._host_worker_transport is not None:
            retire = getattr(self._host_worker_transport, "retire", None)
            if retire is not None: retire("root runtime closed")
            self._host_worker_transport = None
        for worker in tuple(self._host_worker_tasks):
            if worker is not current and not worker.done(): worker.cancel()
        for cleanup in tuple(self._host_worker_cleanup_tasks):
            if cleanup is not current and not cleanup.done(): cleanup.cancel()
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
