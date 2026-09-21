import assert from 'node:assert/strict'
import test from 'node:test'
import { HostWorkerAuthority, WorkerInvocationError } from '../lib/host-worker-authority.js'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('authority admits explicit workers and mints fresh invocation effects', async () => {
  const owner = {}
  const authority = new HostWorkerAuthority({ owner, generation: 3, ownerIsLive: value => value === owner })
  const lease = authority.admit('run', 'worker')
  const seen = []
  assert.equal(await authority.invoke(lease, 'invocation', async (_signal, effectId, actual) => {
    seen.push(effectId)
    assert.equal(actual, owner)
    return 42
  }), 42)
  assert.equal(await authority.invoke(lease, 'invocation', async (_signal, effectId) => { seen.push(effectId); return 43 }), 43)
  assert.equal(seen.length, 2)
  assert.notEqual(seen[0], seen[1])
  assert.match(seen[0], /^[0-9a-f-]{36}$/)
  assert.deepEqual(authority.snapshot().records.map(item => item.state), ['succeeded', 'succeeded'])
})

test('authority enforces host worker and inflight ceilings', async () => {
  const authority = new HostWorkerAuthority({ owner: {}, generation: 1, maxWorkers: 1, maxInFlight: 1, ownerIsLive: () => true })
  const lease = authority.admit('run', 'one')
  assert.throws(() => authority.admit('run', 'two'), /capacity/)
  const gate = deferred()
  const first = authority.invoke(lease, 'invocation', async () => await gate.promise)
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(authority.invoke(lease, 'invocation', async () => 2), /capacity/)
  gate.resolve(1)
  assert.equal(await first, 1)
})

test('generation, release, liveness, and revocation fail closed', async () => {
  let live = true
  const authority = new HostWorkerAuthority({ owner: {}, generation: 7, ownerIsLive: () => live })
  const lease = authority.admit('run', 'worker')
  await assert.rejects(authority.invoke({ ...lease, generation: 8 }, 'invocation', async () => 1), /lease is not live/)
  authority.release(lease)
  await assert.rejects(authority.invoke(lease, 'invocation', async () => 1), /lease is not live/)
  const second = authority.admit('run', 'second')
  live = false
  await assert.rejects(authority.invoke(second, async () => 1), /owner is no longer live/)
  live = true
  authority.revoke(new Error('retired'))
  assert.throws(() => authority.admit('run', 'third'), /retired/)
})

