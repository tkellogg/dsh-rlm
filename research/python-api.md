# Shared Python API

Status: partially implemented. The local runtime, REPL, tasks, mailboxes, checkpoints,
and active-cell DSH tool/model callbacks are working. `connect`, `spawn_rlm`, process
wrappers, model discovery, and durable background host invocations remain design.
See the [runtime](runtime-tasks.md), [messaging](messaging.md), and
[REPL](rlm-loop.md) specs.

## Rules

- Async methods do work when awaited. Importing the package starts nothing.
- `spawn_program` and process `start` wait for admission and return handles, not results.
- Local agent handles expose real `asyncio.Task` objects. Use normal task awaiting,
  cancellation, results, and exceptions; there is no custom agent `wait` method.
- Choose `asyncio.shield` explicitly when cancelling a wait must not cancel the task.
  The runtime does not shield user work automatically.
- No change in behavior just because a caller inspected a handle.
- Handles refer to one live run. Saved session IDs are not live handles.
- Timeouts are seconds. `None` means no caller deadline where allowed; host
  execution limits still apply. Send deadlines must be finite and positive.

## Runtime and task entrypoints

The runtime passes an agent its own `Runtime`. The RLM gets the same object as
`runtime` in its REPL. `current_runtime()` is a task-local convenience, not a
process-global singleton. Calling it outside an agent raises `RuntimeUnavailableError`.

```python
import asyncio
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Generic, TypeVar, Union

JsonValue = Union[None, bool, int, float, str, list["JsonValue"], dict[str, "JsonValue"]]
T = TypeVar("T")
M = TypeVar("M")

class Runtime(Generic[M]):
    agent_id: str                       # This run; changes after restart.
    session_id: str | None              # Saved RLM session, if any.
    parent: "AgentRef | None"           # Identity/address, not a control handle.
    mailbox: "Mailbox[M]"
    mailboxes: "Mailboxes"
    tools: "Tools"
    models: "Models"
    processes: "Processes"
    recovery: "RecoveryReport | None"

    async def spawn_program(
        self,
        entry: Callable[["Runtime[Any]"], Awaitable[T]],
        *,
        name: str | None = None,
        mailbox: "MailboxConfig | None" = None,
    ) -> "ProgramAgentHandle[T]": ...

    async def spawn_rlm(
        self, prompt: str, *, name: str | None = None, model: str | None = None,
        thinking: str | None = None,
    ) -> "AgentHandle[str]": ...

    async def send(
        self, body: Any, *, to: "MailboxRef | str | None" = None,
        mode: "DeliveryMode | None" = None, timeout: float = 5.0,
    ) -> "SendReceipt": ...


def current_runtime() -> Runtime[Any]: ...
def connect() -> AbstractAsyncContextManager[Runtime[Any]]: ...
```

`spawn_program` starts a program agent as a cooperative task in the current Python host. A program agent has an async function at its root and no autonomous LLM loop. Pass an async
function, not a coroutine that has already been scheduled. Bind extra arguments
with a closure or `functools.partial`; the runtime supplies the remaining argument.
The child has its own identity and mailbox before the handle is returned.
It cannot receive more permissions than its parent. Shared Python tasks use the
owning DSH Agent's policy; a separate task identity is not a security boundary.

`spawn_rlm` is a convenience for the same runtime running an RLM program. It
returns a handle after admission, not after the model answers. Model defaults are
inherited; an explicit model is a DSH provider/model selector.

For an externally launched Python program, `connect()` is an async context
manager: `async with connect() as runtime:`. It reads launcher-supplied connection
settings and joins the identity already assigned to that process. Exiting closes
that connection, not the parent runtime. No automatic connection on import.

## Program-agent handles

```python
@dataclass(frozen=True)
class AgentRef:
    id: str
    name: str | None
    session_id: str | None
    mailbox: "MailboxRef"

@dataclass(frozen=True)
class ProgramAgentHandle(AgentRef, Generic[T]):
    task: asyncio.Task[T]

    async def status(self) -> "AgentStatus": ...
```

Properties are immutable identity data. Only the creator receives a control
handle; a child's parent reference cannot cancel the parent. `status()` asks for current state.
States are `starting`, `running`, `idle`, `stopping`, `completed`, `failed`,
`cancelled`, `interrupted`, or `unknown`. Only an RLM reports `idle`; program
agents remain `running` while waiting for I/O or messages. An idle agent is alive.
A disconnected host can make status unknown; it does not prove completion or death.

