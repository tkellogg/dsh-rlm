import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { BridgePool, sanitizeAgentId } from '../lib/bridge-client.js'
import { apply } from '../lib/index.js'
import { createHostCallbackDispatcher, createHostCallbackExecution } from '../lib/host-callbacks.js'

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
  exited = false
  delayTermination = false
  throwOnTerminate = false
  terminationAttempts = 0
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
    this.terminationAttempts += 1
    if (this.terminated) return
    this.terminated = true
    if (this.throwOnTerminate) throw new Error('synchronous terminate failure')
    if (!this.delayTermination) this.exit()
  }

  exit() {
    if (this.exited) return
    this.exited = true
    this.#resolveDone({ exitCode: null, signal: 'SIGTERM' })
    this.stdout.end()
    this.stdin?.destroy()
  }

  waitForExit(signal) {
    if (this.exited) return Promise.resolve(true)
    return new Promise(resolve => {
      const onAbort = () => { resolve(false) }
      signal.addEventListener('abort', onAbort, { once: true })
      void this.done.then(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(true)
      })
    })
  }
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
    '/python', '-m', 'dsh_rlm.bridge', '--session-dir', `/state/${sanitizeAgentId('agent-1')}`,
  ])
  assert.deepEqual(subprocess.spawns[0].spec.stdio, {
    stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 },
  })
  await pool.dispose()
})

