# RLM child execution-mode implementation

Date: 2026-04-10

## Result

RLM-parent delegation now defaults to actual RLM execution for in-process DSH children. The change is plugin-local: no upstream DSH patch is required for the pinned `0.1.6-alpha.2` / `ddefc45fbc7f8e46dd73185e68295696d1297887` integration.

This is source-only. It has not been deployed into, reloaded by, or verified against the currently running GUI/host.

## Root cause

Pinned upstream already implements child preset inheritance correctly:

- child session metadata records the parent's live composed preset;
- fresh and resumed in-process children join the parent's preset composition;
- child route/model/reasoning effort resolution is independent of preset inheritance;
- continuable materialization uses the same child composition on create and resume;
- parent ownership, depth, delegated permission policy, cancellation, and continuation activation remain in the upstream subagent path.

The mismatch was introduced by this plugin after that inheritance:

- `project/plugin/src/policy.ts` treated only `ctx.agents.roots()` as RLM, removed `execute_python` from every child assembly, and omitted RLM controller guidance for children.
- `project/plugin/src/index.ts` rejected `execute_python` unless the executing agent was a runtime root.
- Child metadata therefore truthfully said `rlm`, while the plugin deliberately forced a Standard-style effective interface.

The matching upstream source was temporarily cloned at the pinned commit for inspection and removed afterward. The installed npm checkout remains compiled-package-only and was not edited.

## Exact implementation

### Effective-mode decision

`project/plugin/src/policy.ts` now determines RLM mode from the live agent's canonical composed preset:

```ts
agent.ctx.get('agentPresets')?.composedPreset(agent.ctx) === 'rlm'
```

The same predicate governs both model-visible policy and tool assembly. Every effectively RLM-composed agent, root or child, receives the RLM controller prompt and only `execute_python`. Non-RLM agents continue to have `execute_python` removed. Diagnostics without an agent remain unchanged.

This avoids trusting stale header/projection metadata and does not infer mode from model provider, model id, reasoning effort, or lineage.

### Per-child control plane and identity

`project/plugin/src/index.ts` now allows `execute_python` for an exact live registered RLM agent, not only roots. It requires both `ctx.agents.get(owner.id) === owner` and the same shared canonical `isRlmAgent(owner)` predicate used by prompt/tool assembly. A stale, disposed, foreign, Standard, or RLM-to-Standard-switched agent is rejected before bridge lookup or spawn.

The existing `BridgePool` already keys bridges by the exact agent/session id and derives a case-safe full SHA-256 state namespace. Consequently each RLM child gets its own persistent Python subprocess and checkpoint directory; parent and sibling state remain isolated. Calls within one agent remain serialized. Disposal and preset change continue retiring that agent's bridge.

No shared interpreter, fake prompting layer, bridge alias, or route coupling was added.

### Preserved safeguards

The implementation leaves these existing paths intact:

- upstream child ownership, delegation depth, permission inheritance, approval pinning, cancellation, and continuable create/resume;
- independent provider/model/reasoning-effort inheritance and per-child override behavior;
- guarded Python callbacks and denial of recursive `execute_python` / `subagent_fork` through `runtime.tools.call`;
- AsyncLocalStorage true same-bridge causal-reentry rejection;
- per-agent bridge serialization, cancellation, retirement, checkpointing, and recovery behavior.

Explicit subagent APIs do not currently expose a mode/preset override. Existing upstream behavior is to inherit the parent's effective preset; this patch does not invent a broad new override API.

## Existing versus fresh children

- **Fresh RLM children after deployment:** inherit the parent's RLM composition and receive the real `execute_python`-only execution interface.
- **Continuable children activated/resumed after deployment:** upstream re-composes them from the live parent during materialization, so they receive the new effective RLM policy when newly activated under the updated plugin.
- **Already live children at deployment/reload:** do not claim migration. Their current assembled/runtime state and old host lifecycle may remain old until deliberately disposed and freshly activated under the updated plugin.
- **Persisted child history:** its `agentPreset: rlm` metadata was already present; deployment changes effective plugin behavior, not past transcript events. Do not rewrite session history.

## Tests added or updated

Plugin tests now cover:

- effective RLM detection from canonical live composition, independent of lineage and Sol route/effort;
- root and child RLM agents both receive controller guidance and an `execute_python`-only tool surface;
- Standard agents retain direct tools and cannot see `execute_python`;
- diagnostics remain unchanged;
- the executor accepts distinct live root and child identities and spawns separate bridges;
- stale/non-live owners remain rejected;
- live Standard agents are rejected without spawning a bridge;
- a formerly RLM live agent switched to Standard cannot recreate its retired bridge;
- controller wording is truthful for both root and child RLM agents.

Reviewer follow-up identified and closed two gaps: executor authorization now shares the effective-mode predicate instead of accepting every live agent, and the prompt no longer calls delegated children “root” controllers.

Existing tests continue covering per-agent persistence/isolation, bridge retirement, cancellation, callback barriers, callback denial, route inheritance for `models.complete`, true same-bridge reentry rejection, and the ALS descendant-scope fix.

## Actual validation

Run from `project/plugin` unless noted:

- `npm test` — passed, 23/23 tests after reviewer follow-up.
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit` — exit 0.
- `git diff --check` from repository root — exit 0.

No live GUI, host reload, replacement server, or real delegated child was used. Passing source tests must not be reported as a live fix.

## Deployment and fresh-child verification

1. Preserve the current working tree and review all concurrent alias/checkpoint/recovery/ALS changes together.
2. Build/package the plugin according to its documented deployment procedure.
3. Deliberately reload/restart the plugin host as required; no `pnpm run dev:web` watcher or live reload is assumed.
4. Start a **fresh top-level RLM session** after deployment.
5. Delegate a fresh Sol/low child without a mode override.
6. Verify the child request exposes only `execute_python`, and its RLM controller prompt is present.
7. In the child, execute two cells where the second reads a variable created by the first.
8. Create a sibling child and verify it cannot read the first child's variable; verify the parent namespace is also distinct.
9. Resume/continue the first child and verify its own Python state/checkpoint behavior, without inferring that another child shares it.
10. Verify provider/model/reasoning effort remain the selected Sol/low values and are not changed by RLM mode.
11. Verify a Standard-parent child still receives the Standard direct-tool surface and no `execute_python`.
12. Verify cancellation/disposal retires only the targeted child's bridge, and a later fresh activation uses the child's own identity.
13. Verify a Python callback attempting same-bridge `execute_python` still fails, while independent child bridges can run concurrently.

## Remaining limitations

- There is no live deployment evidence in this session.
- The plugin-level unit fixtures establish effective policy, executor authorization, and bridge identity. They do not establish a live child's actual joined scope, cold-resume behavior, or a provider/model/effort route matrix. Pinned upstream source inspection establishes the intended child composition/resume wiring, but deployment verification remains required. A future PR may add a real-composition integration test that boots the full preset plus in-process spawn/continuation stack; this repository does not vendor that upstream test harness.
- Existing already-live children require deliberate recreation/reactivation; no hot migration mechanism was added.
- External/provider-managed subagent implementations that do not create in-process DSH agents are outside this plugin's inherited-preset execution path.