`await child.task` returns the entrypoint's Python result or raises its original
exception. Cancellation uses `asyncio.CancelledError`. `task.result()`, `done()`,
`cancelled()`, and synchronous `task.cancel()` have their standard meanings.
Cancelling a task requests cancellation; code can delay or suppress it. The
runtime does not mark a run cancelled merely because `cancel()` was called.

Awaiting the task means terminal completion, not merely that an RLM became idle.
A spawned one-task RLM returns its final text when its work and accepted follow-ups
finish, then closes its mailbox. A persistent interactive RLM remains alive while
idle. A saved session can resume later, with a new run, task, and mailbox.

Children belong to their parent run, not the cell or function that called `spawn_program`.
The runtime keeps strong references and observes completion even if a handle is
dropped. That ownership does not suppress ordinary asyncio cancellation through
an `await`. Proposed default: ending the parent run requests child cancellation.
Do not silently let children outlive it or wait forever for uncooperative cleanup.

Local task results retain ordinary Python semantics, including object identity;
only messages cross the JSON boundary. These are actual local tasks, not remote
completion proxies. A future remote-agent API must state its result and
cancellation rules explicitly rather than pretend to be a local task.

### Timeouts and shielding

```python
# Stop the worker if this wait times out.
answer = await asyncio.wait_for(child.task, timeout=5)

# Alternative: stop waiting, but let the worker continue.
try:
    answer = await asyncio.wait_for(asyncio.shield(child.task), timeout=5)
except TimeoutError:
    pass  # Keep child; inspect or await child.task later.
```

These are alternatives, not consecutive operations on the same task. The LLM
chooses based on whether the work should outlive the wait. Shielding does not
prevent direct cancellation, parent-run shutdown, or host failure. `wait_for`
is cooperative: cancellation cleanup can exceed the timeout, and blocking the
shared event loop also blocks its timers.

## Mailboxes and messages

```python
from dataclasses import dataclass
from typing import AsyncIterator, Literal
from pydantic import BaseModel

DeliveryMode = Literal["steer", "followup", "inject"]

@dataclass(frozen=True)
class MailboxConfig:
    message_type: type[str] | type[BaseModel] | None = None
    capacity: int = 64
    max_message_bytes: int = 65_536

@dataclass(frozen=True)
class SendReceipt:
    message_id: str
    mailbox_id: str
    accepted_at: str

@dataclass(frozen=True)
class Message(Generic[M]):
    id: str
    sender: "MailboxRef"
    body: M

class MailboxRef:
    id: str
    agent_id: str

    async def send(
        self, body: Any, *, mode: DeliveryMode | None = None,
        timeout: float = 5.0,
    ) -> SendReceipt: ...

class Mailbox(MailboxRef, Generic[M]):
    def receive_nowait(self) -> Message[M]: ...
    async def receive(self, *, timeout: float | None = None) -> Message[M]: ...
    def __aiter__(self) -> AsyncIterator[Message[M]]: ...
    async def close(self) -> None: ...

class Mailboxes:
    async def create(self, *, config: MailboxConfig | None = None) -> Mailbox[Any]: ...
    async def get(self, address: str) -> MailboxRef: ...
    async def list(self) -> list[MailboxRef]: ...
```

Each agent has a default mailbox registered at startup. `create` adds an ordinary
FIFO mailbox owned by the current run, including from an RLM cell. Addresses
identify one registration and are never reused; there are no aliases or names.
`get` resolves an exact address and fails if it is dead. `list` returns only
permitted live destinations. Receiving and closing are owner-only. Queue limits
must be positive and within host limits; zero never means an unbounded queue.

`Runtime.send` defaults to the parent's mailbox. With no parent it raises
`NoParentError`; it does not broadcast or send to itself. It delegates to
`MailboxRef.send`, so both spellings have identical delivery behavior.

`mode=None` selects `steer` for an RLM and ordinary FIFO delivery for a code
receiver. Explicit RLM modes on a code-only mailbox raise `UnsupportedDeliveryModeError`.
`inject` deliberately does not wake an idle RLM. No mode interrupts a Python cell.

An untyped mailbox accepts JSON values, including text. Proposed typed form:
`str` or a Pydantic model class. The registered JSON schema is the acceptance
contract. Sender and receiver validate the same JSON representation, without
coercion. Pydantic reconstructs the declared model for code receivers; custom
validators/serializers and Python-only field types are excluded from this first
version and rejected at registration. Handles are not payloads; send mailbox IDs
as strings when needed. Local delivery also copies through JSON, not shared objects.

`send` returns only after acceptance. It never waits for reading, a model turn,
a reply, or queue space. Full/dead/invalid/unauthorized destinations raise clear
errors on the sender. Cancellation or a connection timeout after dispatch may
leave acceptance unknown; do not automatically resend.

