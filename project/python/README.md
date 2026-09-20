# dsh-rlm Python core

The Python half of the DSH RLM mode provides:

- a persistent CPython namespace with top-level `await`;
- native `asyncio.Task` children;
- bounded, typed local mailboxes;
- bounded best-effort checkpoints and explicit recovery notices; and
- a multiplexed JSONL bridge for host-backed DSH tool and model calls.

## Develop

```sh
uv sync
uv run pytest
uvx ruff check .
uvx ruff format --check .
```

## Local kernel

```python
from pathlib import Path
from dsh_rlm import LocalKernel

kernel = await LocalKernel.open(Path(".dsh-rlm/example"))
try:
    recovery = kernel.take_recovery_notice()
    if recovery is not None:
        print(recovery)  # include it before the next model request

    result = await kernel.execute("value = 40 + 2\nvalue")
    assert result.ok
    print(result.value)
finally:
    await kernel.close()
```

A successful cell is checkpointed. A failed cell does not replace the last good
checkpoint. After interruption, a new kernel restores each recoverable value
independently and emits a one-shot `<runtime_recovery>` notice. Old tasks,
mailboxes, handles, host callback leases, and external effects never revive.

Checkpoint files use `dill`. Load only session directories controlled by the
local user because a malicious checkpoint can execute code while loading.

## Subprocess bridge

```sh
uv run python -m dsh_rlm.bridge --session-dir .dsh-rlm/example
```

Standard output is reserved for protocol frames. Ordinary Python stdout and raw
fd 1 writes are isolated from that channel. Legacy requests remain supported:

```json
{"id":"1","method":"execute","source":"40 + 2"}
{"id":"2","method":"close"}
```

The DSH plugin opts a cell into bidirectional callbacks with:

```json
{"id":"1","method":"execute","source":"await runtime.tools.list()","capabilities":["host-callback-v1"]}
```

While that cell is active, Python can use:

```python
schemas = await runtime.tools.list()
value = await runtime.tools.call("read", {"file_path": "README.md"})
completion = await runtime.models.complete("Summarize the evidence")
```

Callback requests and replies are correlated, so `asyncio.gather` model calls
can finish out of order. Framing, queued requests, source, callback payload,
callback count, and in-flight work are bounded. Protocol output uses strict
JSON values and JavaScript-safe integers. EOF drains complete accepted execute
requests. EOF during an active or attempted host callback records an
interrupted run before exit. A standalone `Runtime`, a non-opted-in execute, or
a task that calls the host after its creating cell ends fails clearly with
`UnsupportedOperationError`.

`connect()`, `spawn_rlm()`, and `runtime.processes` remain future API. The DSH
plugin owns provider/tool callbacks and managed subprocess lifecycle.