test('replacement waits for confirmed retirement and fails closed without it', async () => {
  const subprocess = new FakeSubprocess((request, handle, index) => {
    if (request.method === 'close') {
      handle.send({ id: request.id, ok: true, result: { closed: true } })
    } else if (index === 0) {
      handle.delayTermination = true
    } else {
      handle.send({ id: request.id, ok: true, result: result(request.source, 'Recovered checkpoint.') })
    }
  })
  const pool = new BridgePool(subprocess, { lifecycleWaitMs: 100 })
  const controller = new AbortController()
  const pending = pool.execute('agent', 'while True: pass', controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  const rejected = assert.rejects(pending, /cancelled by test/)
  controller.abort(new Error('cancelled by test'))
  await rejected
  assert.equal(subprocess.spawns[0].handle.terminated, true)

  const recoveredPending = pool.execute('agent', '42', new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subprocess.spawns.length, 1)
  subprocess.spawns[0].handle.exit()
  const recovered = await recoveredPending
  assert.equal(recovered.recovery_notice, 'Recovered checkpoint.')
  assert.equal(subprocess.spawns.length, 2)
  await pool.dispose()

  const disposalSubprocess = new FakeSubprocess((request, handle, index) => {
    if (request.method === 'execute') {
      handle.send({ id: request.id, ok: true, result: result(request.source) })
    } else if (index > 0) {
      handle.send({ id: request.id, ok: true, result: { closed: true } })
    }
    // The first bridge's graceful close deliberately receives no response.
  })
  const disposalPool = new BridgePool(disposalSubprocess, { lifecycleWaitMs: 100 })
  assert.equal(
    (await disposalPool.execute('agent', 'before disposal', new AbortController().signal)).cell.display,
    'before disposal',
  )
  disposalSubprocess.spawns[0].handle.delayTermination = true
  const retiring = disposalPool.disposeAgent('agent')
  const afterDisposal = disposalPool.execute('agent', 'after disposal', new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposalSubprocess.spawns.length, 1)
  disposalSubprocess.spawns[0].handle.exit()
  await retiring
  assert.equal((await afterDisposal).cell.display, 'after disposal')
  assert.equal(disposalSubprocess.spawns.length, 2)
  await disposalPool.dispose()

  const stuckSubprocess = new FakeSubprocess((request, handle) => {
    if (request.method === 'execute') handle.waitForExit = () => new Promise(() => {})
  })
  const stuckPool = new BridgePool(stuckSubprocess, { lifecycleWaitMs: 15 })
  const stuckController = new AbortController()
  const stuckExecute = stuckPool.execute('agent', 'blocked', stuckController.signal)
  await new Promise(resolve => setImmediate(resolve))
  const stuckRejected = assert.rejects(stuckExecute, /cancel stuck/)
  stuckController.abort(new Error('cancel stuck'))
  await stuckRejected
  await assert.rejects(
    stuckPool.execute('agent', 'must not spawn', new AbortController().signal),
    /did not exit/,
  )
  assert.equal(stuckSubprocess.spawns.length, 1)
  await stuckPool.dispose()
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
  const queuedRejected = assert.rejects(queued, /queued cancellation/)
  queuedController.abort(new Error('queued cancellation'))
  await queuedRejected
  assert.equal(firstHandle.terminated, false)
  assert.equal(subprocess.spawns.length, 1)
  firstHandle.send({ id: firstRequest.id, ok: true, result: result('first') })
  assert.equal((await first).cell.display, 'first')
  assert.equal(subprocess.spawns.length, 1)
  await pool.dispose()
})

test('mismatched response and stdout EOF poison the client', async () => {
  for (const mode of ['mismatch', 'eof', 'close', 'partial']) {
    const subprocess = new FakeSubprocess((request, handle) => {
      if (mode === 'mismatch') {
        handle.send({ id: `${request.id}-wrong`, ok: true, result: result('bad') })
      } else {
        if (mode === 'partial') handle.stdout.write('{"id":"partial"')
        if (mode === 'close') handle.stdout.destroy()
        else handle.stdout.end()
      }
    })
    const pool = new BridgePool(subprocess, { lifecycleWaitMs: 20 })
    await assert.rejects(
      pool.execute('agent', '1', new AbortController().signal),
      mode === 'mismatch' ? /id mismatch/ : (mode === 'partial' ? /partial response frame/ : /stdout ended/),
    )
    assert.equal(subprocess.spawns[0].handle.terminated, true)
    await pool.dispose()
  }

  const hungSubprocess = new FakeSubprocess(normalResponder)
  const spawnNormally = hungSubprocess.spawn.bind(hungSubprocess)
  const hungHandle = new FakeHandle(() => {})
  hungHandle.stdin = new Writable({ write() { /* deliberately never completes */ } })
  hungSubprocess.spawn = spec => {
    if (hungSubprocess.spawns.length > 0) return spawnNormally(spec)
    hungSubprocess.spawns.push({ spec, handle: hungHandle })
    return hungHandle
  }
  const hungPool = new BridgePool(hungSubprocess, { lifecycleWaitMs: 20 })
  const hungExecute = hungPool.execute('agent', 'blocked write', new AbortController().signal)
  const hungRejection = assert.rejects(hungExecute, /stdout ended/)
  await new Promise(resolve => setImmediate(resolve))
  hungHandle.stdout.end()
  await hungRejection
  const replacement = await hungPool.execute('agent', 'replacement', new AbortController().signal)
  assert.equal(replacement.cell.display, 'replacement')
  assert.equal(hungSubprocess.spawns.length, 2)
  await hungPool.dispose()
})

test('invalid results poison the client and synchronous terminate errors cannot re-enter stop', async () => {
  const subprocess = new FakeSubprocess((request, handle) => {
    handle.send({ id: request.id, ok: true, result: { invalid: true } })
  })
  const pool = new BridgePool(subprocess)
  await assert.rejects(pool.execute('agent', '1', new AbortController().signal), /invalid execute result/)
  assert.equal(subprocess.spawns[0].handle.terminated, true)
  await pool.dispose()

  const throwingSubprocess = new FakeSubprocess((request, handle) => {
    handle.throwOnTerminate = true
    handle.send({ id: `${request.id}-wrong`, ok: true, result: result('bad') })
  })
  const throwingPool = new BridgePool(throwingSubprocess, { lifecycleWaitMs: 15 })
  await assert.rejects(
    throwingPool.execute('agent', '1', new AbortController().signal),
    /id mismatch/,
  )
  assert.equal(throwingSubprocess.spawns[0].handle.terminationAttempts, 1)
  await throwingPool.dispose()

  const brokenSubprocess = new FakeSubprocess(normalResponder)
  const spawnNormally = brokenSubprocess.spawn.bind(brokenSubprocess)
  const brokenHandle = new FakeHandle(() => {})
  brokenHandle.stdin = undefined
  brokenHandle.delayTermination = true
  brokenSubprocess.spawn = spec => {
    if (brokenSubprocess.spawns.length > 0) return spawnNormally(spec)
    brokenSubprocess.spawns.push({ spec, handle: brokenHandle })
    return brokenHandle
  }
  const brokenPool = new BridgePool(brokenSubprocess, { lifecycleWaitMs: 100 })
  await assert.rejects(
    brokenPool.execute('agent', '1', new AbortController().signal),
    /did not expose requested Python bridge pipes/,
  )
  const afterBroken = brokenPool.execute('agent', '2', new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(brokenSubprocess.spawns.length, 1)
  brokenHandle.exit()
  assert.equal((await afterBroken).cell.display, '2')
  assert.equal(brokenSubprocess.spawns.length, 2)
  await brokenPool.dispose()
})

test('cancellation and disposal during executable lookup prevent late spawn', async () => {
  const blocked = Promise.withResolvers()
  const cancelledSubprocess = new FakeSubprocess(normalResponder)
  cancelledSubprocess.resolveExecutable = () => blocked.promise
  const cancelledPool = new BridgePool(cancelledSubprocess)
  const controller = new AbortController()
  const cancelled = cancelledPool.execute('agent', '1', controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  const promptlyRejected = assert.rejects(cancelled, /lookup cancelled/)
  controller.abort(new Error('lookup cancelled'))
  await promptlyRejected
  blocked.resolve('python3')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelledSubprocess.spawns.length, 0)
  await cancelledPool.dispose()

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

test('every agent id gets a case-safe full-digest session namespace', () => {
  for (const id of ['plain-agent.1', '../../unsafe id', '..', 'A', 'a', 'Ａ']) {
    assert.match(sanitizeAgentId(id), /^agent-[0-9a-f]{64}$/)
    assert.equal(sanitizeAgentId(id), sanitizeAgentId(id))
  }
  assert.notEqual(sanitizeAgentId('A'), sanitizeAgentId('a'))
  assert.notEqual(sanitizeAgentId('A'), sanitizeAgentId('Ａ'))
})

test('apply standing registration guards live roots and retires bridges on preset changes', async () => {
  const subprocess = new FakeSubprocess(normalResponder)
  let cleanup
  let disposedListener
  let selectedListener
  let unregistered = false
  const registered = []
  const roots = []
  const ctx = {
    subprocess,
    logger: { warn() {} },
    tools: {
      register(value) {
        registered.push(value)
        return () => { unregistered = true }
      },
      schemas: () => [],
      execute: async () => { throw new Error('unused') },
    },
    llm: { stream: async function* () {} },
    agents: {
      roots: () => [...roots],
      get: id => roots.find(agent => agent.id === id),
      withInitiator: (_agent, operation) => operation(),
    },
    effect(factory) { cleanup = factory(); return () => {} },
    on(name, listener) {
      if (name === 'agent/disposed') disposedListener = listener
      if (name === 'agent-preset/selected') selectedListener = listener
      return () => {}
    },
  }
  apply(ctx)
  assert.equal(registered.length, 1)
  const tool = registered[0]
  const root = { id: 'owner' }
  const child = { id: 'child' }
  const execution = agent => ({
    agent,
    signal: new AbortController().signal,
    callId: 'call-1',
    rootCallId: 'call-1',
    token: Symbol('outer'),
  })
  await assert.rejects(tool.execute({ source: '1' }, execution(undefined)), /live root agent/)
  await assert.rejects(tool.execute({ source: '1' }, execution(child)), /live root agent/)

  roots.push(root)
  assert.equal((await tool.execute({ source: '6 * 7' }, execution(root))).cell.display, '6 * 7')
  roots.length = 0
  await assert.rejects(tool.execute({ source: '1' }, execution(root)), /live root agent/)

  selectedListener('owner', 'standard')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subprocess.spawns[0].handle.terminated, true)
  selectedListener('owner', 'rlm')
  disposedListener({ agent: root })
  await cleanup()
  assert.equal(unregistered, true)
})

test('bridge advertises callbacks and writes out-of-order callback results safely', async () => {
  const received = []
  let executeRequest
  const subprocess = new FakeSubprocess((request, handle) => {
    if (request.method === 'execute') {
      executeRequest = request
      handle.send({ kind: 'callback', id: 'slow', parent_id: request.id, method: 'tools.list', params: {} })
      handle.send({ kind: 'callback', id: 'fast', parent_id: request.id, method: 'tools.list', params: {} })
      return
    }
    if (request.kind === 'callback_result') {
      received.push(request)
      if (received.length === 2) {
        setImmediate(() => { handle.send({ id: executeRequest.id, ok: true, result: result('done') }) })
      }
      return
    }
    handle.send({ id: request.id, ok: true, result: { closed: true } })
  })
  const dispatcher = {
    async dispatch(request) {
      if (request.id === 'slow') await new Promise(resolve => setImmediate(resolve))
      return { callback: request.id }
    },
  }
  const pool = new BridgePool(subprocess, {}, dispatcher)
  const value = await pool.execute('agent', 'source', new AbortController().signal, {})
  assert.equal(value.cell.display, 'done')
  assert.deepEqual(executeRequest.capabilities, ['host-callback-v1'])
  assert.deepEqual(received.map(frame => frame.id), ['fast', 'slow'])
  assert.deepEqual(received.map(frame => frame.result), [{ callback: 'fast' }, { callback: 'slow' }])
  await pool.dispose()

  let droppedOuter
  const droppingSubprocess = new FakeSubprocess((request, handle) => {
    if (request.method === 'execute') {
      droppedOuter = request
      handle.send({ kind: 'callback', id: 'cb', parent_id: request.id, method: 'tools.list', params: {} })
    } else if (request.kind === 'callback_result') {
      handle.send({ id: droppedOuter.id, ok: true, result: result('callbacks ignored') })
    } else {
      handle.send({ id: request.id, ok: true, result: { closed: true } })
    }
  })
  const ordinarySpawn = droppingSubprocess.spawn.bind(droppingSubprocess)
  droppingSubprocess.spawn = spec => {
    const handle = ordinarySpawn(spec)
    const transmit = handle.stdin.write.bind(handle.stdin)
    handle.stdin.write = (data, encoding) => transmit(data, encoding)
    return handle
  }
  const droppingPool = new BridgePool(droppingSubprocess, {}, { dispatch: async () => [] })
  assert.equal(
    (await droppingPool.execute('agent', 'source', new AbortController().signal, {})).cell.display,
    'callbacks ignored',
  )
  await droppingPool.dispose()
})

test('final execute response has a bounded callback barrier', async () => {
  const release = Promise.withResolvers()
  let callbackStarted = false
  const subprocess = new FakeSubprocess((request, handle) => {
    if (request.method === 'close') {
      handle.send({ id: request.id, ok: true, result: { closed: true } })
      return
    }
    if (request.method !== 'execute') return
    handle.send({ kind: 'callback', id: 'pending', parent_id: request.id, method: 'tools.list', params: {} })
    handle.send({ id: request.id, ok: true, result: result('barrier') })
  })
  const dispatcher = {
    async dispatch() {
      callbackStarted = true
      await release.promise
      return []
    },
  }
  const pool = new BridgePool(subprocess, { lifecycleWaitMs: 25 }, dispatcher)
  let settled = false
  const pending = pool.execute('agent', 'source', new AbortController().signal, {})
    .finally(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(callbackStarted, true)
  assert.equal(settled, false)
  release.resolve()
  assert.equal((await pending).cell.display, 'barrier')
  await pool.dispose()

  const stuckSubprocess = new FakeSubprocess((request, handle) => {
    if (request.method === 'execute') {
      handle.send({ kind: 'callback', id: 'stuck', parent_id: request.id, method: 'tools.list', params: {} })
      handle.send({ id: request.id, ok: true, result: result('must not escape') })
    }
  })
  const stuck = new BridgePool(stuckSubprocess, { lifecycleWaitMs: 15 }, {
    dispatch: () => new Promise(() => {}),
  })
  await assert.rejects(
    stuck.execute('agent', 'source', new AbortController().signal, {}),
    /did not drain/,
  )
  assert.equal(stuckSubprocess.spawns[0].handle.terminated, true)
  await stuck.dispose()

  let callbackFailure
  let deadlineRequest
  const deadlineSubprocess = new FakeSubprocess((request, handle) => {
    if (request.method === 'execute') {
      deadlineRequest = request
      handle.send({ kind: 'callback', id: 'deadline', parent_id: request.id, method: 'tools.list', params: {} })
    } else if (request.kind === 'callback_result') {
      callbackFailure = request
      handle.send({ id: deadlineRequest.id, ok: true, result: result('deadline handled') })
    } else {
      handle.send({ id: request.id, ok: true, result: { closed: true } })
    }
  })
  const deadlinePool = new BridgePool(deadlineSubprocess, { callbackWaitMs: 15 }, {
    dispatch: () => new Promise(() => {}),
  })
  assert.equal(
    (await deadlinePool.execute('agent', 'source', new AbortController().signal, {})).cell.display,
    'deadline handled',
  )
  assert.equal(callbackFailure.error.code, 'CALLBACK_TIMEOUT')
  await deadlinePool.dispose()
})

test('outer cancellation rejects promptly with an uncooperative callback dispatcher', async () => {
  const subprocess = new FakeSubprocess((request, handle) => {
    if (request.method === 'execute') {
      handle.send({ kind: 'callback', id: 'work', parent_id: request.id, method: 'tools.list', params: {} })
    }
  })
  const pool = new BridgePool(subprocess, { lifecycleWaitMs: 15 }, {
    dispatch: () => new Promise(() => {}),
  })
  const controller = new AbortController()
  const pending = pool.execute('agent', 'source', controller.signal, {})
  await new Promise(resolve => setImmediate(resolve))
  const rejected = assert.rejects(pending, /cancel callbacks/)
  controller.abort(new Error('cancel callbacks'))
  await rejected
  assert.equal(subprocess.spawns[0].handle.terminated, true)
  await pool.dispose()

  const disposeSubprocess = new FakeSubprocess((request, handle) => {
    if (request.method === 'execute') {
      handle.send({ kind: 'callback', id: 'work', parent_id: request.id, method: 'tools.list', params: {} })
    }
  })
  const disposePool = new BridgePool(disposeSubprocess, { lifecycleWaitMs: 15 }, {
    dispatch: () => new Promise(() => {}),
  })
  const disposedExecute = disposePool.execute('agent', 'source', new AbortController().signal, {})
  const disposedRejection = assert.rejects(disposedExecute, /disposed during execution/)
  await new Promise(resolve => setImmediate(resolve))
  await disposePool.dispose()
  await disposedRejection
})

test('callback in-flight limit is protocol-fatal', async () => {
  const subprocess = new FakeSubprocess((request, handle) => {
    if (request.method !== 'execute') return
    for (let index = 0; index < 33; index += 1) {
      handle.send({ kind: 'callback', id: `cb-${index}`, parent_id: request.id, method: 'tools.list', params: {} })
    }
  })
  let shared
  const dispatcher = {
    dispatch(_request, _context, signal) {
      if (shared === undefined) {
        shared = Promise.withResolvers()
        signal.addEventListener('abort', () => { shared.reject(signal.reason) }, { once: true })
      }
      return shared.promise
    },
  }
  const pool = new BridgePool(subprocess, {}, dispatcher)
  await assert.rejects(
    pool.execute('agent', 'source', new AbortController().signal, {}),
    /exceeded 32 in-flight callbacks/,
  )
  assert.equal(subprocess.spawns[0].handle.terminated, true)
  await pool.dispose()
})

test('callback results require strict JSON and report size separately', async () => {
  const runPayload = async value => {
    let outerRequest
    let returned
    const subprocess = new FakeSubprocess((request, handle) => {
      if (request.method === 'execute') {
        outerRequest = request
        handle.send({ kind: 'callback', id: 'value', parent_id: request.id, method: 'tools.list', params: {} })
      } else if (request.kind === 'callback_result') {
        returned = request
        setImmediate(() => { handle.send({ id: outerRequest.id, ok: true, result: result('bounded') }) })
      } else {
        handle.send({ id: request.id, ok: true, result: { closed: true } })
      }
    })
    const pool = new BridgePool(subprocess, {}, { dispatch: async () => value })
    assert.equal((await pool.execute('agent', 'source', new AbortController().signal, {})).cell.display, 'bounded')
    await pool.dispose()
    return returned
  }

  const cycle = {}
  cycle.self = cycle
  class CustomPayload { value = 1 }
  const accessor = {}
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 })
  const hostileProxy = new Proxy({}, { getPrototypeOf() { throw new Error('hostile proxy') } })
  for (const value of [undefined, NaN, Infinity, 1n, cycle, new CustomPayload(), accessor, hostileProxy]) {
    const returned = await runPayload(value)
    assert.equal(returned.ok, false)
    assert.equal(returned.error.code, 'INVALID_CALLBACK_PAYLOAD')
  }

  const oversized = await runPayload('x'.repeat(1024 * 1024))
  assert.equal(oversized.ok, false)
  assert.equal(oversized.error.code, 'CALLBACK_RESULT_TOO_LARGE')
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) <= 1024 * 1024)
})

