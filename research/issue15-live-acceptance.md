# Issue 15: live compaction and RLM continuity acceptance

## Scope

Run this recipe only after the reviewed plugin has been built, deployed, and the existing DSH host at `http://127.0.0.1:3080` has been refreshed. It checks the deployed root and continuable-child paths without generating a huge prompt or intentionally killing a bridge. It does not replace deterministic fixture tests for threshold arithmetic, retention bounds, durable replacement, or retry counts.

The RLM preset inherits DSH’s compaction implementation. Do not patch or fork upstream compaction to perform this check.

## Preconditions

- Preserve any valuable work and use disposable sessions.
- Confirm the displayed agent preset is RLM and the effective tool surface exposes `execute_python`, not the Standard direct-tool catalog.
- Record the root session ID and each child session ID shown by the GUI.
- Use `/compact` to force compaction. Do not inflate the transcript to the automatic threshold.
- For restart coverage, use only the ordinary user-controlled DSH stop/start procedure. Do not kill the Python subprocess independently, delete checkpoint state, or simulate a crash in a valuable session.

## A. Root manual compaction and Python-state continuity

1. In a fresh root RLM session, run an `execute_python` cell that assigns a distinctive serializable sentinel, for example `issue15_root = "root-<nonce>"`.
2. In a second cell, read the sentinel and enumerate matching global names. Record the value.
3. Invoke `/compact` while the agent is idle. Wait for the command to finish; do not submit another turn concurrently.
4. Inspect the GUI trajectory/history. Require a completed compaction with a summary and no stuck in-progress marker or turn error.
5. Ask the controller to rediscover the value from Python state, explicitly instructing it not to answer from remembered prose. It must call `execute_python` and read `issue15_root` from globals.
6. Confirm the post-compaction effective system/controller contract is still RLM and the model-facing tool catalog is still exactly the intended RLM surface.

**Pass:** `/compact` completes; the next turn uses `execute_python`; the exact sentinel is read from the persistent interpreter; controller guidance/tool surface remains RLM; the session remains usable.

**Fail:** compaction hangs or errors, controller/tool policy disappears, a new empty interpreter is silently substituted, the sentinel is answered only from transcript text, or the next request fails from unbounded context.

## B. Fresh child after parent compaction

1. After A, create a fresh continuable child through the normal subagent UI/tool path.
2. Verify its displayed session ID differs from the root and its effective interface is RLM (`execute_python` available; direct Standard tools not exposed).
3. In the child, set `issue15_child = "child-<nonce>"`, then read it in a later child cell.
4. Verify the child cannot read `issue15_root` unless it was explicitly sent as message content. Back in the root, verify `issue15_child` is absent from root globals.
5. Invoke `/compact` in the child while it is idle, then have it rediscover `issue15_child` through `execute_python`.

**Pass:** fresh child inherits the deployed RLM composition, owns isolated persistent Python state, and retains that state across its own manual compaction.

**Fail:** child receives a Standard tool surface despite RLM metadata, shares root state, loses its sentinel, or child compaction affects the root bridge/state.

## C. Resumed continuable child

1. Let the child finish or become idle through normal controls. Close/reopen the session view or continue it through the supported continuation action; do not terminate its bridge manually.
2. If cold-restart coverage is required, perform the documented user-controlled host shutdown and restart, then refresh the existing GUI and resume the same child session.
3. Verify the resumed child has the same persisted child session identity, is recomposed as RLM, and uses `execute_python`.
4. Ask it to enumerate globals and read `issue15_child`. Confirm root and sibling state are still isolated.
5. Invoke `/compact` once more only if the resumed child is idle; verify another subsequent Python read succeeds.

**Pass:** the supported continuation path restores/reuses the child’s own checkpointed namespace and RLM policy; no stale task/handle is represented as live.

**Fail:** continuation materializes as Standard, attaches another session’s bridge, loses recoverable child variables, claims old handles are valid, or cannot compact while otherwise idle.

## D. Recovery and uncertain-effect notice visibility

This case requires a naturally available interrupted/recovered disposable session or a purpose-built test fixture that writes the documented recovery metadata. Do **not** manufacture uncertainty by killing a live bridge or repeating an external effect.

1. Resume the disposable session through the supported host/session restart path.
2. Submit a harmless sentinel source that would be visibly detectable if executed, such as assigning a new local variable with no external effect.
3. Observe the first bridge response. It must be a recovery-only response: the submitted source is not executed, and a bounded `<runtime_recovery>` notice is visible in the `execute_python` result.
4. Require the notice to say that prior tasks, mailboxes, and handles are invalid and, when the fixture records an uncertain external effect, to say that the effect must be checked rather than blindly retried.
5. On the next turn, have the controller acknowledge the notice, inspect relevant state, and only then execute a harmless Python read. Confirm the recovery notice is not emitted a second time.
6. With a purpose-built fixture, include very large stdout in the same rendered tool result. After DSH tool-result pruning, require the recovery warning to remain in the retained head and checkpoint/uncertainty diagnostics to remain in the retained tail, with the fixed middle-pruned marker between them.
7. Once recovery is acknowledged and the session is idle, invoke `/compact`; verify later model-visible history still contains the safety-relevant recovery conclusion (direct retained tool-result text or faithful summary) and Python rediscovery still works.

**Pass:** recovery is shown before any submitted source executes, safety/uncertainty language is model-visible, large-output pruning preserves its head/tail placement, the notice is one-shot, and later compaction does not cause an unsafe blind retry.

**Fail:** source executes before warning delivery, warning exists only in hidden metadata/UI, pruning removes the safety warning, notice repeats indefinitely, or the controller retries an uncertain effect without verification.

## Evidence to retain

For each case save: session/child IDs, timestamps, the compaction lifecycle rows, the exact `execute_python` result containing recovery text, pre/post tool catalogs, and sentinel reads. Redact secrets. Report source tests and live deployment observations separately.

## Determinism and known injection gap

Manual `/compact`, fixed sentinels, and checkpoint fixtures make the state assertions repeatable, but this GUI recipe remains partly probabilistic because real model output may summarize or act differently. Automatic 80% threshold crossing, exact retained-token bounds, overflow retry count, and uncertainty rendering under huge outputs belong in deterministic unit/integration fixtures with a fake model, fixed token meter, and tiny context window.

The workspace plugin cannot resolve the compaction packages from its own dependency tree because they are not plugin dev dependencies. The portable local acceptance test instead finds the `dsh` executable on `PATH`, resolves its real entry point, and resolves `@deepseek-ai/dsh-compaction-tool-result-pruner` relative to that installed application; it therefore exercises the actual installed implementation without pinning an npm-cache path. This test requires `dsh` on `PATH` with that package installed. `@deepseek-ai/dsh-compaction-basic` and `@deepseek-ai/dsh-agent-loop-testkit` remain unavailable to workspace-local package resolution, so full loop acceptance still needs a dedicated dev dependency/upstream testkit or the forced live smoke above.
