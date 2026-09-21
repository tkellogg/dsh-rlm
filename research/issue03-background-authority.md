# Issue 03 — background host authority diagnosis and integration plan

Date: 2026-04-10  
Phase: read-only diagnosis and PR-ready design; shared runtime/bridge/protocol implementation intentionally pending coordination

## Scope and constraints

This phase inspected the workspace and the pinned installed DSH declarations/source read-only. It did not edit shared Python or TypeScript runtime, bridge, protocol, tracker, or README files. It did not deploy/restart the host, edit the installed bundle, use the GUI, implement issue 15, add a scheduler, or add execution replay. The only workspace output is this report.

“Worker” below means an ordinary local Python `asyncio.Task` in the persistent interpreter. It is not a persistent DSH subagent. A DSH subagent has an independently owned agent loop/session and existing host lifecycle; granting host operations to a local task must not impersonate that abstraction.

## Reproduction and root cause

The repository already contains a focused reproduction at `project/python/tests/test_host_callbacks.py:145-173`:

1. one execute cell creates an `asyncio` task;
2. the task waits on an event and therefore survives the cell;
3. a later cell releases and awaits it;
4. its `runtime.tools.list()` fails with `UnsupportedOperationError`.

This is not loss of the Python task. The REPL explicitly permits tasks to remain scheduled after a cell (`project/python/src/dsh_rlm/repl.py:3-13`). It is loss of the originating cell's callback authority, by design:

- `_bind_host_callbacks()` creates a ContextVar scope inherited by descendant tasks, then marks the shared scope inactive and closes its callback in `finally` (`runtime.py:393-407`). `_invoke_host_callback()` rejects missing, foreign, or inactive scope (`runtime.py:105-114`). Keeping that object active would extend a stale cell lease.
- `_CellCallbacks` correlates every callback to one execute request ID and revokes/cancels all outstanding IDs when the cell ends (`bridge.py:654-718`, `bridge.py:815-868`).
- The TypeScript bridge has exactly one `PendingResponse`. It accepts callbacks only during that execute, requires `parent_id` to equal the pending request ID, rejects callbacks after the final response, and treats frames with no pending response as unsolicited protocol failure (`bridge-client.ts:250-345`).
- `HostCallbackExecution` captures the original `ToolRunContext`: its agent, signal, opaque parent token, root call ID, deferred-context sink, turn-conclusion sink, and sequence (`host-callbacks.ts:17-71`). Nested tool calls use the stale `outer.token` as `parent` (`host-callbacks.ts:98-125`). This context is valid only for the outer `execute_python` invocation.

Thus both sides correctly reject stale authority. The fix must introduce a new authority path, not relax those guards.

## Recommended contract: run-owned, invocation-fresh leases

### 1. Separate cell and background leases

Keep `host-callback-v1` and all current cell behavior unchanged. Add a separately negotiated background capability/protocol (suggested name `host-background-v1`). Authority is **explicitly admitted**, not inherited by every arbitrary `asyncio.create_task`.

Proposed Python API for the first milestone:

```python
worker = await runtime.host_workers.spawn(entry, name=None, deadline=None)
# entry receives/uses the ordinary runtime API; worker is awaitable/cancellable
```

`spawn()` must be called by the authoritative root runtime while an active cell lease exists. Admission asks the host to mint a process-live worker lease bound to the exact live agent and current bridge generation, then starts one tracked local asyncio task with that lease in its ContextVar. Plain `asyncio.create_task`, `runtime.spawn` local children, restored tasks, and tasks predating admission retain no background host authority. The admitted lease may authorize multiple fresh invocations by that one worker until worker/run cancellation, but contains only a non-secret lease ID/run reference plus worker ID—never a DSH `ToolExecutionToken` or cell callback closure. Do not expose a general “bind this arbitrary task” operation. Capacity, worker deadline, and admission policy are checked before the cell returns; host retirement independently revokes the lease.

At every admitted worker's `runtime.tools.*` or `runtime.models.complete` call:

1. Python allocates a monotonically unique invocation ID scoped to the live bridge generation and emits a background invocation frame.
2. Host resolves the currently registered bridge owner by exact agent identity and generation.
3. Host checks `ctx.agents.get(id) === capturedAgent`, current RLM eligibility where applicable, and current capability/policy. Disposal, replacement, preset change, or bridge retirement rejects the invocation.
4. Host creates a fresh invocation-owned abort controller and absolute deadline, fused with the run/agent-retirement signal. The expired cell signal is not included.
5. Host performs exactly one operation and returns exactly one terminal result. No transport or host layer automatically retries it.

