import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Writable } from 'node:stream'
import { TextDecoder } from 'node:util'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  HOST_CALLBACK_CAPABILITY,
  MAX_CALLBACK_BYTES,
  MAX_CALLBACKS_IN_FLIGHT,
  MAX_CALLBACKS_PER_EXECUTE,
  MAX_LINE_BYTES,
  MAX_SOURCE_BYTES,
  isCloseResult,
  isExecuteResult,
  parseBridgeFrame,
  type BridgeRequest,
  type BridgeResponse,
  type CallbackRequest,
  type CallbackResult,
  type ExecuteResult,
} from './protocol.js'

const STDERR_MAX_BYTES = 64 * 1024
const TERMINATE_GRACE_MS = 2_000
const DEFAULT_LIFECYCLE_WAIT_MS = 2_000
const DEFAULT_CALLBACK_WAIT_MS = 120_000
const CALLBACK_ERROR_MAX_CHARS = 8 * 1024

const callbackBridgeScope = new AsyncLocalStorage<string>()

export interface BridgeCallbackDispatcher {
  dispatch(request: CallbackRequest, context: unknown, signal: AbortSignal): Promise<unknown>
}

class BridgeProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BridgeProtocolError'
  }
}

class BridgeRemoteError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'BridgeRemoteError'
    this.code = code
  }
}

class BoundedLineDecoder {
  private readonly fragments: Buffer[] = []
  private byteLength = 0

  constructor(
    private readonly limit: number,
    private readonly emit: (line: string) => void,
  ) {}

  push(chunk: Buffer | string): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    let offset = 0
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset)
      const end = newline < 0 ? bytes.length : newline
      const fragment = bytes.subarray(offset, end)
      if (this.byteLength + fragment.length > this.limit) {
        throw new BridgeProtocolError(`Python bridge response line exceeds ${this.limit} bytes`)
      }
      if (fragment.length > 0) {
        this.fragments.push(fragment)
        this.byteLength += fragment.length
      }
      if (newline < 0) return
      let line: string
      try {
        line = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(this.fragments, this.byteLength))
      } catch (cause) {
        throw new BridgeProtocolError('Python bridge emitted invalid UTF-8', { cause })
      }
      this.fragments.length = 0
      this.byteLength = 0
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length === 0) throw new BridgeProtocolError('Python bridge emitted an empty response line')
      this.emit(line)
      offset = newline + 1
    }
  }

  finish(): void {
    if (this.byteLength > 0) {
      throw new BridgeProtocolError('Python bridge stdout ended with a partial response frame')
    }
    throw new BridgeProtocolError('Python bridge stdout ended unexpectedly')
  }
}

interface PendingResponse {
  id: string
  method: BridgeRequest['method']
  callbackContext: unknown
  callbackAbort: AbortController
  callbackJobs: Set<Promise<void>>
  callbackJobAborts: Set<AbortController>
  callbackIds: Set<string>
  callbackCount: number
  finalResponse?: BridgeResponse
  finalDrainTimer?: ReturnType<typeof setTimeout>
  resolve(value: unknown): void
  reject(error: unknown): void
}

export interface BridgePoolOptions {
  cwd?: string
  python?: string
  stateRoot?: string
  /** Bounds callback draining, graceful close, and confirmed process retirement. */
  lifecycleWaitMs?: number
  /** Bounds each host callback even when its implementation ignores cancellation. */
  callbackWaitMs?: number
}

interface ResolvedOptions {
  cwd: string
  python: string
  stateRoot: string
  lifecycleWaitMs: number
  callbackWaitMs: number
}

export function sanitizeAgentId(agentId: string): string {
  return `agent-${createHash('sha256').update(agentId, 'utf8').digest('hex')}`
}

function stderrTail(handle: SubprocessHandle): string {
  const read = handle.collected.stderr?.readFrom(0)
  if (read === undefined || read.text.trim().length === 0) return ''
  return `; stderr: ${read.text.trim()}`
}