test('callback parent mismatch and invalid params poison the bridge', async () => {
  for (const callback of [
    { kind: 'callback', id: 'cb', parent_id: 'wrong', method: 'tools.list', params: {} },
    { kind: 'callback', id: 'cb', parent_id: '1', method: 'tools.list', params: { extra: true } },
  ]) {
    const subprocess = new FakeSubprocess((request, handle) => {
      if (request.method === 'execute') handle.send(callback)
    })
    const pool = new BridgePool(subprocess, {}, { dispatch: async () => [] })
    await assert.rejects(pool.execute('agent', 'source', new AbortController().signal, {}), /callback/)
    assert.equal(subprocess.spawns[0].handle.terminated, true)
    await pool.dispose()
  }
})

test('same-bridge causal reentry is returned as a callback error', async () => {
  let outerRequest
  let callbackResult
  const subprocess = new FakeSubprocess((request, handle) => {
    if (request.method === 'execute') {
      outerRequest = request
      handle.send({ kind: 'callback', id: 'cb', parent_id: request.id, method: 'tools.list', params: {} })
    } else if (request.kind === 'callback_result') {
      callbackResult = request
      setImmediate(() => { handle.send({ id: outerRequest.id, ok: true, result: result('outer') }) })
    } else {
      handle.send({ id: request.id, ok: true, result: { closed: true } })
    }
  })
  let pool
  const dispatcher = {
    async dispatch() {
      return await pool.execute('agent', 'nested', new AbortController().signal, {})
    },
  }
  pool = new BridgePool(subprocess, {}, dispatcher)
  const value = await pool.execute('agent', 'outer', new AbortController().signal, {})
  assert.equal(value.cell.display, 'outer')
  assert.equal(callbackResult.ok, false)
  assert.equal(callbackResult.error.code, 'HOST_CALLBACK_ERROR')
  assert.match(callbackResult.error.message, /re-enter/)
  assert.equal(subprocess.spawns.length, 1)
  await pool.dispose()
})

