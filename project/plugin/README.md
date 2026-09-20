# DSH RLM plugin

An out-of-tree DeepSeek Harness plugin that registers one native tool, `execute_python`.
Each DSH agent gets one persistent Python bridge process and one checkpoint-backed
session directory. The tool uses the normal DSH tool pipeline. It does not use PTC.

## Requirements

- Node.js 22 or newer
- DeepSeek Harness `0.1.6-alpha.2` (built against commit `ddefc45fbc7f8e46dd73185e68295696d1297887`)
- Python package `dsh-rlm` installed in the selected Python environment

## Build and test

```sh
npm install
npm run build
npm test
```

The package entry point is `lib/index.js` and its declaration entry point is
`lib/index.d.ts`.

## Configuration

The bridge executable defaults to `python3`. Override it with
`DSH_RLM_PYTHON`. State defaults to `.dsh-rlm` under the DSH working directory.
Override it with `DSH_RLM_STATE_DIR`.

```sh
export DSH_RLM_PYTHON=/absolute/path/to/project/python/.venv/bin/python
export DSH_RLM_STATE_DIR=/absolute/path/to/dsh-rlm-state
```

The plugin starts the bridge as:

```text
$DSH_RLM_PYTHON -m dsh_rlm.bridge --session-dir <state-root>/<sanitized-agent-id>
```

Calls for one agent are serialized. Different agents use different processes.
Aborting a tool call terminates that agent's process. The next call starts a new
process and receives the Python kernel's `recovery_notice` in both the canonical
tool result and the rendered model-facing text.

## Profile overlay

Install this directory into the Node environment used by DSH, then add the
included [`profile/cordis.patch.yml`](profile/cordis.patch.yml) as a profile
patch:

```yaml
- insert:
    - id: dsh-rlm
      name: '@dsh-rlm/plugin'
```

The profile must already provide `tools` and `subprocess`, as the standard DSH
base profiles do.

## Tool

```text
execute_python({ source: "counter = globals().get('counter', 0) + 1\ncounter" })
```

The structured result contains `cell`, `checkpoint`, and `recovery_notice`.
Successful cells are checkpointed by the Python kernel. Python exceptions are
returned in `cell`; bridge and protocol failures fail the tool call.