`receive_nowait` is synchronous, like `asyncio.Queue.get_nowait`. It removes
and returns the next available message, or raises `asyncio.QueueEmpty` if the
mailbox is open and empty. It never performs network I/O. Code mailboxes keep
their actual receive queue in the receiver's Python host; sending succeeds only
after that queue accepts the message. No second unbounded delivery queue is hidden
behind the API. An empty result says nothing about messages still in transit.

`receive` waits when that same queue is empty. A timeout or cancellation before
delivery must not consume a message. Competing readers divide messages, not
broadcast them. `close` is idempotent and returns after closing admission. Queued
messages remain receivable by either method; once empty, both raise
`MailboxClosedError` and async iteration ends. Run exit closes all owned mailboxes
and discards pending messages without waiting for a reader.

The RLM driver automatically consumes its default mailbox through the DSH inbox
operations; it need not literally call this Python receive method. Calling either
receive method on that mailbox from a cell raises `MailboxInUseError`.
An RLM cell uses `mailboxes.create` when it needs to receive directly in Python.
Extra mailboxes always use ordinary FIFO delivery, not RLM delivery modes.
The cell also cannot close the driver's default mailbox.

Replies are ordinary sends: `await message.sender.send(response)`. There is no
implicit request/reply wait or processing acknowledgment.

### Checking messages without stopping other work

```python
# `inbox` is a code mailbox owned by this agent.
for _ in range(32):
    try:
        message = inbox.receive_nowait()
    except asyncio.QueueEmpty:
        break
    await handle_message(message)
# Continue other work. Do not spin on an empty mailbox.
```

Use `receive` or async iteration when waiting for messages is the program's job.
Use `receive_nowait` when checking for messages between other operations. Process
a bounded batch so a stream of messages does not monopolize the loop. See the
[deadlock review](deadlocks.md) for waits that must not depend on the caller.

## Tools and model calls

The working bridge API is:

```python
class Tools:
    async def list(self) -> list[dict[str, Any]]: ...
    async def call(self, name: str, arguments: dict[str, Any] | None = None) -> Any: ...

class Models:
    async def complete(
        self, prompt: str, *, system: str | None = None,
        provider: str | None = None, model: str | None = None,
        reasoning_effort: str | None = None, max_tokens: int | None = None,
    ) -> dict[str, Any]: ...
```

`tools.list` returns DSH's scoped schemas, excluding `execute_python` and
`subagent_fork`. `tools.call` uses `ToolRuntime.execute` with the owning Agent,
outer root call ID, parent execution token, initiator scope, permissions,
approvals, and cancellation. It returns the tool's structured JSON value.
Nested tool calls are serialized because DSH does not expose the agent loop's
tool scheduler as a public plugin API. Same-bridge re-entry is rejected both by
name and by causal `AsyncLocalStorage` identity.

`models.complete` performs one auxiliary, no-tools DSH model call. It defaults to
the current request's provider, model, and reasoning effort. A route override
must provide both `provider` and `model`. The result contains `text`, `provider`,
`model`, `finish`, and `usage`; model-emitted tool calls are rejected.
Independent model calls may run concurrently and correlate out of order.

Both APIs require the `host-callback-v1` capability and the live
`execute_python` cell that created them. Every host call must settle or be
revoked before that outer call resolves. A persistent background task cannot
reuse the completed cell's token; a future background API needs a fresh owned
invocation. The host applies a 120-second callback deadline plus bounded payload,
count, and in-flight limits. Nested operations traverse normal host middleware,
but this out-of-tree slice records them only within the durable outer
`execute_python` call rather than as separate session events.

Model discovery, per-call timeout parameters, and fresh background invocation
contexts remain future API.

## Commands

```python
from collections.abc import Mapping, Sequence
from os import PathLike

class Processes:
    async def start(
        self, argv: Sequence[str], *, cwd: str | PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
    ) -> "ProcessHandle": ...

class ProcessHandle:
    id: str
    pid: int | None

    async def wait(self) -> "ProcessResult": ...
    async def read_output(
        self, *, stream: Literal["stdout", "stderr"] = "stdout", offset: int = 0,
    ) -> "OutputChunk": ...
    async def terminate(self) -> None: ...
```

`start` returns once DSH has started and registered the process. It never treats
an argument list as shell code. Use `["bash", "-lc", command]` explicitly for a
shell. `cwd` defaults to the runtime's working directory; `env` overlays the
approved environment. Launcher identity/connection keys are reserved; attempts
to override them fail. Neither option changes process-wide Python globals.

