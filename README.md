# dsh-rlm

A Python-native recursive language model (RLM) mode for DeepSeek Harness.

The working system provides:

- a distributable DSH Agent Preset named **RLM Mode**;
- a root controller whose only model-visible tool is `execute_python`;
- a persistent CPython namespace with top-level `await`;
- host-backed `runtime.tools` and `runtime.models` calls from Python;
- ordinary DSH child agents with the standard tool surface;
- native `asyncio` tasks and bounded local mailboxes;
- best-effort checkpoints with mandatory interruption notices; and
- one managed Python process per live root DSH agent.

DSH remains responsible for provider routing, permissions, approvals, sessions,
tool execution, subprocess lifecycle, and the outer agent loop. The RLM plugin
keeps Python as the controller's working state and routes nested operations back
through those host services.

## Layout

- `project/python/` — tested Python runtime, REPL, checkpoint store, and JSONL bridge.
- `project/plugin/` — Cordis bundle, RLM preset, native tool, and host callback dispatcher.
- `research/` — design decisions and pinned DSH integration findings.

The integration target is DeepSeek Harness `0.1.6-alpha.2` at commit
`ddefc45fbc7f8e46dd73185e68295696d1297887`.
See [project/plugin/README.md](project/plugin/README.md) for build, install, and
startup instructions.