The run reference is identification/correlation, not authorization. Authorization is newly derived on each host invocation.

### 2. Fresh tool ownership and policy

For background `tools.list`, call `ctx.tools.schemas(liveAgent)` at invocation time and continue filtering `execute_python` and `subagent_fork`. Never cache a cell-era catalogue.

For background `tools.call`, dispatch through the mode-appropriate fresh host owner described below, always with:

- a fresh, collision-resistant `ToolCallId` derived from bridge generation + worker/invocation identity;
- no originating-cell `rootCallId` or `parent` token;
- in native mode, a fresh root call with omitted `rootCallId`/`parent`;
- in PTC mode, only a genuine parent token minted by a newly admitted worker-dispatch composite and valid for its owned/drained lifetime;
- the exact currently live agent;
- current invocation signal/deadline;
- name/arguments validated by the existing strict protocol.

Run inside `ctx.agents.withInitiator(liveAgent, ...)`, as today, but treat this as attribution only: installed DSH explicitly says it neither proves liveness nor grants authority (`dsh-agent/lib/index.js:351-365`). `ctx.tools.execute` is the public full pipeline: installed source routes through pre-policy, approvals, guards, around-dispatch, post-policy, finalization, and notification (`dsh-tools/lib/index.js:3100-3124`, `3209-3224`). A schema-list result is advisory only; execution must independently pass that pipeline.

**Empirical presentation result:** `project/plugin/test/host-worker-feasibility.test.js` constructs the actual installed `SystemPrompt` and `ToolRuntime` in an isolated Cordis context. A fresh parentless call succeeds in `native` and `both`, resolves `rootCallId` to the new `callId`, and crosses `tools/pre-execute`, `tools/execute`, and `tools/post-execute`. The identical call in `ptc` returns `UNKNOWN_TOOL` before those stages/body. The shipped RLM preset declares no tool-presentation row, while installed `ToolRuntime` defaults to `native`; thus the ordinary default RLM route supports fresh root dispatch without a composite. A host deployment may override the default, so effective PTC must fail truthfully for this milestone. Do not disable PTC, fabricate a parent token, call internal scheduler methods, or retain a composite scheduling slot for the worker lifetime. Future PTC support would require a fresh composite per invocation that obtains a real host token and fully drains before settling, or a public upstream scoped-dispatch API.

Preserve explicit recursive denials and the complete current policy/approval path. In particular, do not clear or spoof the `AsyncLocalStorage` same-bridge causal reentry guard: a host tool synchronously attempting the same bridge must still fail. Independent later work may proceed only after the direct invocation unwinds.

Background calls cannot use the expired `deferContext()` or `concludeTurn()` sinks. Their result should return to the Python future/mailbox and normal tool accounting/event logging. If future product policy needs context injection or turn conclusion, it must be a separately owned host action (likely issue 02), not mutation of an ended tool result.

### 3. Fresh model ownership and accounting

For each background model invocation, re-read the live agent's current request header/options and resolve route, effort, limits, and provider policy at invocation time, then call `ctx.llm.prepareCall` and stream with `sessionId: liveAgent.id`, an invocation deadline, and `tools: []`. Do not inherit the originating cell's route snapshot except as an explicit requested route that still passes current preparation/policy.

Return the existing structured text/provider/model/finish/usage result. The unique invocation ID must be included in host logs/accounting correlation. Provider usage remains authoritative; do not merge it into the ended execute-python call's accounting as though it occurred inside that call.

### 4. Cancellation, shutdown, and deadlines

Maintain one host `BackgroundRunAuthority` per exact bridge client generation, containing the exact owner identity, a run abort controller, bounded in-flight map, invocation sequence/IDs, and (if tools stay serialized) a run-owned serialization tail. It must not contain a `ToolRunContext`.

Abort and reject new work on any of: agent disposal/replacement, preset retirement, bridge termination/EOF/protocol poison, plugin disposal, explicit kernel close, or configured run deadline. Per-invocation deadlines must be absolute/bounded and fuse with run cancellation. Python cancellation sends a best-effort cancel frame for that invocation; host terminal settlement wins races exactly once. Shutdown waits only a bounded grace and then retires transport; cancellation-resistant host implementations must not keep ownership alive indefinitely.

Local `Runtime.close()` already cancels its local children cooperatively (`runtime.py:409-468`). Phase 2 should also revoke run-level background authority when the kernel/bridge closes. This is process-live only: no background task or invocation is resumed after bridge/host restart.

### 5. Effect identity and uncertain outcomes