`wait` returns `ProcessResult(returncode, signal, duration)` even for nonzero exit
codes. A signal exit may have `returncode=None`; `signal` identifies the cause.
Read stdout and stderr separately through DSH's existing collected-output readers.
`OutputChunk` contains `text`, `next_offset`, and `truncated`. Start at zero and
reuse returned offsets; arbitrary byte seeks and combined-stream ordering are
not promised. Reads are bounded by host retention limits and do not consume other
readers' output. Gaps are explicit; full output may remain in DSH's spill file.
`terminate` requests DSH's termination procedure; it does not claim the process
has exited. Wait separately to confirm. Use `asyncio.wait_for(process.wait(), n)`
for a bounded wait. As with asyncio subprocesses, cancelling the process waiter
does not terminate the operating-system process; call `terminate` explicitly.
This is a DSH process wrapper, not an `asyncio.Task`.

Programs launched this way receive scoped runtime connection settings and can
optionally call `connect()`. They remain ordinary owned jobs if they never join.
A task closure is not automatically pickled into a process. No process-per-agent
requirement is implied by this API.

## Example: code worker used from an RLM cell

```python
from pydantic import BaseModel
from dsh_rlm import Runtime, MailboxConfig

class Question(BaseModel):
    text: str
    reply_to: str | None = None

async def worker(rt: Runtime[Question]) -> str:
    message = await rt.mailbox.receive()
    answer = await rt.models.complete(message.body.text)
    await rt.send(answer["text"], to=message.body.reply_to or message.sender)
    return answer["text"]

child = await runtime.spawn_program(
    worker, name="reviewer", mailbox=MailboxConfig(message_type=Question),
)
await child.mailbox.send(Question(text="What risks does this change introduce?"))
# The RLM can continue; the reply will steer its next model step.
# Or wait for completion: answer = await child.task
# To stop waiting after 60 seconds without cancelling the worker:
# answer = await asyncio.wait_for(asyncio.shield(child.task), timeout=60)
```

For code-directed replies inside an RLM, create a separate mailbox and pass its
ID as an ordinary field in your application's message. Receive and close it with:

```python
replies = await runtime.mailboxes.create(config=MailboxConfig(message_type=str))
child = await runtime.spawn_program(worker, mailbox=MailboxConfig(message_type=Question))
await child.mailbox.send(Question(text="Review the risks", reply_to=replies.id))
try:
    message = await replies.receive(timeout=30)
finally:
    await replies.close()
```

## Recovery and errors

`runtime.recovery` is a plain read-only report of the last restore: cause if
known, checkpoint identity, restored/skipped/failed names, and interrupted or
unknown work. The host must also put recovery notices in model context; having
this property alone does not satisfy the [notice requirement](rlm-loop.md#recovery-notices).
Live Runtime, mailbox, agent, and process handles are excluded from checkpoints.
Saving an ID for reference must not revive the old run.

Use ordinary `TimeoutError` and `PermissionError` where appropriate. Runtime
errors distinguish `RuntimeUnavailableError`, `NoParentError`, `MailboxClosedError`,
`MailboxFullError`, `MailboxInUseError`, `MessageValidationError`, `UnsupportedDeliveryModeError`,
and `ToolError`. Local tasks preserve their original exceptions and normal
`asyncio.CancelledError`; host interruptions are reported through recovery notices.
Errors carry relevant
IDs; type errors include the failing field. A known rejection means not accepted;
a transport failure may mean unknown acceptance or external effects.

## Choices needing review

- Pydantic models with JSON-schema-only validation as the first typed format.
- Extra code mailboxes so RLM cells can receive without competing with the driver.
- Child cancellation when the parent run ends.
- One-task spawned RLMs versus long-lived interactive RLM runs.
- Queue sizes and timeout defaults above are proposals, not measured limits.

## Prime Agent reference

At commit `a54b10f7fdb22a322c2f7081e1e3b88841bfce5c`, Prime provides frozen spawn
handles, an explicit host bridge, structured tool calls, and live process handles.
This draft keeps those ideas, but does not copy callable-module aliases,
`run` meaning only admission, or cancellation behavior that changes after reading
a process handle property.

- [Python runtime API](https://github.com/PrimeIntellect-ai/prime-agent/blob/a54b10f7fdb22a322c2f7081e1e3b88841bfce5c/prime-agent-runtime/src/rlm/__init__.py)
- [Process API](https://github.com/PrimeIntellect-ai/prime-agent/blob/a54b10f7fdb22a322c2f7081e1e3b88841bfce5c/prime-agent-runtime/src/rlm/bash.py)
