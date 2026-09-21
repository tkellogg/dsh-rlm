# Issue 02 — Python-to-RLM mailbox delivery implementation

Date: 2026-04-10

## Result

Implemented the missing active-cell delivery bridge from Python driver-managed mailboxes to the exact owning live DSH agent. Driver sends no longer return a receipt after appending to an unreadable local Python queue.

A successful `SendReceipt` means DSH synchronously admitted the identified `UserMessage` to its durable agent inbox. It does **not** mean the model saw or processed it. Cancellation/disposal after admission can still discard pending inbox input under DSH's existing contract.

No live host deployment/restart or installed-bundle edit was performed.

## Implementation

- `mailbox.py`: driver-managed sends validate liveness, mode, strict JSON/body size and then invoke `mailbox.delivery` under the active host-callback lease. Default mode remains `steer`. The callback is bounded by the caller timeout; timeout or transport failure is returned as failure and is never automatically retried because admission may be ambiguous. Driver `_admit` now rejects rather than creating a fake local success.
- `runtime.py`: `Runtime.send` routes only a registry-resolved, driver-managed mailbox backend through that delivery operation; ordinary code mailboxes retain FIFO behavior.
- `bridge.py` and plugin protocol: `mailbox.delivery` is an explicitly allowed and strictly validated callback method, using the existing callback byte/count/inflight limits and revocable execute-cell lease.
- Plugin host callback: derives authority from the outer execute's exact agent object, rechecks `ctx.agents.get(agent.id) === agent`, and requires the callback destination to equal the host-derived per-agent bridge key immediately before synchronous admission. Bridge startup passes that host-generated key as the fixed Python driver-mailbox id; nested/cross-driver destinations cannot redirect delivery. Pending pressure across both DSH inbox lists has a deployment-owned hard ceiling of 64; caller capacity can only narrow it. This is cooperative pressure limiting, not a reservation against other producers.
- Mode mapping uses existing DSH semantics without replacement scheduling: `steer` -> next-step and wakes idle; `followup` -> next-turn and wakes; `inject` -> next-step without waking idle. DSH itself reclassifies waking input sent after active cancellation as next-turn.
- String bodies become text directly; other strict JSON bodies use compact host JSON text. Message source is the `dsh-rlm` plugin.

The implementation remains compatible with later explicit subscriptions: only driver-managed destination routing changed; ordinary mailbox registry and code mailbox admission remain intact. No pubsub was added.

## Race and authority properties

- No `await` occurs between the final exact-live-agent identity check and the synchronous `steer`/`followup`/`inject` call.
- Stale/same-id replacement agents fail the exact-object check.
- Callback authority ends with the execute cell. Descendant tasks cannot retain it and sends outside the lease reject.
- Host acknowledgment is distinct from model processing. An accepted item may subsequently be cleared by cancellation/disposal.
- A transport timeout after host admission is intentionally ambiguous. The Python side does not retry or claim rejection.

## Validation

- Plugin `npm test`: 39/39 passed (includes build/typecheck). The dedicated delivery fixture faithfully splices admitted messages into next-step/next-turn arrays and verifies wake behavior, plugin source metadata, body text, receipt identity, pressure-full/hard ceiling, stale/disposed same-ID owners, cancellation before/after admission, forged/cross-driver destination, and delegation of aborted steer behavior. This is a faithful host-boundary fixture, not proof from a booted full AgentLoop/session persistence stack.
- Plugin `tsc -p tsconfig.json --noEmit`: exit 0.
- Dedicated Python `tests/test_driver_delivery.py`: 5/5 passed; proves host acknowledgment routing, lease requirement, exact active parent use, nested/cross-driver rejection before callback, absence of a fake local queue, and one-shot timeout-after-possible-admission behavior with no retry.
- Python full suite was attempted with workspace-local uv cache. Collection/execution reached the suite, but concurrent inspector work in `kernel.py` currently raises `AttributeError: LocalKernel has no attribute inspect_state` during construction; this is outside issue02-owned files and prevents bridge tests from running. The initial default uv cache attempt was sandbox-denied, then correctly rerun with `UV_CACHE_DIR=.uv-cache`.

## Pending / limitations

- Dedicated host and Python delivery regression coverage is now present. A live full-agent-loop test of upstream aborted-steer reclassification was not bootstrapped; the host fixture verifies the plugin delegates synchronously to `steer` without adding scheduling, while pinned upstream source establishes reclassification.
- Python host errors currently surface as bounded `HostCallbackError` rather than being remapped to each local mailbox exception subclass.
- Capacity is a cooperative pressure check across DSH pending inbox occupancy, bounded by the fixed host ceiling of 64. It is not a host-native reservation and other producers may change pressure around admission.
- No live child/parent reply round trip was run because live deployment/restart was prohibited.
- No guarantee of processing, exactly-once delivery across ambiguous transport loss, or survival after later cancellation/disposal is claimed.
