# RLM harness review tracker

Living working notes. IDs 01–14 match the user's review list. Proposals are not decisions; accepted direction is not implemented work. Update evidence and acceptance checks when an item changes status.

## Current implementation reconciliation

This section supersedes stale implementation/dispatch labels below without changing open design decisions.

- 04, bounded termination portion of 05, H1, 08, and 13: source implemented with focused regressions; first-batch report records 117 Python / 20 plugin tests at that point. See [first-batch report](sol-implementation-report.md). Broader checkpoint cadence/design remains open.
- 06: alias fix preserved and covered by subsequent suites; minimum-version test limitation remains.
- Recovery gate and quiet routine exclusions were subsequently observed live after user restart. This is not live validation of every destructive lifecycle edge.
- RLM-child mode inheritance: implemented and independently reviewed (23 plugin tests). Fresh deployed Sol/low child exposed execute_python, persisted a value across cells, lacked a named parent variable, and successfully called guarded host tools / messaged parent. Cold resume and broader isolation integration remain unverified. See [implementation report](rlm-child-mode-implementation.md).
- Bridge re-entry hardening: implemented/tested separately; avoid claiming all possible notification races are exhausted. See [bridge/UI report](sol-ui-observability-report.md).
- GUI sidebar symptom cleared on close/reopen; no speculative GUI patch made. Detailed UI work is deferred.
- Current approved implementation: 02 truthful delivery; 03 fresh-owned background host calls; 01 compact discovery/inspection; 09/14 on-demand state and failure inspection. Sol/low workers and independent reviews, source changes only; user handles deployment. Shared-source edits are staged to avoid collisions.
- Current batch acceptance: 01 compact inspection accepted after independent adversarial review (8 focused tests); 02 delivery source accepted after destination/host-ceiling fixes (5 Python + 8 faithful host-boundary tests independently rerun). See [01 report](issue01-context-inspection.md) and [02 report](issue02-delivery-implementation.md). These are source/test acceptance, not live deployment or full AgentLoop persistence proof.
- Current four-priority batch is complete at source/test acceptance: 09/14 inspection and 03 background workers independently reviewed, including lifecycle/replay corrections. Parent final runs: 153 Python tests, 51 plugin tests, TypeScript no-emit/build, and diff check passed. Three real cross-language subprocess tests cover post-cell list/tool/model calls, lifetime expiry, and owner disposal. See [final acceptance ledger](rlm-priority-acceptance.md) for exact limits and deployment checks. User deployment remains pending.
- 15 auto-compaction audit is source/test accepted: RLM structurally inherits shipped Standard compaction, and actual installed-pruner safety-edge coverage passes. No behavior fork was needed. Live root/child `/compact` acceptance remains a user-run deployment check; generic summary injection/semantic omission remains an upstream DSH limitation.

## Baseline: what works

Verified in the initial review:
- Persistent variables, top-level await, and local async progress between cells.
- Local task admission, distinct child identity, mailbox input, and awaited results.
- Active-cell structured DSH tool callbacks and a real no-tools model completion with usage.
- Expired-cell host authority fails explicitly rather than being reused.
- Baseline tests: 101 Python tests, 20 plugin tests, TypeScript no-emit check passed.
- Recovery/checkpoint implementation and tests exist; destructive live-session restart was not tested.

These establish functionality, not production hardening or superiority to Standard mode.

## Index

