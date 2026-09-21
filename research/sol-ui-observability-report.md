# GUI history/progress and bridge re-entry diagnosis

Date: 2026-04-10

## Executive summary

The observed page was not demonstrably frozen. Two independent UI states can remain visible at the same time:

- **“Loading history…”** is rendered solely while the client Session object's history `openState` is `loading`.
- **“Deep diving…” plus elapsed time** is rendered solely from the Session `running` bit and turn start time. It is a generic turn-level label, not an activity heartbeat.

The child's host-side projection cache continued advancing while both labels were reported (for example, its sequence and Todo projection advanced), proving continuing agent activity. This does not prove that the browser's history stream was healthy; it proves only that the host/control/projection side was alive.

A separate transient `execute_python cannot re-enter its active Python bridge` error has a plausible and source-confirmed AsyncLocalStorage lifetime cause. A narrow source fix and regressions were added in this repository. It is **not loaded in the current harness**.

## Runtime and mode evidence

This delegated child used the direct Harness coding-tool surface (`bash`, `read`, `edit`, `write`, `grep`, etc.). It did not expose `execute_python` and did not provide a Python `runtime` object. Persisted metadata labels the child session with `agentPreset: "rlm"`, while `modelSelection.lastUsed` records `codex/gpt-5.6-sol` at high reasoning effort.

Therefore:

- **Model route:** Sol/high.
- **Actual child execution interface:** Standard-style direct DSH tools, not the root RLM Python controller.
- **Preset metadata:** inherited/recorded as RLM, which is not sufficient evidence that the child is executing through the RLM control plane.

The newly observed untracked `research/rlm-child-mode-bug.md` appears to belong to another concurrent session and was not read or modified.

## Evidence: the GUI was active but history could be independently stalled

The host projection cache at `/Users/tim/.dsh/storages/session_projcache/sessions/ec6b025a-d7d6-4b2b-bef0-9f6e5931c1a0.json` advanced during diagnosis. It contained an open step, changing session statistics, and the current Todo list. That is concrete evidence of host-side activity while the user saw long-running labels.

The installed chat client renders:

- `openState === "loading"` as `chat.loadingHistory` (“Loading history…”).
- `running === true` as `TurnStatus`, whose content is always `chat.deepDiving` plus an elapsed clock after 15 seconds.

`TurnStatus` accepts only the turn start time. It does not consume tool names, Todo transitions, checkpoint stages, last durable event time, pending call metadata, or child-agent activity. Consequently, an increasing clock is not a liveness signal and cannot distinguish model inference, tool execution, checkpointing, a child working, or a stalled turn.

## User reproduction update and revised confidence

The user later closed and reopened the sidebar, and the history/status display returned to normal without a host restart. This narrows the observed incident to a transient client view, retained Session, or subscription/open-generation lifecycle condition. It is not evidence of a persistent agent freeze or a persistent server-side history deadlock. The unbounded first-frame wait below remains a verified robustness gap in source, but it is **not an established root cause** of this sidebar incident.

## History loading path and boundedness finding

The client path is:

1. Retaining a Session calls `Session.open()`.
2. `Session.doOpen()` synchronously changes `openState` to `loading`.
3. It creates `SessionEventStream` and awaits `events.open({ maxMessages: 50 })`.
4. `RemoteJournalStream.open()` awaits the first frame from the reconnecting remote stream.
5. The host `session.follow` route observes the live or persisted Session, builds a page/projection baseline, then yields the opening snapshot.
6. Only after that first frame is accepted does `openState` become `open`.

There is no client-visible opening deadline or slow-history state. A connected remote operation that never produces or rejects its first frame can therefore leave the UI in `loading` indefinitely. Remote failures are mapped to `openState = error`, but a pending promise is not a failure. Non-`RemoteFailure` exceptions in `doOpen` are rethrown rather than normalized into the rendered `openError` state, which is a second path that can leave weak diagnostics.

The available evidence does not localize this occurrence to a specific hop among browser carrier, gateway stream establishment, host `session.follow`, `sessionQuery.observeSession`, or view retention/remount; browser console/network access was unavailable and unauthenticated HTTP requests correctly returned 401. Closing and reopening the sidebar clearing the symptom makes a transient client ownership/subscription path the leading class of explanation, but no exact defect was reproduced.

### PR-ready upstream investigation target

The installed DSH tree at `/Users/tim/.npm/_npx/8cbf92b609fb7f34` contains published bundles only: neither target package includes `src`, tests, or source maps. A pinned upstream checkout was therefore fetched into `.dsh-upstream` at commit `ddefc45fbc7f8e46dd73185e68295696d1297887`. The exact source targets are:

- `packages/api/session-controller/src/client/sessions/session.ts`: `open`, `doOpen`, `dispose`, `resync`, generation ownership, and error settlement.
- `packages/api/session-controller/src/client/sessions/service.ts`: retained view references and opening readiness.
- `packages/api/session-controller/tests/session.client.spec.ts` and `reference-ownership.client.spec.ts`: focused lifecycle regressions.
- `packages/client/ui-chat/src/client/chat/ChatView.tsx`: rendering only after the data-layer behavior is reproduced.
- `packages/client/ui-chat/tests/chat-view.client.spec.tsx`: user-visible error/retry or honest status coverage if the reproduced fix changes presentation.