test('retirement aborts in-flight invocation and records uncertain dispatched outcome', async () => {
  const authority = new HostWorkerAuthority({ owner: {}, generation: 1, ownerIsLive: () => true })
  const lease = authority.admit('run', 'worker')
  const entered = deferred()
  const pending = authority.invoke(lease, 'invocation', async signal => {
    entered.resolve()
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  await entered.promise
  authority.revoke(new Error('bridge retired'))
  await assert.rejects(pending, /bridge retired/)
  assert.equal(authority.snapshot().records.at(-1).state, 'outcome-unknown')
})

test('deadline cancellation is terminal and never retries operation', async () => {
  const authority = new HostWorkerAuthority({ owner: {}, generation: 1, defaultDeadlineMs: 10, ownerIsLive: () => true })
  const lease = authority.admit('run', 'worker')
  let calls = 0
  await assert.rejects(authority.invoke(lease, 'invocation', async signal => {
    calls += 1
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }), /timeout|aborted/i)
  assert.equal(calls, 1)
  assert.equal(authority.snapshot().records.at(-1).state, 'outcome-unknown')
})

test('stale lease cannot resurrect after same worker id is re-admitted', async () => {
  const authority = new HostWorkerAuthority({ owner: {}, generation: 1, ownerIsLive: () => true })
  const stale = authority.admit('old-run', 'worker')
  authority.release(stale)
  const fresh = authority.admit('new-run', 'worker')
  await assert.rejects(authority.invoke(stale, 'invocation', async () => 1), /lease is not live/)
  assert.equal(await authority.invoke(fresh, 'invocation', async () => 2), 2)
})

test('records are bounded and expose eviction metadata', async () => {
  const authority = new HostWorkerAuthority({ owner: {}, generation: 1, maxRecords: 2, ownerIsLive: () => true })
  const lease = authority.admit('run', 'worker')
  for (let index = 0; index < 4; index += 1) await authority.invoke(lease, 'invocation', async () => index)
  const snapshot = authority.snapshot()
  assert.equal(snapshot.records.length, 2)
  assert.equal(snapshot.evicted, 2)
})

test('uncooperative timed-out work remains quarantined and consumes capacity', async () => {
  const authority = new HostWorkerAuthority({ owner: {}, generation: 1, maxInFlight: 1, defaultDeadlineMs: 5, ownerIsLive: () => true })
  const lease = authority.admit('run', 'worker')
  await assert.rejects(authority.invoke(lease, 'invocation', async () => await new Promise(() => {})), /timeout|aborted/i)
  assert.equal(authority.snapshot().quarantined, 1)
  await assert.rejects(authority.invoke(lease, 'invocation', async () => 2), /capacity/)
})

test('deployment hard bounds reject oversized configuration and caller deadline', async () => {
  assert.throws(() => new HostWorkerAuthority({ owner: {}, generation: 1, maxWorkers: 65, ownerIsLive: () => true }), /no greater than 64/)
  const authority = new HostWorkerAuthority({ owner: {}, generation: 1, ownerIsLive: () => true })
  const lease = authority.admit('run', 'worker')
  await assert.rejects(authority.invoke(lease, 'invocation', async () => 1, 120_001), /no greater than 120000/)
})

test('forged release cannot cancel a fresh re-admission', async () => {
  const authority = new HostWorkerAuthority({ owner: {}, generation: 1, ownerIsLive: () => true })
  const stale = authority.admit('old', 'worker')
  authority.release(stale)
  const fresh = authority.admit('fresh', 'worker')
  assert.throws(() => authority.release(stale), /lease is not live/)
  assert.equal(await authority.invoke(fresh, 'invocation', async () => 7), 7)
})

test('synchronous operation failure releases a shared permit', async () => {
  let permits = 0
  const authority = new HostWorkerAuthority({ owner: {}, generation: 1, ownerIsLive: () => true, acquirePermit: () => { permits += 1 }, releasePermit: () => { permits -= 1 } })
  const lease = authority.admit('run', 'worker')
  await assert.rejects(authority.invoke(lease, 'sync-failure', () => { throw new Error('sync') }), /sync/)
  assert.equal(permits, 0)
})

test('typed uncertain result survives terminal record ring eviction', async () => {
  const authority = new HostWorkerAuthority({ owner: {}, generation: 1, maxRecords: 1, defaultDeadlineMs: 5, ownerIsLive: () => true })
  const lease = authority.admit('run', 'worker')
  let caught
  try { await authority.invoke(lease, 'uncertain', async () => await new Promise(() => {})) } catch (error) { caught = error }
  assert.equal(caught instanceof WorkerInvocationError, true)
  assert.equal(caught.outcomeUnknown, true)
  await authority.invoke(lease, 'later', async () => 'ok')
  assert.equal(authority.snapshot().evicted, 1)
  assert.equal(caught.outcomeUnknown, true)
  assert.match(caught.effectId, /^[0-9a-f-]{36}$/)
})

test('shared permit remains held through retirement quarantine and frees exactly once', async () => {
  let permits = 0
  const acquirePermit = () => { if (permits >= 1) throw new Error('global capacity'); permits += 1 }
  const releasePermit = () => { permits -= 1 }
  const options = { generation: 1, ownerIsLive: () => true, acquirePermit, releasePermit }
  const first = new HostWorkerAuthority({ ...options, owner: {} })
  const second = new HostWorkerAuthority({ ...options, owner: {} })
  const one = first.admit('run1', 'worker1'); const two = second.admit('run2', 'worker2')
  const gate = deferred()
  const pending = first.invoke(one, 'held', async signal => { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return await gate.promise })
  await new Promise(resolve => setImmediate(resolve)); first.revoke(new Error('retired'))
  await assert.rejects(pending, error => error instanceof WorkerInvocationError && error.outcomeUnknown)
  assert.equal(permits, 1)
  await assert.rejects(second.invoke(two, 'blocked', async () => 1), /global capacity/)
  gate.resolve('late'); await new Promise(resolve => setImmediate(resolve))
  assert.equal(permits, 0)
  assert.equal(await second.invoke(two, 'recovered', async () => 2), 2)
  assert.equal(permits, 0)
})
