# Messaging

Status: bounded driver-inbox delivery and typed local mailboxes are implemented and source/test accepted; the public address/type API and program-agent delivery policy remain open.

## Mailboxes

Messages address mailboxes, not family relationships. Allow any communication
pattern; use the parent's mailbox when no destination is supplied. Derive sender
identity from the runtime, not from a name supplied in the message.

An agent registers its mailbox and optional type signature at startup. The
mailbox owns that signature. Messages may contain text or structured values,
subject to the signature when present. The sender validates before sending;
the receiving side also validates before accepting the message.

Mailboxes and queued messages are not durable. A saved agent session does not
make its old mailbox live. A restarted agent must register again.

## Sending

A send succeeds when the current, live mailbox accepts the message into its
queue. Check the destination, permissions, type, and available space before
accepting. A receiver that ends during these checks must not produce a false
success.

Return clear errors to the sender for an unknown or dead mailbox, denied access,
a type mismatch, or a full queue. Type errors should identify the mismatch.
Queues are bounded. Never wait for queue space, silently drop a message, or use
an unbounded queue elsewhere to hide overflow.

Do not wait for the receiver to read the message, call a model, or reply.
Connection checks must also have a time limit; an unreachable receiver must not
leave the sender waiting indefinitely.

Acceptance is not guaranteed delivery: the receiver can die after accepting.
Delivery, a reply, and task completion are separate events.

## Receiving in Python

Code mailboxes provide synchronous `receive_nowait()` and async `receive()`.
The first checks available input without blocking and raises `asyncio.QueueEmpty`
when open and empty. The second waits intentionally. Both drain queued messages
after close, then raise `MailboxClosedError`. See the [Python API](python-api.md).

Do not make a model step depend on a new message when the RLM already has work.
See the [deadlock review](deadlocks.md) for circular waits and required checks.

## RLM delivery modes

| Mode | Busy RLM | Idle RLM |
|---|---|---|
| `steer` (default) | Include at the next model step after current tool work. | Wake it. |
| `followup` | Queue a separate turn after current work. | Wake it. |
| `inject` | Add context for a later model step. | Do not wake it. |

None of these interrupts running Python code or changes REPL variables directly.
Program agents receive messages without calling a model. Keep command output
and task-exit notices distinct from messages.

## Existing systems

**DSH:** an Agent has inbox lists for the next turn and next step. Inbox changes
are logged. Its `followup`, `steer`, and `inject` operations provide the behavior
above. The subagent send API restricts delivery to direct parent-child
relationships, but the lower-level API does not: a trusted plugin can find a live
agent with `ctx.agents.get(id)` and call its inbox operations directly. Wrap those
operations for any-to-any RLM delivery, with our own permission, type, capacity,
and closing-mailbox checks. Python task receivers still need a receive queue.
Cordis events and DSH job output are not queued mailboxes.

**Prime Agent:** `agent_message.send` permits parents, children, and siblings.
The daemon determines the sender and enforces size, queue, and rate limits.
This API always steers: it wakes idle agents and queues behind active tool work.
`queued` means accepted behind active work; `delivered` means delivery to the
agent's context has begun, not that the request was processed. Generic prompt
APIs also support follow-up, but the agent-message API does not expose it.

Prime Agent can save pending actions for a controlled update/restart. It does
not supply a general durable mailbox. Neither system directly provides typed
mailboxes for arbitrary Python tasks.

## Still to decide

- Type-signature format and how senders discover it.
- Mailbox addresses, permissions, queue limits, and send time limits.
- Whether program-agent mailboxes accept RLM delivery modes or reject them.

## Sources

DSH commit `ddefc45fbc7f8e46dd73185e68295696d1297887`:

- [Inbox operations](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/agent/src/runtime-types.ts)
- [Live agent lookup](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/agent/src/index.ts)
- [Subagent messaging](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/subagent/subagent/src/index.ts)

Prime Agent commit `a54b10f7fdb22a322c2f7081e1e3b88841bfce5c`:

- [Message API](https://github.com/PrimeIntellect-ai/prime-agent/blob/a54b10f7fdb22a322c2f7081e1e3b88841bfce5c/packages/coding-agent/skills/agent-message/src/agent_message/__init__.py)
- [Daemon delivery](https://github.com/PrimeIntellect-ai/prime-agent/blob/a54b10f7fdb22a322c2f7081e1e3b88841bfce5c/packages/coding-agent/src/modes/daemon/daemon-mode.ts#L5604-L5769)
- [Queued-action recovery](https://github.com/PrimeIntellect-ai/prime-agent/blob/a54b10f7fdb22a322c2f7081e1e3b88841bfce5c/packages/coding-agent/src/core/agent-session.ts#L5228-L5330)