Every invocation gets an immutable effect ID before dispatch. Host records states such as accepted/running/succeeded/failed/cancelled/**outcome-unknown**. The same ID is never automatically reissued, and a caller-supplied retry is a new invocation/effect ID unless a future tool-specific idempotency contract says otherwise.

If cancellation/transport loss occurs after dispatch and completion cannot be confirmed, return/retain `outcome-unknown`; do not turn it into a safe-to-retry failure. Late results for known cancelled/retired IDs may be tombstoned, but unknown IDs or generation mismatches remain protocol errors. No crash-resumable execution or effect replay is in scope.

## Concrete source/interface requirements for phase 2

Ownership boundaries should be coordinated because the delivery implementer currently owns the shared files:

1. **Python runtime (`runtime.py`)**: add explicit admitted-worker state separately from `_HostCallbackScope`; only `runtime.host_workers.spawn(...)` (or the smaller equivalent `runtime.spawn(..., host_calls=True)`) installs it in the newly tracked worker task. `_invoke_host_callback` may use background invocation only when that exact admitted worker state is present and live. Plain tasks retain current failure. Preserve runtime identity checks and add lifecycle hooks so worker ID and issue-14's bounded immutable terminal registry can record host invocation state without inspection mutation or wakeup.
2. **Python bridge (`bridge.py`)**: add a run-scoped background invoker whose frames are not parented to an execute request; correlate invocation results across cells; accept cancellation; bound in-flight/count/payloads; retire all futures on close/EOF. Keep `_CellCallbacks` unchanged.
3. **Protocol (`protocol.ts` plus Python parser/encoder)**: distinct frame kinds and generation/run/invocation/effect IDs; strict exact-key validation; terminal result and cancel frames; bounded IDs/payloads/in-flight work. Do not overload `parent_id` with a fake cell ID.
4. **TypeScript bridge client (`bridge-client.ts`)**: route valid run-scoped frames even with no `PendingResponse`, while final cell-response logic remains independent; maintain a separate bounded background invocation table and run authority; do not make all unsolicited frames acceptable.
5. **Host dispatcher (`host-callbacks.ts`)**: split cell-owned execution from run-owned background authority. Re-resolve live owner/current policy per call. Root-dispatch background tools without stale `parent`; retain recursive denial and true reentry checks. Define handling of additional contexts/concludes-turn as unsupported for this milestone rather than attaching them to the old execute.
6. **Plugin lifecycle (`index.ts` / pool)**: create authority from exact live agent + bridge generation (not from `ToolRunContext`), and revoke it on every existing retirement/disposal path. The initial execute may register the exact owner, but its token/signal/sinks must not be retained.

The native/both root route is now fixture-validated against installed `ToolRuntime.execute`, including pipeline stages; no upstream API is required for the default native RLM milestone. Effective PTC remains deliberately unsupported unless a separate fresh-per-invocation composite fixture proves the complete policy/approval/accounting contract.

## Dependency and delivery sequence

1. **Host contract gate:** fixture-prove the effective native/PTC paths. In native mode, a fresh parentless call traverses the full pipeline. In PTC mode, a parentless native call must remain denied; only a genuinely registered composite/tool invocation may own nested calls. If no public supported composite can receive calls after admission and drain before settlement, phase 2 requires a small upstream scoped-dispatch lease API—never private scheduler use or token fabrication.
2. **Transport:** add strict admission/invoke/cancel/settle frames and bridge-generation fencing.
3. **Explicit worker API:** add `runtime.host_workers.spawn` (or `runtime.spawn(..., host_calls=True)` if the parent chooses the smaller surface); arbitrary tasks remain unauthorized.
4. **Lifecycle/inspection:** connect bridge, agent, plugin, and worker retirement to bounded draining plus issue-14 immutable records, without wakeups.
5. **Integration and regression tests:** only then claim source implementation; deployment remains separate.

Models share run/worker lifecycle but need no tool parent token: each invocation performs fresh `prepareCall` under the exact live agent/current route and records usage against its invocation. Issue 02 is only a dependency for parent-model delivery/wakeup, not Python-returned worker results.

## Test plan

### Reproduction and positive behavior

- Preserve the existing plain-`asyncio.create_task` expired-cell regression **unchanged even when background capability is negotiated**. Add a separate positive test using the explicit admitted-worker API.
- Cell A creates a gated task and returns. While no cell is active, release it through an independent local timer/task; `tools.list`, a harmless tool call, and `models.complete` succeed. This proves the result is not merely borrowing Cell B's authority.
- Multiple workers invoke concurrently; results correlate by invocation ID and arrive out of order without crossing futures. Tool serialization, if retained, is explicit; models may overlap within bounds.

### Authority and policy

- Change current tool policy/catalogue between task creation and invocation; background list/call observes the new policy, and a newly denied tool fails.
- Replace/dispose the agent or retire its bridge before invocation; exact stale identity/generation is rejected and cannot attach to a new same-ID agent.
- Background `execute_python` and `subagent_fork` remain denied.
- A tool causing synchronous same-bridge reentry still fails; no test helper clears ALS. An independent bridge remains able to run.
- Verify background root tool input has fresh `callId`, resolved root identity, absent stale `parent`, live agent, and fresh signal. Assert old outer token/signal/defer/conclude functions are unreachable.

### Cancellation/deadline/lifecycle

- Cancel a Python worker before dispatch, during host execution, and racing terminal settlement; exactly one terminal state results.
- Parent/kernel close, agent disposal, plugin disposal, EOF, and bridge poison abort in-flight calls and reject later calls within bounded time.
- A cancellation-ignoring host fake cannot prevent bounded bridge retirement.
- No task/invocation survives process restart; recovery reports interruption without replay.

### Effects/accounting

- Each accepted invocation has a unique stable effect ID and one accounting record; model usage is attributed to that invocation/live agent.
- Simulate transport loss after a side-effecting tool accepts work but before its result returns: state is `outcome-unknown`, and no retry frame is emitted.
- A late result for a known cancelled ID is safely tombstoned; an unknown or wrong-generation result is rejected.
- Routine successful worker completion causes no automatic model wakeup. Terminal records are inspectable and bounded with eviction metadata, aligning with the issue-14 inspector design; observation does not mark failure handled or otherwise mutate state.

### Regression

- Existing active-cell callbacks, limits, timeout, revocation, EOF interruption, final-response drain, malformed-frame poisoning, route inheritance, permission checks, bridge isolation, and complete Python/plugin suites pass unchanged.

## Implemented versus pending

Implemented in the workspace: explicit `runtime.host_workers.spawn(..., timeout=...)` admission with exact asyncio task identity; persistent Python worker transport; strict admission/invoke/cancel/release protocol; per-bridge-instance host authority with exact owner and nonce-bound leases; fresh native root tool calls; current-route no-tools model preparation; host-owned capacity/deadline/lifetime cancellation; bounded immutable records and quarantine; post-dispatch uncertainty; bridge retirement revocation; and a real TypeScript-to-Python subprocess test proving a worker remains callable after the execute cell has ended. Plain asyncio tasks remain denied.

Pending: broader direct model-usage accounting assertions and live deployment verification. Independent source review accepted the implementation after the adversarial replay, quarantine-capacity, typed-uncertainty, and lifecycle regressions were added. Dispatcher-wide hard permits now remain held by cancellation-resistant operations across retired bridge generations until underlying settlement, and uncertainty is propagated by a typed per-invocation error rather than inferred from the bounded history ring. No live-fix claim is made.

## Implemented limits and verified evidence

- Explicit workers: 16 default / 64 hard maximum per exact bridge instance; 32 default / 64 hard in-flight calls per authority.
- Dispatcher-wide resistant-operation permits: 64; a quarantined call retains its permit across bridge retirement until the underlying operation settles.
- Per-call timeout: positive integer, at most 120,000 ms. Optional whole-worker lifetime: at most 120,000 ms; `None` remains parent/bridge-owned.
- Worker request IDs: printable ASCII, at most 256 characters, never reusable within one bridge generation. After 4,096 total request IDs the bridge fails closed and a fresh generation is required; old worker handles are invalid and no operation is replayed.
- Terminal records: 256 default / 1,024 hard maximum with explicit eviction count; active/quarantined summaries are bounded by hard in-flight permits.
- Default native and `both` modes permit fresh root tool dispatch through the normal policy pipeline. Effective PTC rejects native worker tool calls with `UNKNOWN_TOOL`; presentation policy is never disabled or bypassed.
- Verified source-only evidence: 51 plugin tests, including three real Python-subprocess tests and deterministic completed-ID replay plus sequential 4,097th-ID saturation guards for post-cell invocation, finite lifetime expiry, and owner disposal during an in-flight tool; 153 Python tests; TypeScript build; and `git diff --check` all passed.

## Limitations

The installed checkout was inspected read-only and never changed. Isolated installed-runtime and real subprocess integration fixtures were run, but no live DSH service or GUI deployment was changed. Effective PTC still rejects background native tool names by design; the implemented default-native route reports that limitation rather than bypassing presentation policy. The implementation is process-live only and does not promise durable tasks, exactly-once external effects, automatic retries, parent-model wakeups, or DSH-subagent semantics.