class BridgeClient {
  private pending: PendingResponse | undefined
  private sequence = 0
  private stopped = false
  private stopPromise: Promise<void> | undefined
  private readonly decoder: BoundedLineDecoder

  constructor(
    readonly key: string,
    private readonly handle: SubprocessHandle,
    private readonly onStopped: (client: BridgeClient) => void,
    private readonly lifecycleWaitMs: number,
    private readonly callbackWaitMs: number,
    private readonly callbackDispatcher?: BridgeCallbackDispatcher,
  ) {
    if (handle.stdin === undefined || handle.stdout === undefined) {
      throw new BridgeProtocolError('Subprocess provider did not expose requested Python bridge pipes')
    }
    this.decoder = new BoundedLineDecoder(MAX_LINE_BYTES, line => { this.onLine(line) })
    handle.stdout.on('data', (chunk: Buffer | string) => {
      try {
        this.decoder.push(chunk)
      } catch (error) {
        void this.stop(error)
      }
    })
    const stdoutEnded = (): void => {
      try {
        this.decoder.finish()
      } catch (error) {
        void this.stop(error)
      }
    }
    handle.stdout.once('end', stdoutEnded)
    handle.stdout.once('close', stdoutEnded)
    handle.stdout.once('error', error => { void this.stop(error) })
    handle.stdin.once('error', error => { void this.stop(error) })
    void handle.done.then(
      outcome => {
        void this.stop(new Error(
          `Python bridge exited (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})${stderrTail(handle)}`,
        ), false)
      },
      error => { void this.stop(new Error(`Python bridge process failed${stderrTail(handle)}`, { cause: error }), false) },
    )
  }

  get busy(): boolean {
    return this.pending !== undefined
  }

