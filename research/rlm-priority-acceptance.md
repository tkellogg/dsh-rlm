# RLM priority batch acceptance ledger

## Accepted source milestones

| Priority | Implemented | Evidence and boundaries |
|---|---|---|
| 01 | Compact tool discovery, selected schemas and bounded retained-value inspection | Independent adversarial review; 8 focused tests. Live reachability is not checkpoint durability; full mapping scans remain size-dependent. |
| 02 | Real driver inbox admission instead of a fake local queue, exact driver binding, host pressure ceiling | Independent review; 5 Python + 8 faithful host-boundary tests. Admission is not processing. No booted full AgentLoop persistence proof. Driver mailbox path still requires active cell. |
| 03 | Explicit task-bound host workers with post-cell fresh tool/model invocations, cancellation, lifetime and retirement | Independent Python/TS source review; 3 real cross-language integrations; explicit replay/saturation and quarantine regression tests. Native/both supported, effective PTC native calls fail truthfully. |
| 09/14 | On-demand state, managed-live and terminal task inspection with bounded history | Independent review and malicious-value/long-ID regressions. No automatic failure notifications; raw asyncio observedness unknown. Snapshot name membership is not value equality. |

## Final independent parent validation

- Full Python suite: **153 passed**, exit 0.
- Plugin build and full suite: **51 passed**, exit 0.
- TypeScript no-emit check: exit 0.
- Three real TypeScript/Python subprocess integrations prove post-cell list/tool/model calls without another pending execute, worker lifetime expiry, and owner disposal aborting an in-flight real tool exactly once.
- Replay regression waits for the first completed result before resubmitting the same ID. Saturation regression verifies 4096 dispatches and rejects request 4097 before dispatch.
- Existing aliases, recovery gate, checkpoint/ownership fixes and RLM-child mode inheritance were preserved. No installed bundle or live service was modified.

## Operational limits

Workers are process-live, not crash-resumable. `runtime.host_workers.spawn(entry, name=None, timeout=None)` grants only the admitted task host authority; raw descendants do not inherit it. Optional timeout bounds whole-worker lifetime. Per-call timeout is capped at 120 seconds. Native/both tools use fresh normal policy dispatch; effective PTC rejects native worker calls. No automatic retry or exactly-once external-effect guarantee exists.

Worker IDs are never reused within a bridge generation. A 4096-request cap fails closed; retirement invalidates old worker handles and can terminate the interpreter bridge. Cancellation-resistant operations retain dispatcher-wide permits until actual settlement. Cancellation/retirement outcomes are bounded process-live diagnostics, not a durable ledger. Root or uncertain-admission retirement intentionally closes the protocol generation to revoke host leases.

## Outputs and deployment handoff

- [Runtime cookbook](../docs/rlm-runtime-cookbook.md)
- [Build/install instructions](../project/plugin/README.md)
- [01 report](issue01-context-inspection.md)
- [02 report](issue02-delivery-implementation.md)
- [03 host report](issue03-background-authority.md), [Python report](issue03-python-workers.md), [real integration evidence](issue03-integration-evidence.md)
- [09/14 report](issue09-14-inspection-report.md)

User handles deployment: rebuild the plugin, ensure the configured Python interpreter imports this updated package, then reload/restart the existing harness using the normal deployment process. No replacement server, live restart, or deployment was performed. After deployment verify a fresh RLM child and an explicitly admitted worker operating after its originating cell returns. Cold resume and live service-specific behaviors remain deployment acceptance checks.

Issue 15 auto-compaction is source/test accepted: RLM inherits shipped Standard compaction and the installed pruner has safety-edge coverage. Live root/child/recovery `/compact` acceptance remains pending. No pubsub/channel, GUI, provider allowlist, benchmark, or automatic wakeup redesign is included.