The next upstream step should first reproduce **open → view release/sidebar close → reopen**, including an opening stream pending or superseded during the release. Assert that stale generations cannot retain or republish `loading`, that fresh acquisition owns one new opening, and that old failures cannot overwrite it. Only after that reproduction should an ownership fix be made. A first-frame deadline, retry control, and richer activity row are separate improvements; the user explicitly deprioritized speculative sidebar expansion, so no upstream code change was made for them.

## Honest current-operation and last-activity visibility (deferred)

The UI should separate **state** from **activity freshness**:

- `Running · model response`, `Running · execute_python`, `Running · waiting for approval`, `Running · child agent`, etc. only when supported by durable/transient event evidence.
- `Last activity 12s ago` from the most recent accepted session event/assistant frame/projection revision—not from a continuously incrementing turn-start clock.
- If the system has only the `running` bit, render `Running · current operation unavailable` rather than implying active “deep diving.”
- Keep history loading status separate: `History loading`/`History unavailable` must not be conflated with agent execution.

Existing useful inputs include durable `step/start`, `tool/call`, `tool/result`, assistant live frames, Session statistics (`openStep`, `pendingCalls`), Todo projection updates, and subagent timing. RLM nested host callbacks currently lack separate durable nested-call records, so the UI must not invent detail for them. A small plugin-owned activity event/projection could later report RLM phases (`executing Python`, `host tool callback`, `checkpointing`) without injecting text into model context, but that is a new observability contract and was not implemented as a side effect here.

This remains a grounded product limitation, but no broad activity redesign was implemented in this timeboxed assignment. A future patch's tests should use a fake clock and establish that:

- an accepted event advances `lastActivityAt`;
- the label reflects only known operation types;
- no event leaves an honest unknown-operation label;
- elapsed turn duration and time-since-last-activity are visually and semantically distinct;
- activity UI never appends model-visible context.

## `execute_python` re-entry diagnosis and source fix

Files changed:

- `project/plugin/src/bridge-client.ts`
- `project/plugin/test/plugin.test.js`

The bridge uses AsyncLocalStorage to prevent true same-bridge causal re-entry: a Python callback that immediately calls `execute_python` on its own busy bridge would deadlock behind itself, so it must fail.

The prior store was a bare bridge key inherited by every async resource spawned while a host callback ran. A callback such as `send_message` can cause independent agent work to start before or around callback completion; inherited context could then falsely identify that later parent execution as synchronous same-bridge re-entry. Once the callback/context unwound, later Python and tools worked again. This explains why the error appeared twice and then cleared without restart. It was not evidence that the previous Python checkpoint batch had deployed or fixed the live bridge.

The source fix:

- stores `{ key, active }` rather than a permanent bare key;
- marks the scope inactive when the direct callback unwinds, so inherited descendants used later no longer retain a false guard;
- exports `outsideBridgeCallbackScope()` so host integrations can explicitly launch known-independent work without inheriting callback scope;
- preserves rejection for genuine direct same-bridge causal re-entry.

Regressions prove all three behaviors: true direct re-entry remains rejected, a later inherited descendant succeeds, and explicitly detached independent work succeeds.

This fix does not redesign mailbox delivery or background host-capable workers (issues 02/03 remain untouched).

## Upstream implementation status

No DSH GUI/session-controller source change was made. The pinned source was inspected and exact PR/test targets were identified, but the user-provided close/reopen recovery evidence arrived before a defect was reproduced and narrowed the request away from speculative robustness/UI work. Consequently there is no upstream patch or upstream test result to overstate. The temporary `.dsh-upstream` diagnostic checkout was removed after inspection and is not a project artifact.

## Validation

- Plugin build/tests: `npm test` -> **22/22 passed**.
- TypeScript no-emit: `./node_modules/.bin/tsc -p tsconfig.json --noEmit` -> exit 0.
- Full Python suite: `.venv/bin/pytest -q` -> exit 0, 117 tests.
- `git diff --check` -> exit 0.
- Existing GUI URL probe: `http://127.0.0.1:3080/` responded **401 Unauthorized** to unauthenticated curl, confirming the host is listening while preventing browser-state inspection through this route.
- Process probe found the existing `dsh web` host and **no `pnpm run dev:web` watcher**.

## Deployment and restart answer

- The prior 04/05/08/H1/13 changes and this re-entry change are **source-only** in `/Users/tim/code/dsh-rlm`.
- The fact that Python/tools began working again without restart is best explained as transient callback scope ending, not deployment.
- The live `dsh web` process imported the built plugin when it started. Building `project/plugin/lib` does not prove that the already-running host reloaded it.
- No `pnpm run dev:web` watcher is active, so client-plugin HMR cannot be claimed.
- If a later upstream DSH patch touches these packages, run the focused package specs, `pnpm run test:gui`, and—because visible assembled output may change—`DSH_SNAPSHOT=replay pnpm run test:web`; then build the affected Web artifacts and refresh the existing URL. Plugin host changes normally require plugin/host reload according to its lifecycle. This session did not restart or replace the server.
- Therefore the user does **not** need a restart merely because the transient error cleared, but a restart/reload is required before expecting the new source fix to govern the live process. Coordinate that deliberately after preserving current work; it was not done here.

## Scope boundaries

No edit was made to `research/review-tracker.md`. No commits, resets, checkouts, stashes, DSH installation modifications, harness restart, replacement server, issue-02/03 implementation, model-context notifications, or broad UI redesign were performed.