  async execute(source: string, callbackContext?: unknown): Promise<ExecuteResult> {
    if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
      throw new RangeError(`Python source exceeds ${MAX_SOURCE_BYTES} UTF-8 bytes`)
    }
    const result = await this.exchange({
      id: this.nextId(),
      method: 'execute',
      source,
      capabilities: [HOST_CALLBACK_CAPABILITY],
    }, callbackContext)
    if (!isExecuteResult(result)) {
      const error = new BridgeProtocolError('Python bridge emitted an invalid execute result')
      this.terminate(error)
      throw error
    }
    return result
  }

  async close(): Promise<void> {
    if (this.stopped) return
    const result = await this.exchange({ id: this.nextId(), method: 'close' })
    if (!isCloseResult(result)) {
      const error = new BridgeProtocolError('Python bridge emitted an invalid close result')
      this.terminate(error)
      throw error
    }
  }

  terminate(reason: unknown = new Error('Python bridge terminated')): void {
    void this.stop(reason)
  }

  async waitForDrain(): Promise<void> {
    await this.stopPromise
  }

  async waitForExit(): Promise<boolean> {
    return await waitForHandleExit(this.handle, this.lifecycleWaitMs)
  }

  private nextId(): string {
    this.sequence += 1
    return String(this.sequence)
  }

  private async exchange(request: BridgeRequest, callbackContext?: unknown): Promise<unknown> {
    if (this.stopped) throw new Error('Python bridge is not running')
    if (this.pending !== undefined) throw new BridgeProtocolError('Concurrent requests reached one Python bridge')
    const line = `${JSON.stringify(request)}\n`
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      throw new RangeError(`Python bridge request line exceeds ${MAX_LINE_BYTES} bytes`)
    }
    const response = new Promise<unknown>((resolveResponse, rejectResponse) => {
      this.pending = {
        id: request.id,
        method: request.method,
        callbackContext,
        callbackAbort: new AbortController(),
        callbackJobs: new Set(),
        callbackJobAborts: new Set(),
        callbackIds: new Set(),
        callbackCount: 0,
        resolve: resolveResponse,
        reject: rejectResponse,
      }
    })
    // The write callback is advisory. Some providers transmit bytes but never invoke it.
    // Stream errors still poison the bridge through send() and the stdin error listener.
    this.send(line)
    return await response
  }

  private onLine(line: string): void {
    const pending = this.pending
    if (pending === undefined) {
      void this.stop(new BridgeProtocolError('Python bridge emitted an unsolicited response'))
      return
    }
    let frame
    try {
      frame = parseBridgeFrame(line)
    } catch (error) {
      void this.stop(error)
      return
    }
    if ('kind' in frame) {
      try {
        this.startCallback(line, frame, pending)
      } catch (error) {
        void this.stop(error)
      }
      return
    }
    if (pending.finalResponse !== undefined) {
      void this.stop(new BridgeProtocolError('Python bridge emitted duplicate final responses'))
      return
    }
    if (frame.id !== pending.id) {
      void this.stop(new BridgeProtocolError(
        `Python bridge response id mismatch: expected ${pending.id}, received ${String(frame.id)}`,
      ))
      return
    }
    pending.finalResponse = frame
    if (pending.callbackJobs.size > 0) {
      pending.callbackAbort.abort(callbackError(
        'CALLBACK_SCOPE_CLOSED',
        'Python execute completed before its host callbacks settled',
      ))
      pending.finalDrainTimer = setTimeout(() => {
        if (this.pending === pending && pending.callbackJobs.size > 0) {
          void this.stop(new BridgeProtocolError('Host callbacks did not drain after the final Python response'))
        }
      }, this.lifecycleWaitMs)
    }
    this.finishPending(pending)
  }

  private startCallback(line: string, request: CallbackRequest, pending: PendingResponse): void {
    if (pending.method !== 'execute') {
      throw new BridgeProtocolError('Python bridge emitted a callback outside execute')
    }
    if (pending.finalResponse !== undefined) {
      throw new BridgeProtocolError('Python bridge emitted a callback after its final response')
    }
    if (Buffer.byteLength(line, 'utf8') > MAX_CALLBACK_BYTES) {
      throw new BridgeProtocolError(`Python bridge callback exceeds ${MAX_CALLBACK_BYTES} bytes`)
    }
    if (request.parent_id !== pending.id) {
      throw new BridgeProtocolError(
        `Python bridge callback parent mismatch: expected ${pending.id}, received ${request.parent_id}`,
      )
    }
    if (pending.callbackIds.has(request.id)) {
      throw new BridgeProtocolError(`Python bridge reused callback id ${request.id}`)
    }
    if (pending.callbackCount >= MAX_CALLBACKS_PER_EXECUTE) {
      throw new BridgeProtocolError(`Python bridge exceeded ${MAX_CALLBACKS_PER_EXECUTE} callbacks per execute`)
    }
    if (pending.callbackJobs.size >= MAX_CALLBACKS_IN_FLIGHT) {
      throw new BridgeProtocolError(`Python bridge exceeded ${MAX_CALLBACKS_IN_FLIGHT} in-flight callbacks`)
    }
    pending.callbackIds.add(request.id)
    pending.callbackCount += 1
    const jobAbort = new AbortController()
    pending.callbackJobAborts.add(jobAbort)
    let job!: Promise<void>
    job = this.runCallback(request, pending, jobAbort.signal)
      .catch(error => { void this.stop(error) })
      .finally(() => {
        pending.callbackJobs.delete(job)
        pending.callbackJobAborts.delete(jobAbort)
        this.finishPending(pending)
      })
    pending.callbackJobs.add(job)
  }

  private async runCallback(
    request: CallbackRequest,
    pending: PendingResponse,
    jobSignal: AbortSignal,
  ): Promise<void> {
    let response: CallbackResult
    try {
      if (this.callbackDispatcher === undefined) {
        throw callbackError('UNSUPPORTED_CALLBACK', 'Host callbacks are not configured')
      }
      const dispatch = callbackBridgeScope.run(this.key, async () => await this.callbackDispatcher!.dispatch(
        request,
        pending.callbackContext,
        pending.callbackAbort.signal,
      ))
      const result = await withDeadline(dispatch, this.callbackWaitMs, jobSignal, () => {
        const error = callbackError('CALLBACK_TIMEOUT', `Host callback exceeded ${this.callbackWaitMs}ms`)
        if (!pending.callbackAbort.signal.aborted) pending.callbackAbort.abort(error)
        return error
      })
      response = { kind: 'callback_result', id: request.id, ok: true, result }
    } catch (error) {
      response = {
        kind: 'callback_result',
        id: request.id,
        ok: false,
        error: normalizeCallbackError(error),
      }
    }
    if (!this.stopped) this.send(callbackResultLine(response))
  }

  private finishPending(pending: PendingResponse): void {
    const response = pending.finalResponse
    if (response === undefined || pending.callbackJobs.size > 0 || this.pending !== pending || this.stopped) return
    if (pending.finalDrainTimer !== undefined) clearTimeout(pending.finalDrainTimer)
    this.pending = undefined
    if (response.ok) pending.resolve(response.result)
    else pending.reject(new BridgeRemoteError(response.error.code, response.error.message))
  }

  private send(data: string): void {
    try {
      ;(this.handle.stdin as Writable).write(data, 'utf8', error => {
        if (error !== null && error !== undefined) void this.stop(error)
      })
    } catch (error) {
      void this.stop(error)
    }
  }

  private stop(reason: unknown, terminate = true): Promise<void> {
    const existing = this.stopPromise
    if (existing !== undefined) return existing

    const stopped = Promise.withResolvers<void>()
    this.stopPromise = stopped.promise
    this.stopped = true
    const error = reason instanceof Error ? reason : new Error(String(reason))
    const pending = this.pending
    if (this.pending === pending) this.pending = undefined
    if (pending?.finalDrainTimer !== undefined) clearTimeout(pending.finalDrainTimer)

    // Install all state guards before invoking abort listeners, pool callbacks, or terminate().
    try { this.onStopped(this) } catch { /* retirement failures surface through the pool */ }
    pending?.reject(error)
    try { pending?.callbackAbort.abort(error) } catch { /* an abort listener must not block shutdown */ }
    for (const controller of pending?.callbackJobAborts ?? []) {
      try { controller.abort(error) } catch { /* an abort listener must not block shutdown */ }
    }
    if (terminate) {
      try { this.handle.terminate() } catch { /* waitForExit will fail closed if termination did not retire */ }
    }

    const jobs = pending === undefined ? [] : [...pending.callbackJobs]
    void boundedSettled(jobs, this.lifecycleWaitMs).then(
      () => { stopped.resolve() },
      () => { stopped.resolve() },
    )
    return stopped.promise
  }
}

