# Program agents

Status: process-live managed host workers are implemented and source/test accepted; default process placement, parent-end policy, and child permission narrowing remain open.
See the [Python API draft](python-api.md) for proposed classes and methods.

## Definition

An agent is a running program registered with the shared runtime. It has an
identity, a parent when created by another agent, and access to messages and
permitted runtime operations. It does not need to call a model.

A **program agent** runs an async function as its root program, with no autonomous
LLM loop. An [RLM agent](rlm-loop.md) repeatedly asks a model for code to execute.
Both use the same runtime API for [messages](messaging.md), tools, explicit model
calls, and starting subagents; a program agent may call a model or launch a
subagent explicitly without becoming an RLM agent.

## Execution

An agent need not be an operating-system process. Several agents can run as
asyncio tasks in one Python host. A separate process is an option when work needs
independent termination or protection from another task's failure.

Local tasks receive their runtime connection directly. A separate process can
discover its connection through environment variables. Connection details do not
define the agent's identity or allow it to choose arbitrary permissions.

Establish ownership when starting work, before it connects. A command that never
connects remains an owned job; it need not become a messaging agent.

## Lifecycle

- Starting work returns a handle. Local agent execution uses an `asyncio.Task`.
  The caller can await it or continue, and chooses `asyncio.shield` when needed.
- Observe completion, failure, and cancellation, and notify a live parent.
- Report harness interruptions to affected RLMs through
  [recovery notices](rlm-loop.md#recovery-notices), not just UI or debug logs.
- A finished REPL cell does not end the agents it started.
- A lost connection is not proof of process death.

Task cancellation is cooperative. A blocking call can pause every task in the
same Python host. Tasks also share process state such as the working directory
and environment. If that host dies, all its tasks die together; DSH must observe
the host exit.

## Restart

RLM sessions can resume after restart. Execution starts fresh. Interrupted tasks
do not restart automatically. Restore saved REPL values where possible and tell
the RLM what was lost; see [REPL recovery](rlm-loop.md#restart).

Program agents are not durable. Do not restore or automatically rerun them.
A resumed parent must see which workers ended or have an unknown outcome; old
handles must not appear live. Mailboxes register again on startup; old
registrations and queued messages do not survive.

## DSH integration

Reuse DSH jobs for status, cancellation, output, and completion notices. Their
work can be a task or a process. Job ownership is tied to a DSH Agent, so it does
not replace our task identities and parent relationships.

Use DSH subprocess support when launching processes and Cordis cleanup when the
runtime plugin stops. Neither guarantees that uncooperative cleanup finishes.

## Still to decide

- Which work shares a Python host by default?
- What happens to children when their parent ends?
- How are permissions narrowed for children?

## Sources

DSH commit `ddefc45fbc7f8e46dd73185e68295696d1297887`:

- [Job contract](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/jobs/jobs/src/types.ts)
- [Job ownership and limits](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/jobs/jobs/README.md)
