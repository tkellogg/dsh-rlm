import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { BridgePool } from '../lib/bridge-client.js'
import { createHostCallbackDispatcher, createHostCallbackExecution } from '../lib/host-callbacks.js'

const root = resolve(import.meta.dirname, '../../..')
const pythonSource = join(root, 'project/python/src')
async function deadline(promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
const turn = () => new Promise(resolve => setImmediate(resolve))

class RealSubprocess {
  handles = []
  async resolveExecutable(command) { return command }
  spawn(spec) {
    const stderr = []
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env, PYTHONPATH: pythonSource },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    const done = new Promise((resolveDone, reject) => {
      child.once('error', reject)
      child.once('exit', (exitCode, signal) => resolveDone({ exitCode, signal }))
    })
    const handle = {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      control: undefined,
      collected: { stderr: { readFrom: offset => {
        const text = Buffer.concat(stderr).toString('utf8')
        return { text: text.slice(offset), nextOffset: text.length, lossy: false }
      } } },
      done,
      terminate() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') },
      async waitForExit(signal) {
        if (child.exitCode !== null || child.signalCode !== null) return true
        return await new Promise(resolveWait => {
          const abort = () => resolveWait(false)
          signal.addEventListener('abort', abort, { once: true })
          done.finally(() => { signal.removeEventListener('abort', abort); resolveWait(true) })
        })
      },
      child,
    }
    this.handles.push(handle)
    return handle
  }
}

function outerFor(agent) {
  let deferred = 0
  let concluded = 0
  return {
    execution: createHostCallbackExecution({
      callId: 'outer-call', rootCallId: 'outer-root', token: { stale: true }, agent,
      signal: new AbortController().signal,
      deferContext() { deferred += 1 }, concludeTurn() { concluded += 1 },
    }),
    effects: () => ({ deferred, concluded }),
  }
}

async function waitForWorker(pool, execution) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const probe = await deadline(pool.execute('integration-agent', "globals().get('_worker_observation', None)", new AbortController().signal, execution), 2_000, 'worker probe')
    if (probe.cell.display !== 'None') return probe.cell.display
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('worker did not publish an observation')
}

