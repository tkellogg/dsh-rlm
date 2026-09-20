# dsh-rlm Python core

The first working slice of the DSH RLM runtime. It provides:

- a persistent CPython namespace with top-level `await`;
- native `asyncio.Task` children;
- bounded, typed local mailboxes;
- bounded best-effort checkpoints; and
- explicit clean and interrupted recovery notices.

## Develop

```sh
uv sync
uv run pytest
```

## Local kernel

```python
from pathlib import Path
from dsh_rlm import LocalKernel

kernel = await LocalKernel.open(Path(".dsh-rlm/example"))
try:
    recovery = kernel.take_recovery_notice()
    if recovery is not None:
        # Add this block to model context before the next model request.
        print(recovery)

    result = await kernel.execute("value = 40 + 2\nvalue")
    assert result.ok
    print(result.value)
finally:
    await kernel.close()
```

A successful cell is checkpointed. A failed cell does not replace the last good
checkpoint. After an abrupt process exit, a new kernel restores each recoverable
value independently and emits a `<runtime_recovery>` notice. Old tasks,
mailboxes, handles, and external effects are never presented as live state.

Checkpoint files use `dill`. Load only session directories controlled by the
local user because a malicious checkpoint can execute code while loading.

The DSH bridge is not part of this package yet. `connect()` and the runtime
`tools`, `models`, and `processes` namespaces currently fail explicitly.