async function boundedSettled(jobs: readonly Promise<void>[], timeoutMs: number): Promise<void> {
  if (jobs.length === 0) return
  await new Promise<void>(resolveWait => {
    const timer = setTimeout(resolveWait, timeoutMs)
    void Promise.allSettled(jobs).then(() => {
      clearTimeout(timer)
      resolveWait()
    })
  })
}

function callbackError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

function normalizeCallbackError(error: unknown): { code: string, message: string } {
  const possibleCode = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  const code = typeof possibleCode === 'string' && possibleCode.length > 0
    ? possibleCode.slice(0, 128)
    : 'HOST_CALLBACK_ERROR'
  const message = (error instanceof Error ? error.message : String(error)).slice(0, CALLBACK_ERROR_MAX_CHARS)
  return { code, message: message.length > 0 ? message : 'Host callback failed' }
}

function isStrictJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || ancestors.has(value)) return false

  const prototype = Object.getPrototypeOf(value)
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return false
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || keys.at(-1) !== 'length') return false
    ancestors.add(value)
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
        || !isStrictJsonValue(descriptor.value, ancestors)) {
        ancestors.delete(value)
        return false
      }
    }
    ancestors.delete(value)
    return true
  }
  if (prototype !== Object.prototype && prototype !== null) return false

  ancestors.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      ancestors.delete(value)
      return false
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
      || !isStrictJsonValue(descriptor.value, ancestors)) {
      ancestors.delete(value)
      return false
    }
  }
  ancestors.delete(value)
  return true
}