test('real Python bridge keeps an admitted worker valid after its execute cell ends', { timeout: 15_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-rlm-worker-integration-'))
  const subprocess = new RealSubprocess()
  const ctx = new Context()
  let pool
  let toolExecutions = 0
  const toolCalled = Promise.withResolvers()
  const modelCalled = Promise.withResolvers()
  const releasePath = join(stateRoot, 'release-worker')
  try {
    ctx.plugin(SystemPrompt, {})
    ctx.plugin(ToolRuntime, { mode: 'native' })
    await turn()
    ctx.tools.register(defineTool({
      name: 'worker_probe', description: 'Integration probe.',
      parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute({ value }, exec) {
        toolExecutions += 1
        toolCalled.resolve()
        assert.equal(exec.parent, undefined)
        assert.equal(String(exec.rootCallId), String(exec.callId))
        return `${value}:${String(exec.callId)}`
      },
    }))
    const agent = {
      id: 'integration-agent', options: { provider: 'fake-provider', model: 'fake-model' },
      session: { requestHeader: () => undefined },
    }
    ctx.agents = {
      get: id => id === agent.id ? agent : undefined,
      withInitiator: (_agent, operation) => operation(),
    }
    ctx.llm = { prepareCall: async config => ({
      config,
      async *stream(options) {
        assert.equal(options.tools.length, 0)
        assert.equal(options.messages[0].content[0].text, 'worker model prompt')
        modelCalled.resolve()
        yield { type: 'text-delta', index: 0, text: 'model-ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }) }
    const { execution, effects } = outerFor(agent)
    pool = new BridgePool(subprocess, {
      cwd: root, stateRoot, python: process.env.PYTHON ?? join(root, 'project/python/.venv/bin/python'), lifecycleWaitMs: 1_500, callbackWaitMs: 2_000,
    }, createHostCallbackDispatcher(ctx))

    const source = `
import asyncio, os
_worker_observation = None
_release_path = ${JSON.stringify(releasePath)}
async def _integration_worker(rt):
    global _worker_observation
    while not os.path.exists(_release_path):
        await asyncio.sleep(0.01)
    raw = asyncio.create_task(rt.tools.list())
    try:
        await raw
        raw_status = 'unexpected-success'
    except Exception as exc:
        raw_status = type(exc).__name__
    schemas = await rt.tools.list()
    tool = await rt.tools.call('worker_probe', {'value': 'tool-ok'})
    model = await rt.models.complete('worker model prompt')
    _worker_observation = {'raw_status': raw_status, 'schema_names': [s['name'] for s in schemas], 'tool': tool, 'model': model}
_worker_handle = await runtime.host_workers.spawn(_integration_worker, name='integration-worker', timeout=5)
'admitted'
`
    const admitted = await deadline(pool.execute(agent.id, source, new AbortController().signal, execution), 4_000, 'worker admission execute')
    assert.equal(admitted.cell.ok, true)
    assert.equal(admitted.cell.display, "'admitted'")
    await writeFile(releasePath, 'execute-is-finished')
    await deadline(toolCalled.promise, 3_000, 'independent worker tool dispatch')
    await deadline(modelCalled.promise, 3_000, 'independent worker model dispatch')

    const display = await waitForWorker(pool, execution)
    assert.match(display, /raw_status.*UnsupportedOperationError/)
    assert.match(display, /worker_probe/)
    assert.match(display, /tool-ok:rlm-worker:/)
    assert.match(display, /model-ok/)
    assert.equal(toolExecutions, 1, 'host effects are not automatically retried')
    assert.deepEqual(effects(), { deferred: 0, concluded: 0 }, 'worker must not reuse outer defer/conclude hooks')

    await deadline(pool.dispose(), 4_000, 'bridge close')
    pool = undefined
    assert.equal(subprocess.handles.length, 1)
    assert.notEqual(subprocess.handles[0].child.signalCode, null, 'close retires the real bridge process')
  } finally {
    if (pool !== undefined) await deadline(pool.dispose(), 4_000, 'fixture cleanup').catch(() => {})
    for (const handle of subprocess.handles) handle.terminate()
    await Promise.allSettled(subprocess.handles.map(handle => deadline(handle.done, 2_000, 'process cleanup')))
    await ctx.dispose?.()
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test('real Python worker lifetime timeout prevents later host invocation', { timeout: 10_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-rlm-worker-timeout-'))
  const subprocess = new RealSubprocess()
  const agent = {
    id: 'timeout-agent', options: { provider: 'fake-provider', model: 'fake-model' },
    session: { requestHeader: () => undefined },
  }
  let schemaCalls = 0
  const ctx = {
    agents: {
      get: id => id === agent.id ? agent : undefined,
      withInitiator: (_agent, operation) => operation(),
    },
    tools: {
      schemas() { schemaCalls += 1; return [] },
      async execute() { throw new Error('worker timed out before tool dispatch') },
    },
    llm: { async prepareCall() { throw new Error('worker timed out before model dispatch') } },
  }
  const execution = outerFor(agent).execution
  let pool = new BridgePool(subprocess, {
    cwd: root,
    stateRoot,
    python: process.env.PYTHON ?? join(root, 'project/python/.venv/bin/python'),
    lifecycleWaitMs: 1_500,
    callbackWaitMs: 2_000,
  }, createHostCallbackDispatcher(ctx))
  try {
    const admitted = await deadline(pool.execute(agent.id, `
import asyncio
async def _too_late(rt):
    await asyncio.sleep(0.25)
    return await rt.tools.list()
_timeout_handle = await runtime.host_workers.spawn(_too_late, timeout=0.05)
'admitted-timeout'
`, new AbortController().signal, execution), 4_000, 'timeout worker admission')
    assert.equal(admitted.cell.ok, true)
    assert.equal(admitted.cell.display, "'admitted-timeout'")
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
    const outcome = await deadline(pool.execute(
      agent.id,
      "(_timeout_handle.done, type(_timeout_handle.exception()).__name__)",
      new AbortController().signal,
      execution,
    ), 2_000, 'timeout outcome probe')
    assert.equal(outcome.cell.ok, true)
    assert.equal(outcome.cell.display, "(True, 'TimeoutError')")
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
    assert.equal(schemaCalls, 0, 'timed-out worker cannot invoke the host later')
    await deadline(pool.dispose(), 4_000, 'timeout bridge close')
    pool = undefined
  } finally {
    if (pool !== undefined) await deadline(pool.dispose(), 4_000, 'timeout fixture cleanup').catch(() => {})
    for (const handle of subprocess.handles) handle.terminate()
    await Promise.allSettled(subprocess.handles.map(handle => deadline(handle.done, 2_000, 'timeout process cleanup')))
    await rm(stateRoot, { recursive: true, force: true })
  }
})



test('disposing a real bridge owner aborts an in-flight worker tool exactly once', { timeout: 12_000 }, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-rlm-worker-dispose-'))
  const subprocess = new RealSubprocess()
  const ctx = new Context()
  const started = Promise.withResolvers()
  const aborted = Promise.withResolvers()
  let calls = 0
  let pool
  try {
    ctx.plugin(SystemPrompt, {})
    ctx.plugin(ToolRuntime, { mode: 'native' })
    await turn()
    ctx.tools.register(defineTool({
      name: 'blocking_worker_probe', description: 'Wait until its worker authority is revoked.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_arguments, exec) {
        calls += 1
        started.resolve()
        await new Promise((resolveWait, reject) => {
          const onAbort = () => { aborted.resolve(); reject(exec.signal.reason ?? new Error('aborted')) }
          exec.signal.addEventListener('abort', onAbort, { once: true })
          if (exec.signal.aborted) onAbort()
        })
        return 'unreachable'
      },
    }))
    const agent = {
      id: 'dispose-agent', options: { provider: 'fake-provider', model: 'fake-model' },
      session: { requestHeader: () => undefined },
    }
    ctx.agents = {
      get: id => id === agent.id ? agent : undefined,
      withInitiator: (_agent, operation) => operation(),
    }
    ctx.llm = { async prepareCall() { throw new Error('unused') } }
    const execution = outerFor(agent).execution
    pool = new BridgePool(subprocess, {
      cwd: root,
      stateRoot,
      python: process.env.PYTHON ?? join(root, 'project/python/.venv/bin/python'),
      lifecycleWaitMs: 1_500,
      callbackWaitMs: 2_000,
    }, createHostCallbackDispatcher(ctx))
    const admitted = await deadline(pool.execute(agent.id, `
import asyncio
async def _blocked(rt):
    return await rt.tools.call('blocking_worker_probe', {})
_dispose_handle = await runtime.host_workers.spawn(_blocked, timeout=5)
'admitted-dispose'
`, new AbortController().signal, execution), 4_000, 'dispose worker admission')
    assert.equal(admitted.cell.ok, true)
    assert.equal(admitted.cell.display, "'admitted-dispose'")
    await deadline(started.promise, 3_000, 'blocking worker tool start')
    await deadline(pool.disposeAgent(agent.id), 4_000, 'owner disposal')
    await deadline(aborted.promise, 2_000, 'worker tool abort')
    assert.equal(calls, 1, 'revoked worker tool is never retried')
    assert.equal(subprocess.handles.length, 1)
    assert.notEqual(subprocess.handles[0].child.signalCode, null, 'owner disposal reaps bridge process')
    pool = undefined
  } finally {
    if (pool !== undefined) await deadline(pool.dispose(), 4_000, 'dispose fixture cleanup').catch(() => {})
    for (const handle of subprocess.handles) handle.terminate()
    await Promise.allSettled(subprocess.handles.map(handle => deadline(handle.done, 2_000, 'dispose process cleanup')))
    await ctx.dispose?.()
    await rm(stateRoot, { recursive: true, force: true })
  }
})