function fakeOuter(agent) {
  const contexts = []
  let concluded = false
  const outer = {
    agent,
    callId: 'outer-call',
    rootCallId: 'root-call',
    token: Symbol('outer'),
    signal: new AbortController().signal,
    deferContext(context) { contexts.push(context) },
    concludeTurn() { concluded = true },
  }
  return { outer, contexts, concluded: () => concluded }
}

test('host tools callbacks use scoped schemas and guarded serial nested dispatch', async () => {
  const agent = { id: 'agent', session: { requestHeader: () => undefined }, options: {} }
  const calls = []
  let active = 0
  let maxActive = 0
  let returnError = false
  const firstRelease = Promise.withResolvers()
  const firstStarted = Promise.withResolvers()
  const ctx = {
    agents: {
      get: () => agent,
      withInitiator: (owner, operation) => {
        assert.equal(owner, agent)
        return operation()
      },
    },
    tools: {
      schemas: owner => {
        assert.equal(owner, agent)
        return [
          { name: 'execute_python', description: '', parameters: {} },
          { name: 'subagent_fork', description: '', parameters: {} },
          { name: 'visible', description: 'ok', parameters: {} },
        ]
      },
      async execute(input) {
        calls.push(input)
        active += 1
        maxActive = Math.max(maxActive, active)
        if (calls.length === 1) {
          firstStarted.resolve()
          await firstRelease.promise
        }
        active -= 1
        if (returnError) {
          return {
            isError: true,
            error: { message: 'nested failure', info: { code: 'NESTED_ERROR' } },
            content: [],
            additionalContexts: [{ id: 'error-context' }],
            concludesTurn: true,
          }
        }
        return {
          isError: false,
          value: { order: calls.length },
          content: [],
          additionalContexts: [{ id: `ctx-${calls.length}` }],
          concludesTurn: true,
        }
      },
    },
  }
  const dispatcher = createHostCallbackDispatcher(ctx)
  const record = fakeOuter(agent)
  const execution = createHostCallbackExecution(record.outer)
  const signal = new AbortController().signal
  const listed = await dispatcher.dispatch(
    { kind: 'callback', id: 'list', parent_id: '1', method: 'tools.list', params: {} },
    execution,
    signal,
  )
  assert.deepEqual(listed.map(schema => schema.name), ['visible'])
  const first = dispatcher.dispatch(
    { kind: 'callback', id: 'a', parent_id: '1', method: 'tools.call', params: { name: 'visible', arguments: { n: 1 } } },
    execution,
    signal,
  )
  await firstStarted.promise
  const second = dispatcher.dispatch(
    { kind: 'callback', id: 'b', parent_id: '1', method: 'tools.call', params: { name: 'visible', arguments: { n: 2 } } },
    execution,
    signal,
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1)
  firstRelease.resolve()
  assert.deepEqual(await first, { order: 1 })
  assert.deepEqual(await second, { order: 2 })
  assert.equal(maxActive, 1)
  assert.equal(calls[0].rootCallId, 'root-call')
  assert.equal(calls[0].parent, record.outer.token)
  assert.equal(calls[0].agent, agent)
  assert.notEqual(calls[0].callId, calls[1].callId)
  assert.deepEqual(record.contexts, [{ id: 'ctx-1' }, { id: 'ctx-2' }])
  assert.equal(record.concluded(), true)
  await assert.rejects(
    dispatcher.dispatch(
      { kind: 'callback', id: 'deny', parent_id: '1', method: 'tools.call', params: { name: 'execute_python', arguments: {} } },
      execution,
      signal,
    ),
    error => error.code === 'REENTRANT_TOOL_DENIED',
  )

  returnError = true
  const errorRecord = fakeOuter(agent)
  await assert.rejects(
    dispatcher.dispatch(
      { kind: 'callback', id: 'error', parent_id: '1', method: 'tools.call', params: { name: 'visible', arguments: {} } },
      createHostCallbackExecution(errorRecord.outer),
      signal,
    ),
    error => error.code === 'NESTED_ERROR',
  )
  assert.equal(errorRecord.concluded(), true)
  assert.deepEqual(errorRecord.contexts, [{ id: 'error-context' }])
})

