# DSH RLM

A Python-native agent environment built on DeepSeek Harness.

## Launch

After the package and matching native assets are released:

```sh
uvx dsh-rlm
uvx dsh-rlm setup
uvx dsh-rlm doctor
```

Or install a persistent command:

```sh
uv tool install dsh-rlm
dsh-rlm
```

Upgrade with `uvx --upgrade dsh-rlm` or `uv tool upgrade dsh-rlm`.
The first launch downloads a version-matched prebuilt Node/DSH application with
checksum verification. Python comes from uv's tool environment. No npm account,
Git clone, or existing DSH installation is needed. Credentials, sessions, and
checkpoints remain outside uv's cache. macOS and glibc Linux are the first targets.

Publication and full native-app acceptance are still pending. See
[the project](https://github.com/tkellogg/dsh-rlm) for release status.

## Python runtime

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
checkpoint. After restart, a new kernel restores each recoverable value
independently. `runtime.recovery` exposes bounded restored/skipped/failed
inventories for explicit inspection, while the routine notice remains concise.
The bridge gates the first submitted cell with `execution.status = "not_executed"`
and `reason = "recovery_gate"`; that source did not run. Old tasks, mailboxes,
handles, host callback leases, and external effects never revive.

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
