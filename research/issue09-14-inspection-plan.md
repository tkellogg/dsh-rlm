# Issues 09/14: bounded state and task inspection plan

Date: 2026-04-10

## Scope and status

This is the read-only inspection/design phase. No runtime, kernel, bridge, task, plugin, tracker, or README source was changed. The only output is this plan. It covers on-demand inspection of live/checkpointed state and local task outcomes. It does not define idle wakeups, subscriptions, automatic replay, auto-compaction, UI behavior, or host-capable worker authority.

## Source findings

### State and checkpoints

`LocalKernel` owns the live `PersistentREPL.globals`, the last checkpoint attempt, and the identity/time of the last successfully published snapshot. A `CheckpointReport` already distinguishes `saved`, complete `skipped`, publication `error`, `checkpoint_id`, and `created_at`. On failed publication, the kernel retains the prior successful identity/time while `last_checkpoint` describes the failed attempt.

The bridge's normal execute response is not a sufficient inspector. It returns checkpoint data only after a successful cell, bounds inventories to its response limit, and describes the most recent attempt rather than explicitly pairing live state with the last durable snapshot. Failed cells can mutate live globals while leaving the prior durable snapshot unchanged. A skipped value remains live; “skipped” must never be rendered as deleted or rolled back.

Checkpoint files are data snapshots, not suspended interpreters. Tasks, mailboxes, runtime handles, imported/runtime-bound objects, and side effects are not made durable. Checkpoint identity/time establishes which generation was atomically published, not exactly-once correspondence between external effects and Python bookkeeping.

### Tasks and failures

There are two distinct populations:

1. managed `Runtime.spawn` children, represented by `AgentHandle` and a child `Runtime`; and
2. arbitrary asyncio tasks created in REPL cells/descendants and tracked by `PersistentREPL`.

Managed children are removed from the parent's `_children` set at completion. No bounded terminal registry exists. `_task_done()` calls `task.exception()` and therefore consumes asyncio's “exception was never retrieved” signal even when user code never awaited the task. `AgentHandle.status()` also calls `task.exception()`. Thus current status inspection is not semantically neutral with respect to asyncio exception observation.

Raw REPL task tracking retains only live tasks: its done callback immediately discards completed tasks. Consequently successful, failed, and cancelled terminal outcomes disappear from inspection. Public asyncio APIs do not offer a non-observing exception peek. A design must not claim full raw-task error capture by calling `Task.exception()`, because that itself marks the exception retrieved.

Expected shutdown cancellation is already normal cooperative lifecycle behavior and should remain quiet.

## Proposed narrow interfaces

Names are PR-ready proposals, not approved API commitments.

### Kernel state snapshot

Add a synchronous, side-effect-free kernel method:

```python
@dataclass(frozen=True, slots=True)
class StateInspection:
    inspected_at: str
    live: tuple[LiveValueInfo, ...]
    durable: DurableSnapshotInfo | None
    last_attempt: CheckpointAttemptInfo | None

@dataclass(frozen=True, slots=True)
class LiveValueInfo:
    name: str
    type_name: str
    durability: Literal["in_snapshot", "not_in_snapshot", "unknown"]
    reason: str | None

@dataclass(frozen=True, slots=True)
class DurableSnapshotInfo:
    checkpoint_id: str
    created_at: str
    byte_count: int
    saved_names: tuple[str, ...]
    skipped: tuple[ValueIssue, ...]

@dataclass(frozen=True, slots=True)
class CheckpointAttemptInfo:
    ok: bool
    error: str | None
```

```python
LocalKernel.inspect_state(*, offset: int = 0, limit: int = 100) -> StateInspectionPage
```

Requirements:

- `limit` has a small hard maximum (suggested 200); names sort deterministically; response includes `total`, `offset`, `returned`, and `truncated`.
- Never call `repr`, serialize values, traverse arbitrary object graphs, or invoke user properties during inspection. Return only name and safe type label from current namespace metadata.
- Compare live names against the last *successfully published* checkpoint report, not merely `last_checkpoint` when it is a failed attempt.
- Preserve the complete successful report in kernel memory separately from the most recent attempt. This is needed because today a failed attempt can replace `last_checkpoint` while `_checkpoint_id` still identifies the previous durable generation.
- `in_snapshot` means that name was present in that published generation, not that the current live value equals the serialized value. Without hashing/serialization, equality is unknowable and must not be implied.
- Names live now but skipped in that generation report are `not_in_snapshot` with the recorded reason. Names created/mutated after publication are `unknown` unless explicitly tracked by a future dirty-name mechanism.
- Internal names should be omitted by the same policy used for checkpoints. No values or value representations are returned by default.

Expose this on demand through a dedicated bridge protocol request (suggested `inspect_state`) rather than attaching it to every execution. The plugin may later expose a guarded Python helper, but the first implementation can be bridge-tested without adding model-visible completion spam. Pagination retrieves omitted inventory explicitly.

### Managed child terminal registry

Put a bounded registry in `_RuntimeState`, because it is shared by the runtime tree and is the natural coordination point for the worker-authority plan:

```python
@dataclass(frozen=True, slots=True)
class TaskOutcome:
    sequence: int
    agent_id: str
    parent_id: str | None
    name: str | None
    state: Literal["completed", "failed", "cancelled", "interrupted", "unknown"]
    started_at: str
    finished_at: str
    error_type: str | None
    error_message: str | None
    observed: bool

Runtime.inspect_tasks(*, after: int | None = None, limit: int = 100) -> TaskInspectionPage
```