test('models.complete inherits the current route, assembles text, and disables tools', async () => {
  const agent = {
    id: 'agent',
    options: { provider: 'fallback', model: 'fallback-model', maxTokens: 12 },
    session: {
      requestHeader: () => ({
        config: {
          provider: 'header-provider',
          model: 'header-model',
          reasoningEffort: 'medium',
          temperature: 0.2,
          maxTokens: 99,
          stop: ['END'],
        },
      }),
    },
  }
  let seenOptions
  const ctx = {
    agents: { get: () => agent, withInitiator: (_agent, operation) => operation() },
    tools: { schemas: () => [], execute: async () => { throw new Error('unused') } },
    llm: {
      async prepareCall(config) {
        return {
          config,
          async *stream(options) {
            seenOptions = options
            yield { type: 'text-delta', index: 0, text: 'hello ' }
            yield { type: 'text-delta', index: 0, text: 'world' }
            yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  }
  const dispatcher = createHostCallbackDispatcher(ctx)
  const record = fakeOuter(agent)
  const response = await dispatcher.dispatch(
    { kind: 'callback', id: 'model', parent_id: '1', method: 'models.complete', params: { prompt: 'say hi' } },
    createHostCallbackExecution(record.outer),
    new AbortController().signal,
  )
  assert.deepEqual(response, {
    text: 'hello world',
    provider: 'header-provider',
    model: 'header-model',
    finish: { kind: 'stop' },
    usage: { inputTokens: 3, outputTokens: 2 },
  })
  assert.deepEqual(seenOptions.tools, [])
  assert.equal(seenOptions.reasoningEffort, 'medium')
  assert.equal(seenOptions.maxTokens, 99)
  assert.equal(seenOptions.temperature, 0.2)
  assert.deepEqual(seenOptions.stop, ['END'])
  assert.equal(seenOptions.sessionId, 'agent')
  assert.equal(seenOptions.messages[0].content[0].text, 'say hi')
})

test('models.complete reports terminal model failures and unexpected tool calls', async () => {
  const agent = {
    id: 'agent', options: { provider: 'p', model: 'm' },
    session: { requestHeader: () => undefined },
  }
  for (const chunks of [
    [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } }],
    [
      { type: 'tool-call-delta', index: 0, id: 'tc', name: 'bad', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  ]) {
    const ctx = {
      agents: { get: () => agent, withInitiator: (_agent, operation) => operation() },
      tools: { schemas: () => [] },
      llm: {
        async prepareCall(config) {
          return { config, async *stream() { yield* chunks } }
        },
      },
    }
    const dispatcher = createHostCallbackDispatcher(ctx)
    const record = fakeOuter(agent)
    await assert.rejects(
      dispatcher.dispatch(
        { kind: 'callback', id: 'model', parent_id: '1', method: 'models.complete', params: { prompt: 'x' } },
        createHostCallbackExecution(record.outer),
        new AbortController().signal,
      ),
      /slow down|unexpected tool call/,
    )
  }
})
