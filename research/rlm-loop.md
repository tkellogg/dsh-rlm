# RLM loop: CPython

Status: the persistent CPython loop, recovery path, and RLM Agent Preset are implemented; durable background host invocations remain future work.

## Decision

Use a small CPython REPL, not IPython or Jupyter. The RLM is a program running
on the [shared runtime](runtime-tasks.md), not a separate kind of agent.

Its loop is:

1. Ask a model for the next action.
2. If the action contains code, execute one cell.
3. Return the selected output or error to the model.
4. Repeat until the model finishes or the agent is stopped.

The implemented DSH `rlm` preset keeps DSH's outer model/tool loop but changes
the root controller surface: the model sees only `execute_python`, and Python
routes nested DSH tools and auxiliary no-tools model calls through the active
host execution. This makes Python the controller state without replacing DSH's
single `AgentFactory`. The controller prompt and Python tool are installed only
for live runtime roots. Spawned children use the Standard worker surface. The root callback API filters
and rejects `subagent_fork`, so the root controller prompt cannot be copied into
a fork; ordinary spawned children keep the Standard fork tool.

## Python execution

- Keep variables between cells in the same REPL.
- Keep one asyncio event loop running, including between cells.
- Support top-level `await` and display the last expression's value.
- Execute cells in order. Background tasks may run when a cell yields.
- Capture output and exceptions. Limit the output sent to the model.
- Keep runtime state across turns; attempt to restore saved values after restart.

A synchronous call can block every task on the shared event loop. Waiting with
`await` does not. Interruption and host termination must remain available outside
the Python loop; stopping one task must not be described as guaranteed isolation.

## Receiving messages

The driver checks pending input between model steps. Do not wait for a new
message before every step: tool results and unfinished work can require another
model call without new input. Wait for waking input only when the RLM is idle.
`inject` alone must not wake it. Keep DSH's `steer`, `followup`, and `inject`
behavior rather than replacing it with one unconditional FIFO receive.

## Prompt guidance for tasks

Use normal asyncio tasks and cancellation. Decide whether work should continue
if the current wait times out or is cancelled. Use `asyncio.wait_for(task, seconds)`
when the timeout should cancel that task. Use
`asyncio.wait_for(asyncio.shield(task), seconds)` when only the wait should end.
Do not shield everything by default. Keep the handle so unfinished work can be
checked, awaited, or cancelled later. Shielding does not protect against direct
cancellation, runtime shutdown, or a blocked event loop.

Do not wait inside a cell for a worker that needs your next model step to proceed.
End the cell so the model can handle that request. For code mailboxes, use
`receive_nowait` when checking for optional input; do not poll it in a tight loop.
See the [deadlock review](deadlocks.md).

## Restart

Agent sessions can resume after restart. Execution starts fresh. Interrupted
tasks do not restart automatically.

Use DSH for saved session history. Restore saved values into a fresh Python
runtime. Recreate runtime connections and register new mailboxes. Do not replay
old cells or try to restore running tasks or processes.

Checkpoint method, based on Prime Agent:

- Save user variables separately with `dill`, including functions where possible.
- Skip runtime resources, values that cannot be saved, and values over size limits.
  Do not delete a live variable just because it cannot be saved.
- Schedule saves after successful cells, combining closely spaced saves. Attempt
  a final save on orderly shutdown. Limit snapshot size and execution time.
- Replace the previous checkpoint only after writing a complete new one. Do not
  overwrite it with an empty runtime before attempting restore.
- Restore each saved variable independently. Tell the RLM what was restored,
  skipped, or failed, and which workers were interrupted.
- Load only trusted local snapshots: `dill` loading can execute code.

This is best-effort recovery from the last completed checkpoint, not an exact
interpreter image. Separate variable snapshots may lose shared object identity
between variables. Packages must still be available for values that depend on
them. Running tasks, process handles, and queued messages are not recoverable
REPL state.

## Recovery notices

The RLM must know when its harness or runtime was interrupted, even when most
state was restored. Report shutdown/restart, REPL reset, lost worker connections,
and failed saves or restores. A UI warning or debug log alone is not enough.

Record the notice in session history and include it before the next model
request. State:

- What happened and the cause, if known. Otherwise say the cause is unknown.
- Which checkpoint was restored, including its time or cell when available.
- Which values were restored, skipped, or failed.
- Which tasks ended, which outcomes are unknown, and which handles are invalid.

The host must detect interrupted runs without relying on a dying worker to send
a final message. Recovery notices must not depend on a lost task mailbox.
External actions may already have taken effect; the RLM must check before retrying.

## Why this choice

Prime Agent removed ipykernel and ZeroMQ in favor of a persistent CPython process
and JSON-lines messages. It compiles cells with
`ast.PyCF_ALLOW_TOP_LEVEL_AWAIT` and keeps background tasks running between cells.
Its authors report lower startup time, cell latency, and memory use. We have not
reproduced their measurements.

Use this execution pattern. Do not port its full host integration or add notebook
features. Sharing a Python host does not require sharing every agent's variables.

## First check

Set a variable in one cell and read it in another. Start an async worker, leave
the REPL idle, then verify that the worker continued and can report its result.
Restart the runtime: saved values should return, skipped values should be named,
and the old worker must not restart. Repeat with an abrupt exit that sends no
shutdown message. The first resumed model request must explain the interruption,
restored state, and uncertain task outcomes.

## Sources

Prime Agent commit `61eb64748eb077e2a084432db92d101a2a83e146`:

- [REPL implementation](https://github.com/PrimeIntellect-ai/prime-agent/blob/61eb64748eb077e2a084432db92d101a2a83e146/prime-agent-runtime/src/rlm/repl.py)
- [Migration and reported measurements](https://github.com/PrimeIntellect-ai/prime-agent/pull/1687)

Checkpoint reference at Prime Agent commit `a54b10f7fdb22a322c2f7081e1e3b88841bfce5c`:

- [Save and restore implementation](https://github.com/PrimeIntellect-ai/prime-agent/blob/a54b10f7fdb22a322c2f7081e1e3b88841bfce5c/prime-agent-runtime/src/rlm/repl.py#L608-L827)
- [Host save scheduling](https://github.com/PrimeIntellect-ai/prime-agent/blob/a54b10f7fdb22a322c2f7081e1e3b88841bfce5c/packages/coding-agent/src/core/kernel/repl-manager.ts)
