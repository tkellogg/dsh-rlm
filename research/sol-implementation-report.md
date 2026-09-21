# Sol/high first-batch implementation report

Date: 2026-04-10

## Scope and coordination

Implemented only the prepared first batch: 04, 08, 05, H1, and 13. Issue 06's pre-existing typed-alias changes were preserved. The concurrently maintained `research/review-tracker.md` was read at the start and between issue groups but was not edited. No resets, checkouts, stashes, commits, DSH installation changes, harness restarts, live-runtime deployment, Jev integration, broader context-policy work, UI changes, concurrency redesign, measurement work, or selective child-failure notifications were performed.

The working tree already contained the issue-06 edits in `project/python/pyproject.toml`, `project/python/src/dsh_rlm/mailbox.py`, `project/python/tests/test_core.py`, and `project/python/uv.lock`. This batch changed adjacent portions of `mailbox.py` and `test_core.py without overwriting those edits.

## Implemented issues

### 04 — Recovery notice gate

Files:
- `project/python/src/dsh_rlm/bridge.py`
- `project/python/tests/test_bridge.py`

The actual resume path is bridge process creation -> `LocalKernel.open()` -> synchronous constructor restore -> request loop. The bridge now consumes a pending one-shot recovery notice before creating or running the first execute task. It returns a successful, empty cell result plus the recovery notice and no checkpoint; the submitted source is not executed. The next execute can reconsider and proceed. Fresh sessions consume the deliberate `None`, so healthy calls are unchanged and never receive a repeated notice.

The destructive subprocess regression now proves that the first post-crash source cannot set a variable, while the restored value is available and the following request executes normally.

Transport limitation: this is a process-memory one-shot gate, not a durable delivery acknowledgment. The notice is marked taken before the response write is known to have reached or been incorporated by the model. If the response transport fails after consumption, a later bridge restart can reconstruct a recovery notice from the dirty/interrupted marker, but a transport that loses a successfully written response without terminating the process has no explicit acknowledgment/retry protocol. This batch intentionally does not claim exactly-once notice delivery or exactly-once external effects.

### 08 — Quiet routine checkpoint reporting

Files:
- `project/python/src/dsh_rlm/checkpoint.py`
- `project/python/src/dsh_rlm/kernel.py`
- `project/python/src/dsh_rlm/bridge.py`
- `project/plugin/src/protocol.ts`
- `project/plugin/src/index.ts`
- `project/python/tests/test_recovery.py`

The full `checkpoint.skipped` inventory remains in the structured result for inspection. Automatic rendered text now uses transition-only `checkpoint.newly_skipped`, suppressing routine `runtime`, internal-name, and imported-module exclusions. A meaningful user binding that newly becomes unrecoverable is reported once per present transition; if it becomes recoverable and later unrecoverable again, it is surfaced again.

Checkpoint save failures remain in the full `checkpoint.error` status. `checkpoint.notice_error` reports a new/changed failure transition; identical consecutive failures are quiet, and a failure is surfaced again after recovery or after changing to a different failure. The plugin continues to render actionable save failures and does not blanket-hide them.

This is deliberately narrow. It does not create a new global notification policy, UI inspector, or broader durable-state API.

### 05 — Bounded checkpoint worker termination

Files:
- `project/python/src/dsh_rlm/kernel.py`
- `project/python/tests/test_recovery.py`

Checkpoint timeout/cancellation cleanup now sends terminate, waits for a bounded 250 ms grace, escalates to kill, waits for a bounded 1 s reap, and reports incomplete cleanup if reaping still fails. A focused regression installs a SIGTERM-ignoring worker and proves the execute returns within its outer bound, the previous good snapshot remains byte-for-byte unchanged, and worker temporary files are removed.

Snapshot cadence, replay, durable tasks, selected-state policy, and checkpoint budget redesign were not changed.

### H1 — Checkpoint/close ownership race

Files:
- `project/python/src/dsh_rlm/kernel.py`
- `project/python/tests/test_recovery.py`

Worker saves now target a private staged generation rather than the canonical checkpoint. Only the owning kernel publishes that file, after validating its ownership generation and open/allowed-close state. `close()` increments the ownership generation before cancelling active execution, so an in-flight execute checkpoint cannot publish afterward. Cancellation is explicitly re-raised rather than converted into a checkpoint report. Worker cleanup is bounded and settled before the session lock is released.

The deterministic regression blocks a checkpoint worker after a cell mutation, calls close during that checkpoint, verifies the execute remains cancelled, verifies the previous good checkpoint bytes are unchanged, verifies temporary generation/report files are gone, and then reopens the session to prove only the good value restores.

Final orderly close still performs its own allowed-close checkpoint under the new generation when no active execution was interrupted.

### 13 — Mailbox cleanup

Files:
- `project/python/src/dsh_rlm/mailbox.py`
- `project/python/tests/test_core.py`

Explicit close still unregisters the mailbox from live lookup and still permits queued messages to drain while the owner run remains alive. It no longer removes the mailbox from the owner's cleanup set. Run finalization therefore visits previously closed mailboxes and discards any queue remainder before removing ownership.

The focused regression queues two payloads, explicitly closes, drains one during the live run, observes the second still queued, closes the owner, and verifies the pending queue is discarded and ownership removed.

## Validation evidence

All commands used the checkout's existing local environments; no runtime was restarted or deployed.

- Full Python suite: `.venv/bin/pytest -q` -> exit 0, 117 tests collected/passed.
- Focused Python suites during development: core, checkpoint, recovery, and bridge tests -> exit 0 after fixes.
- Plugin suite: `npm test` -> exit 0, 20/20 tests passed; this includes the TypeScript build.
- TypeScript no-emit: `./node_modules/.bin/tsc -p tsconfig.json --noEmit` -> exit 0.
- Python syntax compile: `.venv/bin/python -m py_compile src/dsh_rlm/*.py` -> exit 0.
- `git diff --check` -> exit 0.
- Ruff was not installed in the project virtual environment. The documented `uv` route could not run under this delegated session's workspace-only sandbox because uv attempted to read `/Users/tim/.cache/uv/sdists-v9/.git`; approval/escalation was disabled. This is a tooling limitation, not a test failure.
- A combined `npm test && npx tsc ...` command ran and passed all plugin tests first, then exited 1 because `npx` attempted to write a root-owned global npm cache. The same TypeScript no-emit check was immediately rerun through the checked-in local binary and passed.

## Residual risks and open questions

1. Recovery notice delivery lacks durable transport acknowledgment, as described above. The source gate prevents execution before response generation, but cannot prove model receipt after an ambiguous transport outcome.
2. The checkpoint worker process uses `fork`, matching existing behavior and supported tests. Kill/reap is bounded; a theoretical OS-level unreapable process is reported but cannot be made safe for lock release by Python alone. The normal SIGTERM-resistant case is covered and reaped.
3. `newly_skipped` and `notice_error` are live-kernel transition state; their deduplication state is not persisted across process restart. Recovery itself provides the restart transition notice and full restored/skipped detail.
4. Full checkpoint inventory is queryable in the existing structured execute result (`checkpoint.skipped`), not through a new history/UI API. UI/observability is explicitly deferred. Relevant existing integration observation: the plugin currently exposes only the final rendered execute result and structured tool output; this batch did not add progress/activity events for long-running checkpoint or implementation work.
5. Issue 06 remains dependent on Pydantic >=2.11 as already recorded; this batch preserved it and the full Python suite covers it.

## Deferred/blocked and next-step readiness

No approved first-batch item was blocked by an undecided contract. All five prepared items are implemented in source and regression-tested.

Issues 02 and 03 were intentionally not implemented. Before starting them, the design still needs to honor the tracker requirements:

- **02 mailbox delivery:** choose and implement the host bridge from driver mailbox admission to DSH steer/followup/inject, including bounded admission, live-owner checks, truthful rejection when unavailable, busy/idle semantics, parent reply delivery, inject wake behavior, and acceptance/completion races.
- **03 background host-capable workers:** define fresh per-invocation host ownership after the originating cell ends, including policy/permission snapshot rules, cancellation and deadlines, accounting/effect identity, parent-run shutdown, and explicit non-replay of uncertain external effects. It must not reuse stale cell callback authority.

The repository is ready for focused design/implementation of 02/03 once those host-integration contracts are settled. Observability/UI responsiveness was separately identified as the priority after this batch, but remains untouched here per scope.

## Deployment status

Source-only. The live DSH harness was not modified, rebuilt, restarted, or hot-reloaded. No runtime-deployment claim is made.
