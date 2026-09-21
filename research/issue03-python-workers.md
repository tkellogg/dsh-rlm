# Issue 03 Python host workers

Implemented the Python half of the frozen explicit worker protocol. `runtime.host_workers.spawn(entry, name=None, timeout=None)` admits through the active execute parent before creating an explicit local task. Lease authority is associated with the exact `asyncio.Task`; inherited context does not authorize descendants.

The process-live bridge transport multiplexes strict admit/invoke/cancel/release frames independently of execute responses, bounds in-flight requests and tombstones, validates mixed integer/string lease fields, and preserves `effect_id` plus `outcome_unknown`. Cancellation sends a best-effort host cancel while preserving `CancelledError`, and records a bounded runtime-local uncertainty snapshot. These snapshots survive transport detachment but are neither checkpointed nor crash-durable.

Worker cleanup has one idempotent lease owner. Admission and release tasks are bounded, explicitly cancelled and drained, including create-task and pre-start failures. Root retirement and uncertain admission poison the protocol connection because wire v1 has no run-revoke frame; EOF provides the authoritative host-side all-leases fence.

Dedicated unit and subprocess tests cover exact-task fail-closed behavior, post-cell independent tool invocation, strict error metadata, lease release, admission scope, retained read-only outcome snapshots, withheld admission/release cancellation with drained task registries, and bounded subprocess reads with guaranteed terminate/kill/reap cleanup. Existing callback tests remain passing. The focused Python suite reports 13 passed, Python compilation passes, and independent source lifecycle review accepted the implementation.
