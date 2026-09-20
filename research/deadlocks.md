# Deadlocks and stalled work

Status: design review; these checks have not been implemented or tested here.

Waiting is not always a deadlock. An idle service can intentionally wait for its
next message. The problem is waiting when the work that would release the wait
cannot run. A busy Python loop is a different problem: it can stop every task and
timer in that interpreter.

## Rules for agent code

1. **Check optional messages without waiting.** Use `receive_nowait` between other
   operations. Use `receive` when waiting is intentional. Do not spin on
   `QueueEmpty`; yield or do other work. Process a bounded batch of messages.
2. **Do not await a worker that needs your next model step.** A parent cell waiting
   for a child cannot finish while the child waits for that parent's model to
   answer a question. End the cell so the model can run, or handle the request in
   independent code. A code-only reply mailbox does not fix a missing model step.
3. **Choose the right message mode.** `inject` does not wake an idle RLM. Do not
   send a request with `inject` and then wait for a reply that requires waking it.
4. **Choose what a timeout cancels.** Use standard asyncio cancellation and explicit
   shielding. Shielding preserves work; it does not break a circular dependency.
   `wait_for` can exceed its timeout while waiting for cancellation to finish.
5. **Do not block the shared event loop.** Synchronous I/O, CPU loops, locks, and
   serializers can stop message handling and timers. Use an appropriate async
   operation, thread, or process. Threads are not a forced-cancellation boundary.

## Requirements for the runtime

- The RLM checks pending input at model-step boundaries without waiting for a new
  message. It waits for waking input only when genuinely idle; completed tool
  work must be able to trigger the next model step without another message.
- `spawn` registers and schedules work; it must not wait for the child's first
  receive or user-defined initialization. The parent needs the handle to send
  that child's first message. Process launch likewise must not wait for arbitrary
  user code to finish connecting.
- Mailbox admission never waits for queue space, a receiver to read, or model
  progress. Fail clearly when full. Closing a mailbox wakes pending receivers.
  Bounded batches and bounded queues must also apply to internal message routing.
- On normal one-task RLM completion, check for pending follow-ups and close
  admission as one operation. If runnable input remains, continue processing it.
  A racing send must join that work or get a closed-mailbox error, not be accepted
  and silently forgotten. Failure can still interrupt already accepted work.
- Host replies, message admission, cancellation, and exit notices must not queue
  behind the code cell waiting for them. Keep control handling separate from
  serialized cell execution. User code still cannot receive a second concurrent
  cell as a workaround.
- Do not hold a registry lock or scheduling slot while waiting for work that
  needs that same resource. Reject exhausted child capacity
  rather than queue a child behind the waiting parent's lifetime. Do not reserve
  model-call capacity for an entire agent run.
- Never await user code or a callback while holding the mailbox/registry lock.
  Reserve and validate briefly, then perform external work without that lock.
- Drain process stdout and stderr while the process runs, even if no agent reads
  output. Reuse DSH's bounded collectors; do not let a full output pipe prevent
  the exit that `process.wait()` is awaiting.
- Bound shutdown, save, restore, and connection handshakes from the host. Do not
  rely solely on a timer in the Python loop that might be blocked. Never wait for
  a stuck cell just to take a final snapshot; keep the last completed checkpoint.
  Do not join the task performing its own cleanup or make a finished parent wait
  indefinitely for its children. Report incomplete cleanup rather than claim
  still-running work stopped. Resetting a shared Python host affects its other
  agents and requires a recovery notice.

## DSH integration findings

Checked source at commit `ddefc45fbc7f8e46dd73185e68295696d1297887`:

- Public `ToolRuntime.execute` runs permission, approval, and cancellation checks.
  It does not provide the agent loop's scheduling of concurrent tool calls. The
  internal PTC scheduler is not a public plugin API.
- PTC mode requires nested calls to carry the enclosing code call's token. A
  worker that outlives that cell cannot keep using its finished execution context.
  Start the integration in native tool mode with a code-first prompt, not PTC mode.
- Background tool calls remain a requirement. Give each a fresh invocation, the
  live owning Agent, and task-owned cancellation. Prove correct logging without
  inventing model tool calls or reusing the completed cell's token. This is an
  integration test to pass, not a verified implementation.
- Initially serialize Python tool calls per owning Agent, separately from the
  cell queue. Reject calls back into the same REPL through `execute_code` or
  equivalent aliases. Do not solve reentrancy by allowing concurrent cells.
- DSH has no global parent/child model semaphore. Capacity deadlocks would arise
  from limits we add or a provider adapter; do not hold a model slot while waiting
  for a child agent to finish.
- Cordis awaits async lifecycle hooks and cleanup. Those hooks must not wait back
  on the agent or service whose creation or disposal is waiting for the hook.

## First implementation checks

- Empty `receive_nowait` raises `asyncio.QueueEmpty` immediately. Closed and empty
  raises `MailboxClosedError`; both receive methods drain already queued messages.
- A child whose first operation is `receive` can be spawned and then sent input.
  Immediate child failure is observable. A process that never connects still starts.
- A child asks its waiting parent for a model decision. A shielded timeout lets
  the parent cell finish; only then can the next model step handle the request.
- A slow cell can await a host tool call and receive its reply. Repeat with tool
  concurrency set to one and with approval pending; nested execution must work
  or fail explicitly, not hang. Recursive calls into the same REPL fail promptly.
- A worker continues after its spawning cell returns, calls a host tool, and gets
  a properly authorized, logged result. Cancelling the old cell must not cancel
  this independent call. Cancelling the worker must request cancellation of it.
- A parent awaiting its child's result does not prevent the child making a model
  call. Exhausted child capacity produces a clear error.
- A full mailbox rejects a send without blocking unrelated agents. Closing an
  empty mailbox releases a pending receiver. A busy mailbox cannot starve control work.
- A tool result advances the RLM without another inbound message; idle `inject`
  does not wake it, while `steer` and `followup` do. Race a follow-up send against
  normal completion: it must be processed or rejected, not silently forgotten.
- A noisy process finishes even when no agent reads its output.
- An uncooperative task or serializer cannot prevent the host from reporting a
  timeout and offering termination/reset. An abrupt restart produces the required
  recovery notice before the next model request.

## Scope

Do not build a general deadlock detector or automatically release user locks.
Arbitrary Python can still create cycles or block forever. Prevent the runtime's
own circular waits, keep control available outside Python, and provide clear
failure reports plus prompt guidance.

## Sources

- [Tool execution input and public dispatch](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/tools/src/index.ts#L309-L335)
- [PTC restrictions and public execute](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/tools/src/index.ts#L1315-L1376)
- [Native tool scheduling](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/agent-loop/src/tool-calls.ts#L113-L231)
- [Cordis cleanup](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/vendor/cordis/src/fiber.ts#L402-L560)
