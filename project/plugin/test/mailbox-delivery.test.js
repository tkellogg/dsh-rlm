import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeAgentId } from '../lib/bridge-client.js'
import { createHostCallbackDispatcher, createHostCallbackExecution } from '../lib/host-callbacks.js'

function fixture({ status = 'idle', nextTurn = [], nextStep = [] } = {}) {
  const calls = []
  const agent = {
    id: 'owner', status, options: {}, session: { requestHeader: () => undefined },
    inbox: { nextTurn, nextStep },
    steer(message) {
      calls.push(['steer', message]); this.inbox.nextStep.push(message)
      if (this.status === 'idle') this.status = 'running'
    },
    followup(message) {
      calls.push(['followup', message]); this.inbox.nextTurn.push(message)
      if (this.status === 'idle') this.status = 'running'
    },
    inject(message) { calls.push(['inject', message]); this.inbox.nextStep.push(message) },
  }
  let live = agent
  const ctx = {
    agents: { get: () => live, withInitiator: (_owner, operation) => operation() },
    tools: { schemas: () => [] },
  }
  const outerController = new AbortController()
  const outer = {
    agent, callId: 'call', rootCallId: 'root', token: Symbol('outer'),
    signal: outerController.signal, deferContext() {}, concludeTurn() {},
  }
  const dispatcher = createHostCallbackDispatcher(ctx)
  const execution = createHostCallbackExecution(outer)
  const request = (mode, body = 'payload', capacity = 64) => ({
    kind: 'callback', id: `delivery-${mode}`, parent_id: 'cell', method: 'mailbox.delivery',
    params: { body, mode, mailbox_id: sanitizeAgentId(agent.id), capacity },
  })
  return { agent, calls, ctx, dispatcher, execution, request, outerController, setLive(value) { live = value } }
}

test('driver delivery preserves busy and idle steer/followup/inject modes', async () => {
  for (const status of ['idle', 'running']) {
    for (const mode of ['steer', 'followup', 'inject']) {
      const f = fixture({ status })
      const receipt = await f.dispatcher.dispatch(f.request(mode, { reply: mode }), f.execution, new AbortController().signal)
      assert.equal(f.calls.length, 1)
      assert.equal(f.calls[0][0], mode)
      const admitted = f.calls[0][1]
      assert.equal(admitted.content[0].text, JSON.stringify({ reply: mode }))
      assert.deepEqual(admitted.source, { kind: 'plugin', plugin: 'dsh-rlm' })
      assert.equal(mode === 'followup' ? f.agent.inbox.nextTurn.at(-1) : f.agent.inbox.nextStep.at(-1), admitted)
      assert.equal(typeof receipt.message_id, 'string')
      assert.ok(receipt.message_id.length > 0)
      assert.ok(!Number.isNaN(Date.parse(receipt.accepted_at)))
      assert.equal(f.agent.status, status === 'idle' && mode !== 'inject' ? 'running' : status)
    }
  }
})

test('idle inject does not wake while steer and followup do', async () => {
  const injected = fixture({ status: 'idle' })
  await injected.dispatcher.dispatch(injected.request('inject'), injected.execution, new AbortController().signal)
  assert.equal(injected.agent.status, 'idle')
  assert.deepEqual(injected.calls.map(([mode]) => mode), ['inject'])

  for (const mode of ['steer', 'followup']) {
    const waking = fixture({ status: 'idle' })
    await waking.dispatcher.dispatch(waking.request(mode), waking.execution, new AbortController().signal)
    assert.equal(waking.agent.status, 'running')
  }
})

test('full driver inbox rejects without invoking delivery', async () => {
  const f = fixture({ nextTurn: [{}], nextStep: [{}] })
  await assert.rejects(
    f.dispatcher.dispatch(f.request('steer', 'overflow', 2), f.execution, new AbortController().signal),
    error => error.code === 'MAILBOX_FULL',
  )
  assert.deepEqual(f.calls, [])
})

test('disposed and same-id replacement owners reject exact stale authority', async () => {
  for (const replacement of [undefined, { id: 'owner' }]) {
    const f = fixture()
    f.setLive(replacement)
    await assert.rejects(
      f.dispatcher.dispatch(f.request('steer'), f.execution, new AbortController().signal),
      error => error.code === 'AGENT_DISPOSED',
    )
    assert.deepEqual(f.calls, [])
  }
})

test('cancellation before admission rejects; cancellation after receipt cannot retract admission', async () => {
  const before = fixture()
  before.outerController.abort(new Error('cancel before'))
  await assert.rejects(
    before.dispatcher.dispatch(before.request('steer'), before.execution, new AbortController().signal),
    /cancel before/,
  )
  assert.deepEqual(before.calls, [])

  const after = fixture()
  const receipt = await after.dispatcher.dispatch(after.request('followup'), after.execution, new AbortController().signal)
  after.outerController.abort(new Error('cancel after'))
  assert.equal(after.calls.length, 1)
  assert.equal(after.calls[0][0], 'followup')
  assert.equal(typeof receipt.message_id, 'string')
})

test('aborted-running steer delegates upstream reclassification without plugin scheduling', async () => {
  const f = fixture({ status: 'running' })
  let aborted = true
  f.agent.steer = message => {
    // Mirrors the pinned Agent.send contract: waking input after active abort is
    // reclassified by the agent loop to next-turn; the plugin only calls steer.
    const target = aborted ? f.agent.inbox.nextTurn : f.agent.inbox.nextStep
    target.push(message)
    f.calls.push([aborted ? 'steer->next-turn' : 'steer', message])
  }
  await f.dispatcher.dispatch(f.request('steer'), f.execution, new AbortController().signal)
  assert.deepEqual(f.calls.map(([mode]) => mode), ['steer->next-turn'])
})


test('forged or cross-driver mailbox destination rejects before admission', async () => {
  const f = fixture()
  const forged = f.request('steer')
  forged.params.mailbox_id = sanitizeAgentId('other-agent')
  await assert.rejects(
    f.dispatcher.dispatch(forged, f.execution, new AbortController().signal),
    error => error.code === 'MAILBOX_DESTINATION_MISMATCH',
  )
  assert.deepEqual(f.calls, [])
})

test('caller capacity cannot raise deployment pressure ceiling', async () => {
  const f = fixture({ nextTurn: Array.from({ length: 64 }, () => ({})) })
  await assert.rejects(
    f.dispatcher.dispatch(f.request('followup', 'overflow', 1_000_000), f.execution, new AbortController().signal),
    error => error.code === 'MAILBOX_FULL',
  )
  assert.deepEqual(f.calls, [])
})
