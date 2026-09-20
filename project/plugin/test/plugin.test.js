import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { BridgePool, sanitizeAgentId } from '../lib/bridge-client.js'
import { apply } from '../lib/index.js'

const result = (source, recovery_notice = null) => ({
  cell: {
    ok: true,
    stdout: '',
    stderr: '',
    display: source,
    error_type: null,
    error_message: null,
    traceback: null,
  },
  checkpoint: null,
  recovery_notice,
})

class FakeHandle {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = undefined
  control = undefined
  collected = {
    stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
  }
  terminated = false
  #resolveDone
  done = new Promise(resolve => { this.#resolveDone = resolve })

  constructor(respond) {
    let buffered = ''
    this.stdin.on('data', chunk => {
      buffered += chunk.toString()
      for (;;) {
        const newline = buffered.indexOf('\n')
        if (newline < 0) break
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        respond(JSON.parse(line), this)
      }
    })
  }

  send(value) {
    this.stdout.write(`${JSON.stringify(value)}\n`)
  }

  terminate() {
    if (this.terminated) return
    this.terminated = true
    this.#resolveDone({ exitCode: null, signal: 'SIGTERM' })
    this.stdout.end()
    this.stdin.destroy()
  }

  waitForExit() { return Promise.resolve(true) }
}

class FakeSubprocess {
  spawns = []
  async resolveExecutable(command) { return command }
  constructor(responder) { this.responder = responder }
  spawn(spec) {
    const index = this.spawns.length
    const handle = new FakeHandle((request, current) => this.responder(request, current, index))
    this.spawns.push({ spec, handle })
    return handle
  }
}

function normalResponder(request, handle) {
  if (request.method === 'close') {
    handle.send({ id: request.id, ok: true, result: { closed: true } })
    return
  }
  queueMicrotask(() => {
    handle.send({ id: request.id, ok: true, result: result(request.source) })
  })
}

test('one persistent process per agent and serialized calls', async () => {
  const subprocess = new FakeSubprocess(normalResponder)
  const pool = new BridgePool(subprocess, { cwd: '/work', stateRoot: '/state', python: '/python' })
  const signal = new AbortController().signal

  const [first, second] = await Promise.all([
    pool.execute('agent-1', 'first', signal),
    pool.execute('agent-1', 'second', signal),
  ])
  const other = await pool.execute('agent-2', 'other', signal)

  assert.equal(first.cell.display, 'first')
  assert.equal(second.cell.display, 'second')
  assert.equal(other.cell.display, 'other')
  assert.equal(subprocess.spawns.length, 2)
  assert.deepEqual(subprocess.spawns[0].spec.argv, [
    '/python', '-m', 'dsh_rlm.bridge', '--session-dir', '/state/agent-1',
  ])
  assert.deepEqual(subprocess.spawns[0].spec.stdio, {
    stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 },
  })
  await pool.dispose()
})

test('abort terminates the agent process and the next call recovers in a new process', async () => {
  const subprocess = new FakeSubprocess((request, handle, index) => {
    if (request.method === 'close') {
      handle.send({ id: request.id, ok: true, result: { closed: true } })
    } else if (index > 0) {
      handle.send({ id: request.id, ok: true, result: result(request.source, 'Recovered checkpoint.') })
    }
  })
  const pool = new BridgePool(subprocess)
  const controller = new AbortController()
  const pending = pool.execute('agent', 'while True: pass', controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('cancelled by test'))
  await assert.rejects(pending, /cancelled by test/)
  assert.equal(subprocess.spawns[0].handle.terminated, true)

  const recovered = await pool.execute('agent', '42', new AbortController().signal)
  assert.equal(recovered.recovery_notice, 'Recovered checkpoint.')
  assert.equal(subprocess.spawns.length, 2)
  await pool.dispose()
})


test('aborting a queued call does not terminate the active call', async () => {
  let firstRequest
  let firstHandle
  const subprocess = new FakeSubprocess((request, handle) => {
    if (request.method === 'execute' && firstRequest === undefined) {
      firstRequest = request
      firstHandle = handle
    } else if (request.method === 'execute') {
      handle.send({ id: request.id, ok: true, result: result(request.source) })
    } else {
      handle.send({ id: request.id, ok: true, result: { closed: true } })
    }
  })
  const pool = new BridgePool(subprocess)
  const first = pool.execute('agent', 'first', new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  const queuedController = new AbortController()
  const queued = pool.execute('agent', 'second', queuedController.signal)
  queuedController.abort(new Error('queued cancellation'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(firstHandle.terminated, false)
  firstHandle.send({ id: firstRequest.id, ok: true, result: result('first') })
  assert.equal((await first).cell.display, 'first')
  await assert.rejects(queued, /queued cancellation/)
  assert.equal(subprocess.spawns.length, 1)
  await pool.dispose()
})

test('a mismatched response id kills the client', async () => {
  const subprocess = new FakeSubprocess((request, handle) => {
    handle.send({ id: `${request.id}-wrong`, ok: true, result: result('bad') })
  })
  const pool = new BridgePool(subprocess)
  await assert.rejects(pool.execute('agent', '1', new AbortController().signal), /id mismatch/)
  assert.equal(subprocess.spawns[0].handle.terminated, true)
  await pool.dispose()
})

test('an invalid typed result terminates the poisoned client', async () => {
  const subprocess = new FakeSubprocess((request, handle) => {
    handle.send({ id: request.id, ok: true, result: { invalid: true } })
  })
  const pool = new BridgePool(subprocess)
  await assert.rejects(pool.execute('agent', '1', new AbortController().signal), /invalid execute result/)
  assert.equal(subprocess.spawns[0].handle.terminated, true)
  await pool.dispose()
})

test('agent disposal during executable lookup prevents a late spawn', async () => {
  let releaseResolution
  const subprocess = new FakeSubprocess(normalResponder)
  subprocess.resolveExecutable = command => new Promise(resolve => {
    releaseResolution = () => { resolve(command) }
  })
  const pool = new BridgePool(subprocess)
  const pending = pool.execute('agent', '1', new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  await pool.disposeAgent('agent')
  releaseResolution()
  await assert.rejects(pending, /disposed during bridge creation/)
  assert.equal(subprocess.spawns.length, 0)

  subprocess.resolveExecutable = async command => command
  const later = await pool.execute('agent', '2', new AbortController().signal)
  assert.equal(later.cell.display, '2')
  assert.equal(subprocess.spawns.length, 1)
  await pool.dispose()
})

test('agent ids are safe and stable session directory names', () => {
  assert.equal(sanitizeAgentId('plain-agent.1'), 'plain-agent.1')
  assert.match(sanitizeAgentId('../../unsafe id'), /^unsafe_id-[0-9a-f]{12}$/)
  assert.equal(sanitizeAgentId('../../unsafe id'), sanitizeAgentId('../../unsafe id'))
  assert.equal(sanitizeAgentId('..'), `agent-${sanitizeAgentId('..').slice(-12)}`)
})

test('apply registers native execute_python, requires an agent, and disposes its bridge', async () => {
  const subprocess = new FakeSubprocess(normalResponder)
  let tool
  let cleanup
  let disposedListener
  const ctx = {
    subprocess,
    tools: { register(value) { tool = value; return () => {} } },
    effect(factory) { cleanup = factory(); return () => {} },
    on(name, listener) {
      if (name === 'agent/disposed') disposedListener = listener
      return () => {}
    },
  }
  apply(ctx)
  assert.equal(tool.name, 'execute_python')
  await assert.rejects(
    tool.execute({ source: '1' }, { agent: undefined, signal: new AbortController().signal }),
    /requires an owning agent/,
  )
  const value = await tool.execute(
    { source: '6 * 7' },
    { agent: { id: 'owner' }, signal: new AbortController().signal },
  )
  assert.equal(value.cell.display, '6 * 7')
  disposedListener({ agent: { id: 'owner' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subprocess.spawns[0].handle.terminated, true)
  await cleanup()
})
