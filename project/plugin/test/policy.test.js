import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, RLM_CONTROLLER_PROMPT } from '../lib/policy.js'

function harness() {
  let section
  let assemble
  const ctx = {
    agents: {},
    systemPrompt: {
      getSectionOrder(name) {
        assert.equal(name, 'PTC_ONLY')
        return 800
      },
      section(value) {
        section = value
        return () => {}
      },
    },
    on(name, listener) {
      assert.equal(name, 'system-prompt/assemble')
      assemble = listener
      return () => {}
    },
  }
  apply(ctx)
  return { section, assemble }
}

function agent(preset, options = {}) {
  const ctx = {
    get(name) {
      assert.equal(name, 'agentPresets')
      return { composedPreset: candidate => candidate === ctx ? preset : undefined }
    },
  }
  return { ctx, options }
}

function assembly() {
  return {
    sections: [],
    contexts: [],
    variables: {},
    tools: [
      { name: 'bash', description: '', parameters: {} },
      { name: 'execute_python', description: '', parameters: {} },
      { name: 'read', description: '', parameters: {} },
    ],
  }
}

test('RLM policy shows guidance and only execute_python to root and child RLM agents', async () => {
  const root = agent('rlm', { provider: 'codex', model: 'root-model', reasoningEffort: 'high' })
  const child = agent('rlm', { provider: 'codex', model: 'child-model', reasoningEffort: 'low' })
  const { section, assemble } = harness()

  assert.equal(section.name, 'rlm:controller-policy')
  assert.match(RLM_CONTROLLER_PROMPT, /^You are an RLM controller\./)
  assert.doesNotMatch(RLM_CONTROLLER_PROMPT, /root RLM controller/)
  assert.equal(section.text({ agent: root }), RLM_CONTROLLER_PROMPT)
  assert.equal(section.text({ agent: child }), RLM_CONTROLLER_PROMPT)
  assert.match(RLM_CONTROLLER_PROMPT, /runtime\.tools\.list\(\)/)
  assert.match(RLM_CONTROLLER_PROMPT, /await runtime\.tools\.call/)
  assert.match(RLM_CONTROLLER_PROMPT, /await runtime\.models\.complete/)
  assert.match(RLM_CONTROLLER_PROMPT, /Do not call `execute_python` through `runtime\.tools\.call`/)

  for (const current of [root, child]) {
    const filtered = await assemble({}, { agent: current }, async () => assembly())
    assert.deepEqual(filtered.tools.map(tool => tool.name), ['execute_python'])
  }
})

test('Standard agents hide execute_python and diagnostics remain unchanged', async () => {
  const standard = agent('standard')
  const { section, assemble } = harness()

  assert.equal(section.text({ agent: standard }), '')
  assert.equal(section.text({}), '')
  const standardAssembly = assembly()
  const filtered = await assemble({}, { agent: standard }, async () => standardAssembly)
  assert.deepEqual(filtered.tools.map(tool => tool.name), ['bash', 'read'])
  const diagnosticAssembly = assembly()
  assert.equal(await assemble({}, {}, async () => diagnosticAssembly), diagnosticAssembly)
})
