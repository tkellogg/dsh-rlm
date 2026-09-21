# Issues 09/14 inspection implementation report

Date: 2026-04-10

## Result

Issues 09 and 14 now have usable, on-demand runtime inspection without automatic model-context traffic. Controller code can inspect state and managed tasks directly inside Python; no bridge protocol round trip is required.

## Implemented

### Live and durable state

- `runtime.inspection.state(offset=..., limit=...)` returns bounded live-name metadata, the last successfully published durable snapshot, and the latest checkpoint-attempt status separately.
- Durable metadata includes checkpoint identity, creation time, byte count, and independently bounded saved/skipped sections with totals and truncation flags.
- State semantics are conservative: `snapshot_contains_name` means only that a name appeared in the published generation. `current_value_matches_snapshot` remains `unknown`; live mutation is never misrepresented as durable equality.
- A skipped value remains live and inspectable. Skipping never implies deletion or rollback.
- Failed checkpoint attempts do not erase the retained identity/inventory of the preceding successful generation.
- Live and durable display names/reasons are bounded with explicit truncation markers. Namespace names must be exact built-in strings, avoiding string-subclass hooks.
- Inspection rejects a closed or non-authoritative kernel.

Public use:

```python
state = runtime.inspection.state(limit=100)
state.live                 # bounded live namespace metadata page
state.durable              # last successful snapshot identity/inventories
state.last_attempt          # most recent checkpoint attempt status
```

### Managed task visibility

- `runtime.inspect_live_tasks(offset=..., limit=...)` returns a separate immutable page of directly owned live children.
- `runtime.inspect_tasks(after=..., offset=..., limit=...)` returns bounded terminal history for directly owned children, including completed, failed, cancelled, interrupted, and unknown outcomes.
- The terminal ring has a fixed capacity, monotonic sequences, and explicit `evicted_through`, oldest, and newest sequence metadata so retention gaps are visible.
- Owner filtering is applied across the complete retained ring before pagination; a busy sibling cannot hide an owner's retained record merely by occupying the first page.
- Full task and parent identity strings are retained exactly for authorization/filtering. Human-facing names and error summaries are bounded separately. This intentionally trades bounded display size for exact internal identity semantics.
- Managed child failures are summarized before re-raising, without retaining results or tracebacks. Exception metadata extraction uses safe base descriptors, omits unsafe metadata, and is fail-safe: metadata recording cannot replace the original exception.
- Cancellation before child execution begins is recorded terminally.
- Status and inspection do not call `Task.exception()` and do not mark failures observed.

Public use:

```python
live = runtime.inspect_live_tasks(limit=100)
terminal = runtime.inspect_tasks(after=last_sequence, limit=100)
```

Both calls require the current runtime to remain authoritative. Live and terminal records are separate so live pagination does not distort terminal sequence/eviction semantics.

### Raw REPL asyncio tasks

- `PersistentREPL.inspect_tasks(...)` exposes bounded running and retained terminal metadata for arbitrary cell-created asyncio tasks.
- Arbitrary completed tasks are honestly represented as `terminal_unknown` unless cancellation is known. Public asyncio APIs cannot reveal an exception without retrieving it, so inspection does not guess or alter observation state.

### Noise and behavior boundaries

- Inspection is read-only and never acknowledges a failure.
- No automatic per-completion response, failure spam, idle wakeup, subscription policy, task replay, effect replay, UI behavior, deployment, or auto-compaction was added.
- The driver-managed mailbox delivery and driver-scope binding changes in the shared runtime were preserved.

## Reviewer corrections incorporated

1. Safe exception metadata extraction cannot invoke hostile metaclass/name/string hooks or replace the original exception.
2. Custom `args` access cannot replace the original exception; unsafe messages are omitted.
3. Pre-start cancellation receives a terminal record.
4. Owner filtering precedes pagination across the complete retained terminal ring.
5. Public owner/cursor/offset/limit inputs are validated.
6. Full task and parent identities are preserved; bounded aliases apply only to display metadata.
7. Managed live children have a separate bounded immutable page and concrete integration tests.
8. Million-character namespace/checkpoint display names and reasons are bounded with explicit truncation.
9. Closed/non-authoritative state inspection is rejected.
10. Managed-live child names and latest-attempt errors are bounded to 512 characters with explicit truncation, while task identities remain exact.

## Validation

Final focused integration command:

```text
.venv/bin/pytest -q tests/test_core.py tests/test_repl.py tests/test_recovery.py tests/test_inspection.py
```

Result: **93 passed**, exit 0.

Dedicated inspection suite: **15 passed**, exit 0.

Additional checks:

- `.venv/bin/python -m py_compile src/dsh_rlm/*.py` — exit 0.
- `git diff --check` — exit 0.

The earlier report of 85 focused tests and an unrelated full-suite Issue 01 failure is superseded by this final focused evidence. No claim is made here about concurrently changing source outside Issues 09/14.

## Limitations and pending items

- Raw `asyncio.Task` awaiting remains observation-ambiguous. The existing task API is preserved; inspection never infers that a raw await handled a failure.
- The terminal record's `observed` flag means only an explicit managed-handle retrieval hook, if one is added later. Mere inspection and raw-task awaiting do not change it.
- Terminal history is bounded in-memory state, not checkpoint-durable. Task results, tracebacks, running tasks, mailboxes, and execution are not made durable.
- Exact retained identities can be longer than display budgets because truncating authorization/filter keys would be incorrect. Returned display names, managed-live names, checkpoint errors, and summaries are bounded instead.
- A shared ring still permits noisy siblings to cause global eviction, but owner visibility is correctly filtered and eviction counters expose possible gaps.
- Name membership does not establish current-value equality with the durable snapshot.
- Bridge protocol exposure is unnecessary for controller-side runtime use and was not added. A future external inspector/UI may add a protocol endpoint without changing these semantics.
