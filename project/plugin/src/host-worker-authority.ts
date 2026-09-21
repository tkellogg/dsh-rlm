import { randomUUID } from 'node:crypto'

export type WorkerInvocationState = 'succeeded' | 'failed' | 'cancelled' | 'outcome-unknown'

export class WorkerInvocationError extends Error {
  constructor(readonly effectId: string, readonly outcomeUnknown: boolean, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'WorkerInvocationError'
  }
}

export interface WorkerLease {
  readonly runId: string
  readonly workerId: string
  readonly generation: number
  readonly admissionId: string
}

export interface WorkerInvocationRecord {
  readonly effectId: string
  readonly workerId: string
  readonly state: WorkerInvocationState
  readonly startedAt: string
  readonly finishedAt: string
}

export interface WorkerAuthoritySnapshot {
  readonly records: readonly WorkerInvocationRecord[]
  readonly evicted: number
  readonly quarantined: number
  readonly active: readonly Readonly<{ effectId: string, workerId: string, dispatched: boolean, quarantined: boolean }>[]
}

export interface HostWorkerAuthorityOptions<Owner extends object> {
  readonly owner: Owner
  readonly generation: number
  readonly maxWorkers?: number
  readonly maxInFlight?: number
  readonly maxRecords?: number
  readonly defaultDeadlineMs?: number
  readonly ownerIsLive: (owner: Owner) => boolean
  readonly acquirePermit?: () => void
  readonly releasePermit?: () => void
}

interface Admission { readonly runId: string; readonly admissionId: string }
interface Invocation {
  readonly effectId: string
  readonly workerId: string
  readonly invocationId: string
  readonly admissionId: string
  readonly startedAt: string
  readonly controller: AbortController
  dispatched: boolean
  quarantined: boolean
}

const HARD_MAX_WORKERS = 64
const HARD_MAX_IN_FLIGHT = 64
const HARD_MAX_RECORDS = 1024
const HARD_MAX_DEADLINE_MS = 120_000
const DEFAULT_MAX_WORKERS = 16
const DEFAULT_MAX_IN_FLIGHT = 32
const DEFAULT_MAX_RECORDS = 256
const DEFAULT_DEADLINE_MS = 120_000

/** Process-live authority for explicitly admitted Python host workers. */
export class HostWorkerAuthority<Owner extends object> {
  private readonly owner: Owner
  private readonly generation: number
  private readonly maxWorkers: number
  private readonly maxInFlight: number
  private readonly maxRecords: number
  private readonly defaultDeadlineMs: number
  private readonly ownerIsLive: (owner: Owner) => boolean
  private readonly acquirePermit: () => void
  private readonly releasePermit: () => void
  private readonly runController = new AbortController()
  private readonly workers = new Map<string, Admission>()
  private readonly invocations = new Map<string, Invocation>()
  private readonly records: WorkerInvocationRecord[] = []
  private sequence = 0
  private admissionSequence = 0
  private evicted = 0

  constructor(options: HostWorkerAuthorityOptions<Owner>) {
    this.owner = options.owner
    this.generation = options.generation
    this.maxWorkers = boundedOption('maxWorkers', options.maxWorkers ?? DEFAULT_MAX_WORKERS, HARD_MAX_WORKERS)
    this.maxInFlight = boundedOption('maxInFlight', options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT, HARD_MAX_IN_FLIGHT)
    this.maxRecords = boundedOption('maxRecords', options.maxRecords ?? DEFAULT_MAX_RECORDS, HARD_MAX_RECORDS)
    this.defaultDeadlineMs = boundedOption('defaultDeadlineMs', options.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS, HARD_MAX_DEADLINE_MS)
    this.ownerIsLive = options.ownerIsLive
    this.acquirePermit = options.acquirePermit ?? (() => undefined)
    this.releasePermit = options.releasePermit ?? (() => undefined)
  }

  admit(runId: string, workerId: string): WorkerLease {
    this.assertLive()
    if (!validId(runId) || !validId(workerId)) throw new TypeError('runId and workerId must be 1-256 printable ASCII characters')
    if (this.workers.has(workerId)) throw new Error(`worker already admitted: ${workerId}`)
    if (this.workers.size >= this.maxWorkers) throw new Error('host worker capacity reached')
    this.admissionSequence += 1
    const admissionId = randomUUID()
    this.workers.set(workerId, { runId, admissionId })
    return Object.freeze({ runId, workerId, generation: this.generation, admissionId })
  }

  release(lease: WorkerLease, reason: unknown = new Error('host worker released')): void {
    this.requireLease(lease)
    this.workers.delete(lease.workerId)
    for (const invocation of this.invocations.values()) if (invocation.admissionId === lease.admissionId) invocation.controller.abort(reason)
  }

