import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, RLM_CONTROLLER_PROMPT } from '../lib/policy.js'

function harness(rootAgents) {
  let section
  let assemble
  const ctx = {
    agents: { roots: () => rootAgents },
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

test('RLM policy shows guidance and only execute_python to a live root', async () => {
  const root = { session: { header: { parentSession: 'seed-source' } } }
  const { section, assemble } = harness([root])

  assert.equal(section.name, 'rlm:controller-policy')
  assert.equal(section.text({ agent: root }), RLM_CONTROLLER_PROMPT)
  assert.match(RLM_CONTROLLER_PROMPT, /runtime\.tools\.list\(\)/)
  assert.match(RLM_CONTROLLER_PROMPT, /await runtime\.tools\.call/)
  assert.match(RLM_CONTROLLER_PROMPT, /await runtime\.models\.complete/)
  assert.match(RLM_CONTROLLER_PROMPT, /Do not call `execute_python` through `runtime\.tools\.call`/)

  const filtered = await assemble({}, { agent: root }, async () => assembly())
  assert.deepEqual(filtered.tools.map(tool => tool.name), ['execute_python'])
})

test('RLM policy hides execute_python from children and leaves diagnostics unchanged', async () => {
  const root = { session: { header: {} } }
  const child = { session: { header: { parentSession: 'root' } } }
  const { section, assemble } = harness([root])

  assert.equal(section.text({ agent: child }), '')
  assert.equal(section.text({}), '')
  const childAssembly = assembly()
  const filteredChild = await assemble({}, { agent: child }, async () => childAssembly)
  assert.deepEqual(filteredChild.tools.map(tool => tool.name), ['bash', 'read'])
  const diagnosticAssembly = assembly()
  assert.equal(await assemble({}, {}, async () => diagnosticAssembly), diagnosticAssembly)
})
