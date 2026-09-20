# dsh-rlm

An RLM runtime for DeepSeek Harness.

- `research/` contains design decisions and pinned source findings.
- `project/python/` contains the tested Python-first implementation.
- `project/plugin/` will contain the out-of-tree DSH bridge.

The first milestone is a persistent CPython RLM with native asyncio tasks and
bounded mailboxes. DSH supplies sessions, tools, models, jobs, and process support.
