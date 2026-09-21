# RLM runtime cookbook

These recipes describe the APIs in this source checkout. They do **not** imply that an already-running DSH host has been rebuilt or restarted.


## Run a continuous program agent

A **program agent** is an async function at the root of a cooperative `asyncio.Task`. It has no autonomous LLM loop; it uses the same runtime APIs, including tools, models, messaging, and subagent operations when its authority permits them.
Pass the function to `runtime.spawn_program`; its argument is the child's isolated
`Runtime`. The function may return promptly or keep running and receiving bounded
messages until cancellation:

```python
from dsh_rlm import MailboxConfig

replies = await runtime.mailboxes.create(
    config=MailboxConfig(message_type=str, capacity=8)
)

async def echo_agent(child):
    try:
        while True:
            message = await child.mailbox.receive()
            await child.send(f"echo:{message.body}", to=replies)
    finally:
        # Release resources here. Cancellation is cooperative.
        pass

handle = await runtime.spawn_program(
    echo_agent,
    name="echo-agent",
    mailbox=MailboxConfig(message_type=str, capacity=8),
)

await handle.send("hello")
reply = await replies.receive(timeout=5)
assert reply.body == "echo:hello"

handle.cancel("no longer needed")
try:
    await handle.wait()
except asyncio.CancelledError:
    pass
```

`handle.send()` sends as the currently bound runtime and therefore must be called
inside its owning runtime context (as `execute_python` is) or an explicit
`async with runtime.bind()` block. The child can reply with `child.send(...)`;
without `to=`, it sends to its parent mailbox. `handle.cancel()` is a cooperative
kill request implemented with task cancellation: the function receives
`asyncio.CancelledError` at its next cancellation point and must not suppress it
indefinitely. `handle.wait()`, `status()`, `done()`, and `cancelled()` expose the
lifecycle. Closing the parent also cancels its live children and closes their
mailboxes. When spawned during an active bridged RLM cell, a program agent is
automatically admitted for fresh post-cell Harness calls: `child.tools`,
`child.models`, and permitted subagent tools continue to work after the creating
cell returns. Authority is bound to the exact program-agent task, so a raw
`asyncio.create_task()` descendant cannot borrow it. Every call rechecks the live
owner and policy; completion or cancellation releases the lease. In the pure
Python core, program agents remain local-only. Program agents are process-live
and are not restored or replayed after a crash.

## Discover tools without expanding every schema

Keep the raw catalogue in Python, inspect a compact page, then select one exact entry only when needed:

```python
from dsh_rlm.context_inspection import compact_tools, tool_schema

catalogue = await runtime.tools.list()
page = compact_tools(catalogue)  # offset=0, max_tools=40
page.value                     # name, description, description_truncated
page.truncated, page.omitted

next_page = compact_tools(catalogue, offset=40)
read_spec = tool_schema(catalogue, "read")  # complete retained entry
result = await runtime.tools.call("read", {"file_path": "README.md"})
```

`compact_tools` accepts an exact built-in `list`, preserves exact usable names, sorts only each page, and omits schemas. Current defaults are `max_tools=40`, `max_name=128`, and `max_description=160`; `offset` indexes the raw catalogue, so advance it by the requested page size. `tool_schema` requires one unique exact-name match and returns that retained entry. The catalogue is a snapshot, not authority: `runtime.tools.call()` still performs current host policy and approval checks.

## Inspect a large retained result safely

```python
from dsh_rlm.context_inspection import inspect_value

view = inspect_value(result)  # depth 4, 20 items, 500 chars, 100 nodes
view.value
view.truncated, view.omitted, view.notes

# Traverse the retained source, and page that selected list/mapping.
more = view.at("lines", offset=20, max_items=10)
more.value
```

Inspection traverses only exact built-in `dict`, `list`, `tuple`, and scalar values. Unsupported objects and container subclasses are opaque; the helper does not call their `repr`, properties, iteration, or indexing. Paths use exact string/integer components. `.at(...)` resolves against the original live object graph and resets unspecified limits to the safe defaults—it does not inherit enlarged bounds from the earlier view.

“Retained” means reachable in this live Python process. It is not a durable result store and may not be checkpointable. `omitted` is an aggregate truncation signal, not a byte count. Structured error/timeout/denial keys are prioritized, but exceptions from the underlying host call remain unsuppressed.

## Compare live names with checkpoint inventory

```python
state = runtime.inspection.state(limit=100)  # offset=0; limit is 1..200
for item in state.live.items:
    print(item.name, item.type_name,
          item.snapshot_contains_name,
          item.current_value_matches_snapshot)

state.durable       # last successfully published snapshot, or None
state.last_attempt  # latest checkpoint attempt, independently, or None
```

`snapshot_contains_name` means only that the name occurred in the published checkpoint generation. `current_value_matches_snapshot` is conservatively always `"unknown"`: membership does not prove that a mutable live value still equals saved data. A skipped value can remain live, and a failed later checkpoint does not erase metadata for the preceding successful snapshot.


## Distinguish conversation compaction from Python checkpoints

DSH automatically compacts older model conversation history for the RLM preset, using the same compaction group as Standard. `/compact` forces one idle-session compaction; automatic pressure normally begins at 80% of the routed model context and retains a recent verbatim tail. This changes the model-visible session surface, not the persistent Python interpreter or its checkpoint files.