function callbackFailure(id: string, code: string, message: string): CallbackResult {
  return { kind: 'callback_result', id, ok: false, error: { code, message } }
}

function callbackResultLine(response: CallbackResult): string {
  let serializable = response
  let validPayload = !response.ok
  if (response.ok) {
    try { validPayload = isStrictJsonValue(response.result) } catch { validPayload = false }
  }
  if (!validPayload) {
    serializable = callbackFailure(
      response.id,
      'INVALID_CALLBACK_PAYLOAD',
      'Host callback returned a value that is not strict JSON',
    )
  }

  let encoded: string
  try {
    encoded = JSON.stringify(serializable)
  } catch {
    encoded = JSON.stringify(callbackFailure(
      response.id,
      'INVALID_CALLBACK_PAYLOAD',
      'Host callback returned a value that is not strict JSON',
    ))
  }
  // MAX_CALLBACK_BYTES covers the JSON payload only. The newline is transport framing.
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CALLBACK_BYTES) {
    encoded = JSON.stringify(callbackFailure(
      response.id,
      'CALLBACK_RESULT_TOO_LARGE',
      `Host callback result exceeds ${MAX_CALLBACK_BYTES} bytes`,
    ))
  }
  return `${encoded}\n`
}

function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  timeoutError: () => Error,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolveWait, rejectWait) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const resolveOnce = (value: T): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveWait(value)
    }
    const rejectOnce = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectWait(error)
    }
    const onAbort = (): void => { rejectOnce(signal.reason) }
    const timer = setTimeout(() => { rejectOnce(timeoutError()) }, timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(resolveOnce, rejectOnce)
  })
}

function waitForHandleExit(handle: SubprocessHandle, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const waiting = Promise.resolve()
    .then(async () => await handle.waitForExit(controller.signal))
    .then(exited => exited, () => false)
  return new Promise<boolean>(resolveExit => {
    const timer = setTimeout(() => {
      try { controller.abort(new Error('Python bridge exit wait timed out')) } catch { /* ignore */ }
      resolveExit(false)
    }, timeoutMs)
    void waiting.then(exited => {
      clearTimeout(timer)
      resolveExit(exited)
    })
  })
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    try { signal.throwIfAborted() } catch (error) { return Promise.reject(error) }
  }
  return new Promise<T>((resolveRace, rejectRace) => {
    const onAbort = (): void => {
      try { signal.throwIfAborted() } catch (error) { rejectRace(error) }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(resolveRace, rejectRace).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolveWait, rejectWait) => {
    const timer = setTimeout(() => { rejectWait(new Error(message)) }, timeoutMs)
    void operation.then(
      value => {
        clearTimeout(timer)
        resolveWait(value)
      },
      error => {
        clearTimeout(timer)
        rejectWait(error)
      },
    )
  })
}

export class BridgePool {
  private readonly clients = new Map<string, BridgeClient>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly generations = new Map<string, number>()
  private readonly retirements = new Map<string, Promise<void>>()
  private readonly options: ResolvedOptions
  private disposed = false
  private pythonPath: Promise<string> | undefined

