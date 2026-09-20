# dsh-rlm

An RLM runtime for DeepSeek Harness.

- `research/` contains design decisions and pinned source findings.
- `project/python/` contains the tested Python runtime and subprocess bridge.
- `project/plugin/` contains the out-of-tree native DSH tool plugin.

The working slice is a persistent CPython RLM with native asyncio tasks,
bounded mailboxes, best-effort checkpoint recovery, and one managed Python
process per DSH agent. DSH supplies the agent loop, sessions, tools, models,
and subprocess lifecycle.
