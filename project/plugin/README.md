# DSH RLM plugin

This package is a Cordis bundle for DeepSeek Harness. It adds a selectable Agent
Preset named **RLM Mode** and makes it the deployment default. The preset is a
pinned copy of DSH's Standard preset plus the RLM bridge and controller policy.

For each live agent composed with the RLM preset, including inherited RLM child
agents, the model sees only `execute_python`. Each agent owns an isolated Python
bridge. Python can enumerate and invoke guarded DSH tools and make auxiliary
model calls. Standard-mode agents retain their normal prompt and tool catalogue.
RLM callbacks deny `execute_python` and `subagent_fork` to prevent recursive
controller entry; model selection and reasoning effort remain independent of mode.

See the [runtime cookbook](../../docs/rlm-runtime-cookbook.md) for compact discovery,
state/task inspection, truthful driver delivery, and explicitly admitted
post-cell host workers. Source edits require rebuilding/reloading the affected
host and Python implementation; they do not deploy themselves.

## Requirements

- Node.js 22 or newer for the plugin; Node.js 24 for the published DSH CLI
- DeepSeek Harness `0.1.6-alpha.2` (pinned source commit `ddefc45fbc7f8e46dd73185e68295696d1297887`)
- the Python `dsh-rlm` package installed in the interpreter selected below

## Build and test

```sh
cd project/python
uv sync
uv run pytest

cd ../plugin
npm ci
npm test
```

## Python process configuration

```sh
export DSH_RLM_PYTHON=/absolute/path/to/project/python/.venv/bin/python
export DSH_RLM_STATE_DIR=/absolute/path/to/.dsh-rlm
```

The bridge starts as:

```text
$DSH_RLM_PYTHON -m dsh_rlm.bridge --session-dir <state-root>/<hashed-agent-id>
```

The directory name uses the full SHA-256 digest of the raw agent ID. Calls for one DSH agent are serialized. Different root agents use different
processes. Aborting `execute_python` terminates that agent's process. The next
call restores the last good checkpoint and returns a mandatory recovery notice.

## Run from this checkout

Build both packages, then start DSH with the source-checkout profile patch:

```sh
cd /absolute/path/to/dsh-rlm
DSH_RLM_PYTHON="$PWD/project/python/.venv/bin/python" \
DSH_RLM_STATE_DIR="$PWD/.dsh-rlm" \
npm exec --yes \
  --package=node@24 \
  --package=@deepseek-ai/dsh@0.1.6-alpha.2 \
  -- dsh web --patch "$PWD/project/plugin/profile/cordis.patch.yml"
```

The patch exposes `project/plugin/presets` as a system preset root and sets the
base default to `rlm`. A user's existing `agent-presets.default` setting can still
override that default. Presets lock after the first model turn, so create a new
session when switching modes.

For a published or packed install, `package.json` exposes `cordis.patch.yml` as a
DSH bundle. Install it with DSH's plugin manager and restart the host:

```sh
dsh plugin --profile web add @dsh-rlm/plugin
```

This bundle targets the Web profile because that profile owns the
`agent-presets` row. This pinned DSH release replaces a patched row's whole
`config`; another bundle that also replaces `agent-presets.config.roots` can
conflict.

## Python controller API

```python
# Inspect the structured DSH tool catalog.
schemas = await runtime.tools.list()

# Run one guarded DSH tool as the owning root agent.
value = await runtime.tools.call("read", {"file_path": "README.md"})

# Make an auxiliary no-tools model call on the current route.
completion = await runtime.models.complete(
    "Return JSON with the three main risks.",
    system="Be concise.",
)
text = completion["text"]
```

`runtime.models.complete` returns `text`, `provider`, `model`, `finish`, and
`usage`. Supplying a route requires both `provider` and `model`. Independent
model calls can be combined with `asyncio.gather`. Nested tool calls are
serialized because direct `ToolRuntime.execute` does not expose the agent loop's
tool scheduler.

Ordinary host callbacks are valid only while the creating `execute_python` cell
is active, so await those calls before the cell ends. Post-cell host access is
available only through an explicitly admitted `runtime.host_workers` worker,
which receives fresh bounded authority for each invocation and is retired with
its owning bridge. Neither path retries uncertain external effects.
`execute_python` and `subagent_fork` are rejected through `runtime.tools.call`.
Each execute has a 120-second host callback deadline, a 64-call total limit, and
a 32-call in-flight limit.

Nested tools preserve the owning agent, permission and approval path,
cancellation signal, parent tool token, root call ID, extra contexts, and
turn-conclusion flag. Nested model calls use DSH's configured LLM service and do
not run model-emitted tools. Direct active-cell callbacks are covered by the
persisted outer `execute_python` call rather than a separate durable nested-call
record. Managed worker calls retain bounded process-live diagnostics, including
uncertain terminal outcomes, but not a crash-durable effect ledger.

## Native tool result

```text
execute_python({ source: "counter = globals().get('counter', 0) + 1\ncounter" })
```

The structured result contains `cell`, `checkpoint`, and `recovery_notice`.
Python exceptions are returned in `cell`. Bridge, framing, and host lifecycle
failures fail the DSH tool call explicitly.