A compaction summary is lossy, model-generated context. It is not authoritative evidence that a Python global exists, that a task or handle is still live, that an approval was granted, or that an uncertain external effect succeeded or failed. After compaction or recovery, rediscover state with `runtime.inspection.state()`, `runtime.inspect_live_tasks()`, `runtime.inspect_tasks()`, and targeted reads of named globals. A restored Python value likewise does not prove that conversational work completed or that an external effect is safe to retry.

Recovery notices invalidate prior live tasks, mailboxes, and handles. Preserve their effect-uncertainty instruction: check whether an external effect happened before retrying. Large `execute_python` output is head/middle/tail-pruned by DSH; the renderer deliberately places the recovery notice first and checkpoint/nonrecoverable-state warnings last. This ordering is regression-tested but is not a general trusted ledger against adversarial or exceptionally large metadata.

## Inspect directly owned tasks

```python
live = runtime.inspect_live_tasks(limit=100)
for task in live.items:
    print(task.task_id, task.name, task.state)

terminal = runtime.inspect_tasks(after=None, limit=100)
last_sequence = terminal.items[-1].sequence if terminal.items else None
newer = runtime.inspect_tasks(after=last_sequence, limit=100)
```

Both APIs show only the current runtime's **direct children** and require that runtime to remain authoritative. Defaults are `offset=0`, `limit=100` (maximum 200). Live and terminal pages are separate. Terminal history is an in-memory ring of 256 records; inspect `oldest_sequence`, `newest_sequence`, and `evicted_through` for retention gaps. Owner filtering happens before pagination, but noisy siblings can still cause global ring eviction. Inspection does not retrieve task results/exceptions or mark failures observed. Task results, tracebacks, running tasks, and terminal history are not checkpoint-durable.

## Send a worker result to the driver during an active cell

A local managed worker can send to its parent/driver mailbox while the originating `execute_python` cell's host callback lease is still active:

```python
async def worker(child_runtime):
    receipt = await child_runtime.send(
        {"kind": "progress", "value": 42},
        mode="steer",       # default; also "followup" or "inject"
        timeout=5.0,         # current default
    )
    return receipt.message_id

handle = await runtime.spawn_program(worker, name="progress-worker")
message_id = await handle.task
```

Mode semantics are:

- `steer`: next step and wake an idle agent;
- `followup`: next turn and wake an idle agent;
- `inject`: next step without waking an idle agent.

This driver mailbox delivery path remains limited to the **active execute cell**. A receipt acknowledges synchronous DSH inbox admission, not model processing or survival after cancellation/disposal. A timeout or transport failure can occur after admission, so the outcome is uncertain: **do not automatically retry**. The host pressure ceiling is currently 64 pending messages; caller capacity may only narrow it.

## Run an explicitly admitted host worker after the cell

Issue 03 is implemented and source/test-validated in this **source checkout**. It is not deployed merely by editing these files: rebuild/reinstall the plugin and restart the relevant existing host before expecting a running system to expose it.

Admission itself must occur on the authoritative root RLM runtime during an active `execute_python` cell:

```python
async def background(root):
    tools = await root.tools.list()
    # Host calls remain guarded. A DSH subagent message, for example:
    # await root.tools.call("send_message", {"agent_id": child_id,
    #                                        "message": "finished"})
    return len(tools)

worker = await runtime.host_workers.spawn(
    background,
    name="catalogue-worker",  # optional, at most 256 characters
    timeout=120,              # optional whole-worker lifetime; (0, 120]
)
# Let this execute_python cell return; the admitted worker can continue.
# In a later cell, retrieve or control the same retained handle:
count = await worker          # also: await worker.task / await worker.result()
# worker.cancel(); worker.done; worker.cancelled; worker.exception()
```

The entry receives the owning interpreter’s root runtime, not a local child runtime. Here “root” is per RLM interpreter: it can belong to a DSH RLM subagent and does not mean only the top-level DSH agent. `timeout=None` is allowed and leaves lifetime bounded by the owning process/agent/bridge; it does not make the worker durable. The optional timeout covers the worker's whole lifetime. Individual background host calls have a 120-second maximum/default deadline.

Authority belongs to the exact admitted `asyncio.Task`. A raw task created inside it does **not** inherit the lease, nor do raw `asyncio.create_task`, program agents, restored tasks, or tasks predating admission. Each call rechecks the live owner and current policy. Fresh root tool dispatch works in effective `native` and `both` presentation modes; effective PTC rejects it rather than bypassing presentation policy.

```python
for outcome in runtime.host_workers.inspect_outcomes():
    print(outcome["invocation_id"], outcome["outcome_unknown"], outcome["reason"])
```

Outcome inspection is bounded, process-live diagnostic state, not a durable inbox or proof of exactly-once effects. Cancellation or transport loss after dispatch can leave an uncertain outcome; do not automatically retry. Retirement can invalidate all handles for that bridge generation and may terminate the entire bridge to fail closed. A generation accepts at most 4,096 worker request IDs; reaching the cap requires a fresh bridge generation and does not replay work.

Local `Runtime.send`/mailboxes are distinct from the guarded DSH orchestration tool named `send_message`, invoked as `await runtime.tools.call("send_message", {...})`. An admitted background worker may call that tool if current policy permits, but it addresses a DSH subagent through the harness—not a local mailbox—and does not create pubsub, durable inboxes, automatic parent wakeups, or DSH-subagent semantics.