| ID | Topic | Status | User direction / next action |
|---|---|---|---|
| 01 | Context pollution | Source/test accepted | Compact discovery and bounded retained-value inspection are implemented; validate with deployed large-result workflows. |
| 02 | Python-to-RLM mailbox delivery | Source/test accepted | Driver delivery preserves steer/followup/inject semantics; run live AgentLoop acceptance after deployment. |
| 03 | Background host-capable workers | Source/test accepted | Fresh owned post-cell host calls are implemented; validate live shutdown, expiry, and uncertain-effect behavior after deployment. |
| 04 | Recovery notice timing | Source/test accepted | One-shot pre-execution recovery gate implemented; cold-resume/live transport acceptance remains. |
| 05 | Checkpoints and timeout hardening | Bounded termination implemented; broader design open | Keep snapshot cadence, selected durable state, and budget decisions separate. |
| 06 | Typed mailbox aliases | Source/test accepted | Minimum supported Pydantic version still needs an explicit compatibility run. |
| 07 | Context-aware capability adviser | Design open | Establish a deterministic retrieval baseline and evaluation before adding a model adviser. |
| 08 | Repeated checkpoint warnings | Source/test accepted | Transition-only notices implemented; validate quiet behavior in deployed sessions. |
| 09 | Durable state boundaries | Source/test accepted for inspection | Live/checkpointed/unsaveable inspection exists; explicit durable-state policy remains open. |
| 10 | Concurrency / task demultiplexing | Cookbook direction accepted | Use standard asyncio patterns; extend recipes only when a demonstrated gap appears. |
| 11 | Observability and UI | Design open | Build on existing structured inspection without adding automatic model-context noise. |
| 12 | Measurement | Open, separate workstream | Define and run evaluation before public claims. |
| 13 | Mailbox cleanup | Source/test accepted | Closed queues remain drainable while live and are discarded at owner exit. |
| 14 | Local child failure visibility | Source/test accepted for inspection | Terminal task inspection exists; selective automatic notification policy remains open. |
| 15 | RLM auto-compaction | Source/test accepted | Run live root/child/recovery compaction acceptance after deployment. |
| H1 | Checkpoint/close ownership race | Source/test accepted | Generation-fenced publication and deterministic close-race regression implemented. |

## Remaining work priority (2026-04-10)

1. **P0 — Deploy and run live acceptance.** Rebuild/reload the actual harness, confirm a fresh RLM child, post-cell host worker calls, driver delivery, cold resume/recovery gating, and root/child `/compact`. Source tests cannot establish live AgentLoop wiring or installed-bundle behavior.
2. **P0 — Close lifecycle and compatibility evidence gaps.** Exercise the minimum supported Pydantic version, ambiguous recovery-response transport behavior, owner shutdown with in-flight effects, and permission/preset transitions. Preserve explicit uncertain outcomes; never auto-replay effects.
3. **P1 — Measurement baseline (12).** Define representative Standard-vs-RLM workloads and record outcome quality, latency, token/cost growth, recovery behavior, and worker throughput before making public claims or optimizing further.
4. **P1 — Observability/UI (11).** Expose the existing task tree, host calls, mailbox pressure, checkpoint age/exclusions, and uncertain outcomes in a quiet inspector; do not mirror routine telemetry into model context.
5. **P1 — Durable-state contract (05/09).** Decide checkpoint cadence, size/cost budgets, and whether an explicit selected durable-state container is warranted. Keep data recovery distinct from task replay and external-effect guarantees.
6. **P2 — Capability adviser (07).** First measure deterministic catalogue search/retrieval; add an optional read-only ranker only if it improves recall/cost, validating every recommendation against current authority.
7. **P2 — Selective failure notification (14).** Design deduplicated step-boundary summaries for important unobserved failures only; awaited failures and expected cancellation stay quiet.
8. **P3 — Cookbook refinements (10).** Add concurrency recipes in response to demonstrated user friction rather than introducing a custom scheduler.

## 15 — RLM auto-compaction

**Accepted audit:** automatic model-context compaction is present. The RLM preset’s complete compaction group is structurally identical to shipped Standard: automatic basic compaction, manual `/compact`, and deterministic tool-result pruning. Defaults are an 80% pressure threshold and 16% verbatim-tail retention. No RLM compaction behavior fork is justified. See [source/test audit](issue15-compaction-audit.md) and [live acceptance recipe](issue15-live-acceptance.md).

**Scope:** model conversation/context compaction, distinct from Python checkpointing, garbage collection, or deleting retained evidence. Preserve controller instructions, current task, accessible state/evidence references, pending work and mandatory recovery/effect-uncertainty notices. Do not replay effects or imply live Python state was reset.

**Evidence and boundary:** semantic composition parity and the actual installed upstream pruner are covered by executable regressions; recovery text remains at the retained head and checkpoint/nonrecoverable warnings at the retained tail across a 12,000-character middle. Full plugin suite passes 53/53 and independent review found no blocker. Conversation summaries remain lossy model context—not an authoritative approval, ownership, effect, or Python-state ledger. Prompt injection/semantic omission is a generic upstream DSH compaction risk. Live root/child/recovery behavior is specified as a post-deployment acceptance procedure, not claimed here.

## 01 — Context pollution