  async invoke<T>(lease: WorkerLease, invocationId: string, operation: (signal: AbortSignal, effectId: string, owner: Owner) => Promise<T>, deadlineMs = this.defaultDeadlineMs): Promise<T> {
    this.assertLive()
    this.requireLease(lease)
    if (!validId(invocationId)) throw new TypeError('invocationId must be 1-256 printable ASCII characters')
    boundedOption('deadlineMs', deadlineMs, HARD_MAX_DEADLINE_MS)
    if (this.invocations.size >= this.maxInFlight) throw new Error('host worker invocation capacity reached')
    this.sequence += 1
    const effectId = randomUUID()
    const invocation: Invocation = { effectId, workerId: lease.workerId, invocationId, admissionId: lease.admissionId, startedAt: new Date().toISOString(), controller: new AbortController(), dispatched: false, quarantined: false }
    this.assertLive()
    this.acquirePermit()
    this.invocations.set(effectId, invocation)
    const fused = AbortSignal.any([this.runController.signal, AbortSignal.timeout(deadlineMs), invocation.controller.signal])
    invocation.dispatched = true
    let operationPromise: Promise<T>
    try { operationPromise = Promise.resolve(operation(fused, effectId, this.owner)) } catch (error) { operationPromise = Promise.reject(error) }
    let rejectAbort!: (reason: unknown) => void
    const onAbort = (): void => { rejectAbort(fused.reason) }
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
      if (fused.aborted) reject(fused.reason)
      else fused.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const result = await Promise.race([operationPromise, abortPromise])
      if (fused.aborted) throw fused.reason
      this.finish(invocation, 'succeeded')
      this.invocations.delete(effectId)
      this.releasePermit()
      return result
    } catch (error) {
      if (!fused.aborted) {
        this.finish(invocation, 'failed')
        this.invocations.delete(effectId)
        this.releasePermit()
        throw error
      }
      invocation.quarantined = true
      this.finish(invocation, 'outcome-unknown')
      void operationPromise.then(() => this.settleQuarantine(effectId), () => this.settleQuarantine(effectId))
      throw new WorkerInvocationError(effectId, true, error)
    } finally {
      fused.removeEventListener('abort', onAbort)
    }
  }

  cancel(lease: WorkerLease, invocationId: string, reason: unknown = new Error('host worker invocation cancelled')): boolean {
    this.requireLease(lease)
    const invocation = [...this.invocations.values()].find(item => item.admissionId === lease.admissionId && item.invocationId === invocationId)
    if (invocation === undefined) return false
    invocation.controller.abort(reason)
    return true
  }

  revoke(reason: unknown = new Error('host worker authority revoked')): void {
    if (!this.runController.signal.aborted) this.runController.abort(reason)
    this.workers.clear()
    for (const invocation of this.invocations.values()) invocation.controller.abort(reason)
  }

  snapshot(): WorkerAuthoritySnapshot {
    const active = [...this.invocations.values()].map(item => Object.freeze({ effectId: item.effectId, workerId: item.workerId, dispatched: item.dispatched, quarantined: item.quarantined }))
    return Object.freeze({ records: Object.freeze(this.records.map(record => Object.freeze({ ...record }))), evicted: this.evicted, quarantined: active.filter(item => item.quarantined).length, active: Object.freeze(active) })
  }

  private settleQuarantine(effectId: string): void { if (this.invocations.delete(effectId)) this.releasePermit() }
  private assertLive(): void {
    if (this.runController.signal.aborted) throw this.runController.signal.reason
    if (!this.ownerIsLive(this.owner)) throw new Error('host worker owner is no longer live')
  }
  private requireLease(lease: WorkerLease): void {
    if (typeof lease !== 'object' || lease === null || typeof lease.workerId !== 'string') throw new Error('host worker lease is not live')
    const admission = this.workers.get(lease.workerId)
    if (lease.generation !== this.generation || admission === undefined || admission.runId !== lease.runId || admission.admissionId !== lease.admissionId) throw new Error('host worker lease is not live')
  }
  private finish(invocation: Invocation, state: WorkerInvocationState): void {
    this.records.push(Object.freeze({ effectId: invocation.effectId, workerId: invocation.workerId, state, startedAt: invocation.startedAt, finishedAt: new Date().toISOString() }))
    while (this.records.length > this.maxRecords) { this.records.shift(); this.evicted += 1 }
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[\x20-\x7e]+$/.test(value)
}

function boundedOption(name: string, value: number, hardMax: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > hardMax) throw new RangeError(`${name} must be a positive safe integer no greater than ${hardMax}`)
  return value
}