Retention contract:

- Record every managed child terminal outcome, including success and expected cancellation.
- Keep a fixed-capacity ordered ring (suggested default 256 per runtime state). Assign monotonic `sequence` numbers.
- Page returns `oldest_sequence`, `newest_sequence`, and `evicted_through`; callers can detect gaps explicitly. Never silently imply an evicted outcome never existed.
- Bound error type/message lengths and sanitize formatting. Do not retain traceback frames or result values in the registry.
- Inspection is read-only and must not change `observed`, clear records, retrieve a task exception, or trigger notification.

Observation contract:

- “Observed” is an explicit runtime semantic, not inferred from calling the inspector.
- Add an explicit handle operation such as `await handle.result()` / `handle.exception()` that marks the registry entry observed after normal propagation/retrieval. Existing direct `await handle.task` cannot be reliably intercepted while preserving a public raw `asyncio.Task`; therefore the first patch must either (a) document `observed` as runtime-handle observation only, or (b) introduce an awaitable managed wrapper and deprecate direct task awaiting. Do not falsely label direct awaits.
- The child execution wrapper should capture bounded exception metadata before re-raising, allowing registry recording without `_task_done()` calling `task.exception()`. `AgentHandle.status()` should consult task cancellation/done state plus registry metadata, not retrieve the exception.
- Recording a failure is not handling it. Unobserved asyncio diagnostics remain available under normal asyncio behavior.

For raw REPL-created tasks, implement only live status plus bounded terminal state (`completed`/`cancelled`/`failed-known`) if it can be captured without retrieving exceptions. Do not expose error details or “observed” for arbitrary raw tasks until a managed task wrapper/factory contract exists. The honest first milestone may label a done non-cancelled raw task `terminal_unknown`; full error inspection is pending.

### Notifications

No automatic per-completion response fields and no idle wakeup are proposed. A later step-boundary aggregator may query unobserved parent-relevant failures and emit one deduplicated bounded notice, but cadence, importance, and idle behavior remain undecided. Inspection itself never acknowledges failures. Expected cancellation is stored for inspection but excluded from notices.

## Exact implementation ownership needed

Parent authorization/coordination is required before edits because these are shared files and overlap the worker-authority plan:

- `project/python/src/dsh_rlm/kernel.py`: retain successful-generation metadata and implement state inspection.
- `project/python/src/dsh_rlm/runtime.py`: bounded managed terminal registry and neutral status semantics.
- `project/python/src/dsh_rlm/repl.py`: bounded live/raw-task inspection only within the non-observation constraint.
- `project/python/src/dsh_rlm/bridge.py`: on-demand protocol requests and bounded summaries.
- `project/python/src/dsh_rlm/__init__.py`: export only approved public models.
- focused tests in `project/python/tests/test_recovery.py`, `test_core.py`, `test_repl.py`, and `test_bridge.py`.

The registry should be designed once with issue 03 so fresh host invocation ownership can attach terminal outcomes to the same parent/run identities. It must not reuse expired cell authority and must never replay effects.

## Proposed tests

### State

1. Successful checkpoint reports exact durable identity/time and paginated saved/skipped names.
2. A live value created after checkpoint is visible but not claimed durable.
3. A failed cell mutates live state; prior snapshot identity remains unchanged and inspection distinguishes the live mutation from durable data.
4. Failed checkpoint attempt reports its error while retaining prior durable identity/inventory.
5. An unsaveable live handle is listed as live and skipped, never as removed.
6. Inspection does not call user `repr`, properties, reducers, or serialization hooks.
7. Pagination is deterministic and advertises truncation/total.
8. Restart restores the named generation and reports tasks/execution as non-durable.

### Tasks

1. Success, failure, expected cancellation, and interruption each create one terminal record.
2. Many outcomes evict oldest records deterministically and expose `evicted_through`.
3. Inspecting a failure twice leaves `observed=False` and does not suppress normal unhandled-failure diagnostics.
4. Explicit handle result retrieval propagates once and marks observed without duplicate notice eligibility.
5. `status()` does not retrieve/handle an exception.
6. Awaited/explicitly retrieved failure is eligible for no additional failure notice; unobserved failure remains queryable.
7. Expected parent-shutdown cancellation remains quiet but inspectable.
8. Raw task completion never disappears silently; where error details cannot be captured neutrally, state is explicitly unknown rather than guessed.
9. No terminal outcome or inspection causes a model step, idle wakeup, or automatic bridge response spam.

## Pending decisions and limitations

- Whether to replace/deprecate public direct `AgentHandle.task` awaiting to make observation exact.
- Whether retention is global per runtime tree, per parent, or both; per-state ring with parent filtering is the narrowest starting point but can let a noisy sibling cause eviction.
- Whether successful results need bounded summaries; this plan deliberately retains no result values.
- Notification importance, batching cadence, and idle behavior are intentionally unresolved.
- Live/durable comparison is name-level, not value equality. Exact equality would require additional bounded fingerprints during checkpointing and is not necessary for the first milestone.
- Raw arbitrary asyncio exceptions cannot be inspected through public APIs without affecting asyncio observedness; the first implementation must expose this limitation rather than bypass it with private task fields.
- No source implementation or tests were run in this phase because shared integration was not authorized.