**Observed:** broad discovery and raw printed results rapidly fill model context even though Python retains structured results. This happened during the review itself.

**Proposed approach:** separate retained evidence from model-visible summaries. Compact discovery, bounded previews, counts/truncation metadata, stable result references, and explicit expansion. Errors/approvals/recovery changes need a separate reliable path so selective output cannot hide them.

**Open:** whether a first-class result store/inspection API is needed or ergonomic helpers suffice initially. Summary/adviser models must not be the only route to raw evidence.

**Acceptance:** large tool result can be retained and inspected selectively without full text entering root context; omitted content is explicit and retrievable; critical errors are not silently omitted.

## 02 — Python-to-RLM mailbox delivery

**Evidence:** [mailbox admission](../project/python/src/dsh_rlm/mailbox.py#L379-L418) queues driver messages locally and drops delivery-mode distinctions; [kernel initialization](../project/python/src/dsh_rlm/kernel.py#L119-L123) creates a driver-managed mailbox. Isolated probe returned accepted receipt, queued message, and MailboxInUseError on receive. Existing DSH subagent messaging is a separate working path.

**Next:** connect the driver mailbox to DSH steer/followup/inject with bounded admission and live-owner checks. Reject rather than pretend success if integration is unavailable.

**Acceptance:** busy/idle mode tests, parent sees worker reply, inject does not wake idle parent, full/closed destinations reject, completion races process or reject accepted work correctly.

## 03 — Persistent host-capable workers

**Evidence:** a live async task survived its cell but tools.list failed with UnsupportedOperationError after the originating cell ended. Local computation persists; host callback authority does not.

**Proposed contract:** child belongs to parent run, and each background host invocation has fresh ownership, current policy, cancellation, deadlines, accounting, and effect identity. Results can reach code mailboxes or the parent driver. Distinguish independence from a cell from durability across host restart: the latter is not required for the first milestone.

**Dependencies:** 02 for model-directed replies; 10/14 for quiet result/failure handling; 11 for inspectability.

**Acceptance:** worker calls a model/tool after parent cell returns, receives cancellation on parent shutdown, cannot exceed permissions, and cannot duplicate uncertain effects through automatic retry.

## 04 — Recovery notice timing

**Evidence:** [bridge response](../project/python/src/dsh_rlm/bridge.py#L811-L823) returns recovery notice after executing the cell. No destructive resume reproduction yet; inspect exact session-resume integration before implementing.

**Risk:** first resumed action may depend on absent handles/stale values or repeat an external effect before learning about interruption. Relevant after restart/reset, not ordinary healthy cells. No checkpoint gives exactly-once external effects.

**Smallest candidate:** initialize/restore before first post-resume execute, and if an unacknowledged recovery transition exists, return its concise notice without executing requested source. Let the model reconsider, then proceed on its next call. This is simpler than moving all initialization into prompt assembly, but does not literally deliver notice before the first resumed model request. Explicitly decide whether pre-action safety is sufficient rather than silently claiming spec compliance.

**Acceptance:** first external action after recovery cannot run before the model has been told what was restored/lost; no repeat notices on healthy cells. Discuss whether notice delivery needs durable acknowledgment across transport failures.

## 05 — Checkpoints and timeout hardening

**Current:** a checkpoint is a best-effort saved snapshot of serializable REPL variables, not a suspended interpreter or durable task. Successful cells synchronously wait for a forked checkpoint worker; failed cells do not replace last good checkpoint; final save is attempted at orderly close. On restart values restore into a fresh runtime; running tasks and mailbox queues do not.

**Purpose:** recover useful controller working state without replaying old code and external effects. DSH session history is separate. This is data durability, not execution durability: an external action may succeed before its corresponding Python bookkeeping is checkpointed. Failed cells may also have mutated live state or the outside world; preserving the last good checkpoint is not a transaction rollback.

**Finding:** [timeout cleanup](../project/python/src/dsh_rlm/kernel.py#L345-L377) sends SIGTERM then joins without a bound. A worker ignoring SIGTERM defeats the local deadline. This is a static edge-case finding, not a demonstrated routine hang.

**Proposed fix:** bounded termination grace then kill/reap, preserving the previous good snapshot and reporting incomplete cleanup. Keep separate from H1 and broader save cadence decisions.

**Open:** checkpoint every successful cell versus coalescing, explicit selected durable state, size/cost budgets. Do not add durable task replay as a side effect of this work.

## 06 — Typed mailbox aliases

**Reproduced:** a model with Field(alias="wire_value") accepts registration but rejects valid alias-keyed input during canonical reconstruction. [Validation path](../project/python/src/dsh_rlm/mailbox.py#L144-L197).

**Fix scope:** support alias dictionaries and model instances, including nested cases; preserve strict input validation, detached copies, bounded payloads, and defined handling of differing validation/serialization aliases. Do not silently broaden unrelated supported Pydantic types.

**Acceptance:** alias dict and model-instance round trips succeed; malformed/string-for-int inputs still fail; sender mutation cannot alter queued data; complete Python suite passes.

**Implementation note:** internal canonical copies now validate by field name independently of aliases; external dictionaries retain configured validation rules. The fix explicitly requires Pydantic >=2.11 (tested environment: 2.13.5); minimum-version compatibility has not been separately exercised. Lock requirement metadata matches the new floor, with resolved versions unchanged. Final validation: 113 Python tests passed (12 new parametrized alias cases), and git diff --check passed. These are source changes; the currently running interpreter was not restarted or hot-reloaded.

## 07 — Context-aware capability adviser

**User idea:** cheap model/subagent/tool answers a question using current trajectory context, surfacing relevant capabilities with high recall.

**Proposed shape:** retrieve from authoritative scoped capability inventory using explicit question plus bounded recent trajectory/task summary; rank candidates with a cheap model; return exact tool names, short applicability/constraints, and schema references (full schema only when selected). Include alternatives and an escape hatch to broader search.

**Boundaries:** adviser is read-only, cannot grant capabilities, and must validate returned names against the current allowed catalogue. Treat retrieved/trajectory content as untrusted data, not new authority. Include non-tool runtime capabilities, especially lifecycle restrictions.

**Candidate answer contract:** primary candidates + alternatives + exact tool/schema references + important restrictions + any unresolved ambiguity. The adviser recommends; the controller still selects and invokes through guarded tools.

**Open:** context window, automatic context extraction, candidate count, latency/cost budget, caching with policy/catalogue revision invalidation. Start with retrieval baseline before assuming an LLM is necessary. High recall means not overconfidently hiding the second plausible route.

**Acceptance:** compare recall of usable capabilities and token/latency cost against full catalogue and lexical search; zero nonexistent or unauthorized executable tools returned.

## 08 — Checkpoint warning noise

**Observed:** expected exclusions (runtime, builtins, imported modules, live handles) repeat every successful cell. User identifies this as urgent and potentially lethal to agent performance.

**Proposal, not implemented:** no routine exclusion prose in root context; keep full detail in inspector. Warn once/on change when meaningful user state is newly uncheckpointable; checkpoint failure/recovery loss stays visible but deduplicated. Persistent unresolved issues belong in compact state, not repeated paragraphs. No blanket suppression of actual failed saves.

**Acceptance:** ten unchanged successful cells emit no repeated exclusion list; new meaningful state loss/save failure produces one actionable notice; full inventory remains queryable.

## 09 — Durable working state boundaries

**Observed:** plain data persists; runtime-bound helpers/handles are excluded, and a REPL-defined Pydantic class failed serialization in the probe.

**Proposal:** inspectable live/checkpointed/unsaveable state and last verified checkpoint identity/time. Consider an explicit durable state container rather than implying arbitrary globals are durable. Document separately the live session, recoverable data, and nonrecoverable execution.

**Acceptance:** controller can answer what will survive a restart without restarting; loss/skips never imply values disappeared from the live interpreter.

## 10 — Concurrency and task demultiplexing

**Current:** auxiliary model calls can overlap; nested host tool calls are serialized by [dispatcher](../project/plugin/src/host-callbacks.ts#L68-L90).

**Clarification:** asyncio.as_completed helps consume already-concurrent results promptly; it does not make serialized host calls concurrent, and waiting inside a cell still withholds the next root model step.

**Latest decision:** use existing asyncio primitives and established patterns; no custom demultiplexer planned. Teach completion-order consumption, dynamic task sets, queues, cancellation, and run-scoped ownership through cookbooks/skills. Reuse existing harness message delivery where a model step is needed. Earlier custom-demux proposal is superseded; revisit only if a concrete gap cannot be addressed with these patterns.

**Acceptance:** out-of-order completions stay correlated; slow work does not delay ready results; capacity bounds and failure behavior are explicit; no model wakeup per tiny completion.

## 11 — Observability and UI

**Direction:** richer UI while keeping model context quiet. Separate durable event history/inspector from model notifications.

**Candidate UI:** runtime task tree; current cell and outstanding host calls; running/waiting/completed/failed states; mailbox depth; checkpoint age and excluded state; nested call timing/usage; unknown external outcomes; cancel/inspect controls.

**Open:** which events merit root context, UI-only storage, or opt-in detailed traces. UI not comprehensively audited in initial review. No UI changes implemented here.

## 12 — Measurement (out of band)

Explicitly separate workstream at user's request. User wants extensive evaluation before public exposure. Keep only linkage/intent here; do not expand this session into benchmark implementation.

Later dimensions: Standard vs RLM, outcome quality, latency, tokens/cost, context growth, failure/recovery behavior, long-running worker throughput. No benchmark superiority claim yet.

## 13 — Mailbox cleanup

**Static finding:** [explicit close](../project/python/src/dsh_rlm/mailbox.py#L496-L501) retains pending queue but removes ownership tracking; [run cleanup](../project/python/src/dsh_rlm/runtime.py#L465-L468) visits only tracked mailboxes. Needs focused reproduction.

**Required semantics:** explicit close allows drain while owner run remains alive; run exit discards pending queues, including previously closed ones. Clarify any post-run receive contract.

**Acceptance:** close with queued payload, exit owner, verify no retained/readable payload escapes intended cleanup; preserve ordinary close-then-drain behavior before exit.

## 14 — Local child failure visibility

**Finding:** completion callback observes exceptions but does not deliver a parent-model notice. Do not fix by announcing every completion/failure.

**Proposal:** record every terminal outcome in task registry/inspector; awaited failures use normal exception propagation and should not also notify. Unexpected unobserved failures in parent-relevant background work can generate a deduplicated, batched notice at a step boundary. Expected cancellation is quiet. Optional subscription/importance flag; no behavior change merely from inspecting a handle.

**Open:** what counts as observed/handled, whether idle root should wake, aggregation cadence, ownership after dropping a handle. Preserve failures long enough to inspect; quiet must not mean erased.

**Acceptance:** awaited error appears once; expected cancellation is silent; many background failures aggregate; important unhandled failure is not lost; successful tiny workers do not generate context spam.

## H1 — Checkpoint/close publication race

Additional source-review finding, not yet reproduced: [checkpoint exception handling/publication](../project/python/src/dsh_rlm/kernel.py#L435-L450) catches cancellation via BaseException and may write state after [close cancels execution](../project/python/src/dsh_rlm/kernel.py#L472-L476) and [releases ownership](../project/python/src/dsh_rlm/kernel.py#L538-L547).

**Next:** deterministic close-during-checkpoint regression. Preserve cancellation, fence publication to current ownership/generation, and settle or explicitly quarantine cleanup before releasing session ownership. Do not mark fixed based solely on changing the exception clause.

## Working principles

- Quiet healthy operation; actionable transition notices; details on demand.
- Structured evidence survives outside root context; references remain accessible.
- Side-effect uncertainty is explicit; no automatic replay to pretend durability.
- Distinguish verified behavior, source findings, user direction, and proposals.
- Tests for behavior and adversarial lifecycle edges, not merely nominal API existence.

## Suggested discussion order

1. **Quiet context contract (01, 07, 08, 09, 14):** what enters root context automatically, what is retained in state/UI, and what the adviser retrieves on demand. Start by removing routine checkpoint noise, not by adding another summarizer to compensate for it.
2. **Worker lifetime contract (02, 03, 10):** independence from a cell, fresh host invocation authority, bounded reply/completion demultiplexing, and parent-run cleanup. No crash-resumable execution requirement yet.
3. **Minimal recovery safety (04, 05, H1):** is a notice-and-no-execution response on the first post-recovery action enough? Confirm snapshot semantics and harden lifecycle without adding replay.
4. **UI detail (11):** expose existing structured state without mirroring it into the model prompt.
5. **Evaluation (12):** intentionally separate conversation/workstream.

## Follow-up: optional Jev and implementation dispatch

### User decisions
- Jev must be an **optional plugin**, not a core dependency. Evaluate fit before implementing.
- Smaller recovery gate (04) approved: first execution after recovery returns notice without executing supplied source, then model reconsiders. Core safety must work with Jev absent/offline.
- Prefer production-proven asyncio primitives/patterns over a custom demultiplexer. Plain code agents do not need an LLM notification policy.
- Start agreed implementation work in a Sol/high subagent while discussion continues.

### Dispatch status
All other work paused by user; subagent model selection is the sole priority. Root cause found: DSH already implements provider/model/reasoning_effort and list_subagent_models, and the RLM preset opts in, but host subagent-model-selection defaults disabled. Enabled the existing host setting with exact allowed route codex/gpt-5.6-sol in [host settings](/Users/tim/.dsh/settings.yaml#L7-L11), with sandbox escalation approved. Settings validated against shipped schema; cached model metadata advertises high effort. Current session remains unchanged by design: route authority is snapshotted at fresh top-level session creation and existing/restored sessions do not acquire new authority. Fresh-session schema and actual Sol/high child still need verification. No unrelated worker launched; no host restart or session-history rewrite performed.

Prepared work order: recovery gate (04), quiet routine checkpoint reporting (08), bounded checkpoint termination and ownership regression (05/H1), mailbox cleanup regression/fix (13). Follow with mailbox delivery (02) and fresh background host invocation authority (03); retain current safeguards and use standard asyncio. Leave Jev integration, broader context policy, UI, and selective child-failure notification design open. Alias fix (06) already complete.

### Jev assessment (exploratory, not an agreed integration plan)

**Latest user direction:** Jev remains purely optional. Prefer deterministic code when straightforward, including recovery gating. The desired longer-term experience is a drop-in enhancement that could improve monitoring, auto-steering, self-maintenance, etc. These are exploration areas, not approved capabilities or implementation commitments. Earlier capability/evidence-ranking suggestions below are tentative assistant hypotheses, not selected use cases. Play it by ear; do not design core around those hypotheses. Core must remain useful and correct with Jev absent, disabled, or unavailable. Optional automation remains subject to the same permissions and effect checks.
[Jev introduction](https://docs.typesafe.ai/introduction): typed Choice/Score/Noul decisions, not free-form generation. Best initial fit is candidate capability/evidence relevance scoring. [Skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion) closely matches capability discovery, but its at-most-one recommendation and retained full roster differ from our high-recall/context-reduction objective. [Passage classification](https://docs.typesafe.ai/cookbooks/classifying_rag_passages) is relevant to evidence selection.

Proposed optional boundary: core retains evidence, enforces scopes/permissions, pins mandatory notices, applies token budgets, and provides deterministic fallback. Plugin receives explicit question, bounded authorized trajectory context, and candidate IDs; returns scores/ranks over existing candidates. Invalid IDs, timeout, no credentials, or disabled plugin fall back to baseline inspection/search. No API key, SDK import, network request, or Jev state type is required by core. Sending trajectory to an external service is separately opt-in and scoped/redacted.

Do not use Jev to decide whether an actual recovery occurred, whether an effect already happened, whether permission is granted, or whether an obligatory warning may disappear. It may optionally rank additional recovery-related evidence. Ranking is reversible: do not delete raw results.

[Documented Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13): irrelevant long state hurts accuracy; adversarial state can steer outputs; generation is not supported. Therefore filter before sending, do not substitute probabilistic screening for a security boundary, and use deterministic snippets or a separate generative model for explanations. Vendor examples are not evidence of our workload performance.

### Standard async patterns, not a new scheduler
- Fixed batch: asyncio.as_completed for completion-order consumption.
- Dynamic task set: asyncio.wait(..., return_when=FIRST_COMPLETED), retaining pending tasks.
- Producer/consumer events: bounded asyncio.Queue plus ordinary worker tasks; choose backpressure explicitly.
- Scoped child lifetime: asyncio.TaskGroup when fail-fast sibling cancellation and waiting at scope exit are wanted. A TaskGroup scoped to one cell is not appropriate for workers meant to outlive that cell.
- RLM-specific adapter only: bridge retained results to model-step boundaries, batch notifications, and decide whether idle model should wake. No replacement task/cancellation semantics; ordinary code consumers just await results/queues.