  constructor(
    private readonly subprocess: SubprocessRuntime,
    options: BridgePoolOptions = {},
    private readonly callbackDispatcher?: BridgeCallbackDispatcher,
  ) {
    const cwd = options.cwd ?? process.cwd()
    const lifecycleWaitMs = options.lifecycleWaitMs ?? DEFAULT_LIFECYCLE_WAIT_MS
    const callbackWaitMs = options.callbackWaitMs ?? DEFAULT_CALLBACK_WAIT_MS
    if (!Number.isFinite(lifecycleWaitMs) || lifecycleWaitMs <= 0) {
      throw new RangeError('lifecycleWaitMs must be a positive finite number')
    }
    if (!Number.isFinite(callbackWaitMs) || callbackWaitMs <= 0) {
      throw new RangeError('callbackWaitMs must be a positive finite number')
    }
    this.options = {
      cwd,
      python: options.python ?? process.env.DSH_RLM_PYTHON ?? 'python3',
      stateRoot: resolve(cwd, options.stateRoot ?? process.env.DSH_RLM_STATE_DIR ?? '.dsh-rlm'),
      lifecycleWaitMs,
      callbackWaitMs,
    }
  }

  async execute(
    agentId: string,
    source: string,
    signal: AbortSignal,
    callbackContext?: unknown,
  ): Promise<ExecuteResult> {
    const key = sanitizeAgentId(String(agentId))
    if (callbackBridgeScope.getStore() === key) {
      throw new BridgeProtocolError('execute_python cannot re-enter its active Python bridge')
    }
    const generation = this.generations.get(key) ?? 0
    return await this.serialized(key, signal, async () => {
      signal.throwIfAborted()
      if ((this.generations.get(key) ?? 0) !== generation) {
        throw new Error('execute_python owner was disposed before execution')
      }
      if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
        throw new RangeError(`Python source exceeds ${MAX_SOURCE_BYTES} UTF-8 bytes`)
      }
      const client = await this.get(key, generation, signal)
      if ((this.generations.get(key) ?? 0) !== generation) {
        client.terminate(new Error('execute_python owner was disposed during bridge creation'))
        throw new Error('execute_python owner was disposed during bridge creation')
      }
      if (signal.aborted) {
        client.terminate(signal.reason ?? new Error('execute_python aborted'))
        signal.throwIfAborted()
      }
      const onAbort = (): void => {
        client.terminate(signal.reason ?? new Error('execute_python aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        return await client.execute(source, callbackContext)
      } catch (error) {
        signal.throwIfAborted()
        throw error
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    })
  }

  async disposeAgent(agentId: string): Promise<void> {
    const key = sanitizeAgentId(String(agentId))
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
    const client = this.clients.get(key)
    if (client !== undefined) {
      // Stop synchronously so a new generation cannot reuse a client being retired.
      client.terminate(new Error('Python bridge agent was disposed'))
      await client.waitForDrain()
    }
    const retirement = this.retirements.get(key)
    if (retirement !== undefined) await retirement
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const clients = [...this.clients.values()]
    await Promise.allSettled(clients.map(async client => { await this.closeClient(client) }))
    await Promise.allSettled([...this.retirements.values()])
    this.queues.clear()
  }

  private serialized<T>(
    key: string,
    signal: AbortSignal,
    operation: (() => Promise<T>) | undefined,
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('DSH RLM bridge pool is disposed'))
    const prior = this.queues.get(key) ?? Promise.resolve()
    let started = false
    const dropQueuedOperation = (): void => {
      if (!started) operation = undefined
    }
    signal.addEventListener('abort', dropQueuedOperation, { once: true })
    if (signal.aborted) dropQueuedOperation()
    const start = (): Promise<T> => {
      started = true
      signal.removeEventListener('abort', dropQueuedOperation)
      const current = operation
      operation = undefined
      if (current === undefined) {
        signal.throwIfAborted()
        return Promise.reject(new Error('execute_python operation was cancelled while queued'))
      }
      return current()
    }
    const run = prior.then(start, start)
    const tail = run.then(() => undefined, () => undefined)
    this.queues.set(key, tail)
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    return raceAbort(run, signal)
  }

  private async get(key: string, generation: number, signal: AbortSignal): Promise<BridgeClient> {
    this.assertCanCreate(key, generation, signal, 'before bridge creation')
    const existing = this.clients.get(key)
    if (existing !== undefined) return existing

    const retirement = this.retirements.get(key)
    if (retirement !== undefined) await raceAbort(retirement, signal)
    this.assertCanCreate(key, generation, signal, 'during bridge retirement')
    const afterRetirement = this.clients.get(key)
    if (afterRetirement !== undefined) return afterRetirement

    const python = await raceAbort(this.resolvePython(), signal)
    this.assertCanCreate(key, generation, signal, 'during bridge creation')
    const raced = this.clients.get(key)
    if (raced !== undefined) return raced

    const sessionDir = resolve(this.options.stateRoot, key)
    const handle = this.subprocess.spawn({
      argv: [python, '-m', 'dsh_rlm.bridge', '--session-dir', sessionDir],
      cwd: this.options.cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: STDERR_MAX_BYTES },
      },
      graceMs: TERMINATE_GRACE_MS,
      env: { PYTHONUNBUFFERED: '1' },
    })
    let client: BridgeClient
    try {
      client = new BridgeClient(
        key,
        handle,
        stopped => { this.beginRetirement(key, stopped) },
        this.options.lifecycleWaitMs,
        this.options.callbackWaitMs,
        this.callbackDispatcher,
      )
    } catch (error) {
      this.beginHandleRetirement(key, handle)
      try { handle.terminate() } catch { /* retirement will time out and poison this key */ }
      throw error
    }
    this.clients.set(key, client)
    return client
  }

  private assertCanCreate(key: string, generation: number, signal: AbortSignal, phase: string): void {
    signal.throwIfAborted()
    if (this.disposed) throw new Error('DSH RLM bridge pool is disposed')
    if ((this.generations.get(key) ?? 0) !== generation) {
      throw new Error(`execute_python owner was disposed ${phase}`)
    }
  }

  private beginRetirement(key: string, client: BridgeClient): Promise<void> {
    if (this.clients.get(key) === client) this.clients.delete(key)
    return this.trackRetirement(key, async () => await client.waitForExit())
  }

  private beginHandleRetirement(key: string, handle: SubprocessHandle): Promise<void> {
    return this.trackRetirement(
      key,
      async () => await waitForHandleExit(handle, this.options.lifecycleWaitMs),
    )
  }

  private trackRetirement(key: string, waitForExit: () => Promise<boolean>): Promise<void> {
    const existing = this.retirements.get(key)
    if (existing !== undefined) return existing

    const retirement = (async () => {
      const exited = await waitForExit()
      if (!exited) {
        throw new Error(`Python bridge for ${key} did not exit within ${this.options.lifecycleWaitMs}ms`)
      }
    })()
    this.retirements.set(key, retirement)
    void retirement.then(
      () => {
        if (this.retirements.get(key) === retirement) this.retirements.delete(key)
      },
      () => { /* Retain the rejected promise so this session key stays poisoned. */ },
    )
    return retirement
  }

  private async resolvePython(): Promise<string> {
    const existing = this.pythonPath
    if (existing !== undefined) return await existing
    const resolution = this.subprocess.resolveExecutable(
      this.options.python,
      { PYTHONUNBUFFERED: '1' },
    )
    this.pythonPath = resolution
    try {
      return await resolution
    } catch (error) {
      if (this.pythonPath === resolution) this.pythonPath = undefined
      throw error
    }
  }

  private async closeClient(client: BridgeClient): Promise<void> {
    if (client.busy) {
      client.terminate(new Error('Python bridge disposed during execution'))
    } else {
      try {
        await withTimeout(client.close(), this.options.lifecycleWaitMs, 'Python bridge close timed out')
      } catch {
        // The process may already have exited. terminate() is idempotent.
      } finally {
        client.terminate(new Error('Python bridge closed'))
      }
    }
    await client.waitForDrain()
    const retirement = this.retirements.get(client.key) ?? this.beginRetirement(client.key, client)
    await retirement
  }
}
