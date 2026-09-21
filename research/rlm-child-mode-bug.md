# Bug: delegated child RLM preset disagrees with effective tool surface

Status: root cause confirmed and plugin-local source fix implemented; source tests pass, live deployment verification pending.

## Evidence
- Parent runs via execute_python and the persistent Python runtime control plane.
- Child ec6b025a-d7d6-4b2b-bef0-9f6e5931c1a0 was delegated with codex/gpt-5.6-sol, reasoning_effort high.
- Child reports persisted projection agentPreset: "rlm", with matching Sol/high model selection.
- Child reports actual exposed tools are direct bash/read/edit/write/grep/etc., with no execute_python or Python runtime object.
- Therefore model selection succeeds, but effective child execution interface is Standard-style despite RLM preset metadata. Child report is evidence; source-path diagnosis and regression reproduction remain pending.

## Investigation / acceptance
Trace child creation, preset inheritance, plugin activation, tool assembly, and projection metadata. Determine whether RLM child support is missing, intentionally disabled, or incorrectly initialized. Metadata must accurately describe effective mode. If RLM inheritance is intended, verify a child executes persistent Python across cells and uses guarded runtime callbacks; otherwise explicitly expose the supported child mode rather than labeling direct tools RLM. Preserve route selection and recursive reentry safeguards. Do not imply prior implementation work is invalid merely because it used direct tools.

## Dispatch constraint
User requested a separate Luna/xhigh investigator. The session advertises only codex/gpt-5.6-sol. Exact inspection of codex/gpt-5.6-luna was rejected: child LLM route is not allowed for this Session. No Luna child was started; do not silently substitute another model or bypass session route authority.

This separate record avoids conflicting edits to review-tracker.md, which the user is updating in another session.

## Resolution

Pinned upstream already inherits the parent's live composed preset for fresh and resumed in-process children while resolving route/model/reasoning effort independently. The plugin contradicted that contract by filtering `execute_python` to runtime roots and rejecting child execution. The targeted fix uses the live canonical composed preset for policy/tool assembly and permits the exact live child agent to own its isolated bridge. See `rlm-child-mode-implementation.md` for changes, tests, migration limits, and deployment verification. This remains source-only until the user deploys and verifies a fresh child.
