import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  MAX_LINE_BYTES,
  MAX_SOURCE_BYTES,
  isCloseResult,
  isExecuteResult,
  parseBridgeResponse,
  type BridgeRequest,
  type ExecuteResult,
} from './protocol.js'

const STDERR_MAX_BYTES = 64 * 1024
const TERMINATE_GRACE_MS = 2_000
const CLOSE_WAIT_MS = 2_000

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
      let line = Buffer.concat(this.fragments, this.byteLength).toString('utf8')
      this.fragments.length = 0
      this.byteLength = 0
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length === 0) throw new BridgeProtocolError('Python bridge emitted an empty response line')
      this.emit(line)
      offset = newline + 1
    }
  }
}

interface PendingResponse {
  id: string
  method: BridgeRequest['method']
  resolve(value: unknown): void
  reject(error: unknown): void
}

export interface BridgePoolOptions {
  cwd?: string
  python?: string
  stateRoot?: string
}

interface ResolvedOptions {
  cwd: string
  python: string
  stateRoot: string
}

export function sanitizeAgentId(agentId: string): string {
  const normalized = agentId.normalize('NFKC')
  const replaced = normalized.replace(/[^A-Za-z0-9._-]+/g, '_')
  const trimmed = replaced.replace(/^[._-]+|[._-]+$/g, '').slice(0, 80)
  if (trimmed.length > 0 && trimmed !== '.' && trimmed !== '..' && trimmed === normalized) return trimmed
  const stem = trimmed.length > 0 && trimmed !== '.' && trimmed !== '..' ? trimmed : 'agent'
  const digest = createHash('sha256').update(agentId).digest('hex').slice(0, 12)
  return `${stem}-${digest}`
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
  private readonly decoder: BoundedLineDecoder

  constructor(
    readonly key: string,
    private readonly handle: SubprocessHandle,
    private readonly onStopped: (client: BridgeClient) => void,
  ) {
    if (handle.stdin === undefined || handle.stdout === undefined) {
      throw new BridgeProtocolError('Subprocess provider did not expose requested Python bridge pipes')
    }
    this.decoder = new BoundedLineDecoder(MAX_LINE_BYTES, line => { this.onLine(line) })
    handle.stdout.on('data', (chunk: Buffer | string) => {
      try {
        this.decoder.push(chunk)
      } catch (error) {
        this.stop(error)
      }
    })
    handle.stdout.once('error', error => { this.stop(error) })
    handle.stdin.once('error', error => { this.stop(error) })
    void handle.done.then(
      outcome => {
        this.stop(new Error(
          `Python bridge exited (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})${stderrTail(handle)}`,
        ), false)
      },
      error => { this.stop(new Error(`Python bridge process failed${stderrTail(handle)}`, { cause: error }), false) },
    )
  }

  get busy(): boolean {
    return this.pending !== undefined
  }

  async execute(source: string): Promise<ExecuteResult> {
    if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
      throw new RangeError(`Python source exceeds ${MAX_SOURCE_BYTES} UTF-8 bytes`)
    }
    const result = await this.exchange({ id: this.nextId(), method: 'execute', source })
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
    this.stop(reason)
  }

  async waitForExit(): Promise<void> {
    await this.handle.waitForExit(AbortSignal.timeout(CLOSE_WAIT_MS)).catch(() => false)
  }

  private nextId(): string {
    this.sequence += 1
    return String(this.sequence)
  }

  private async exchange(request: BridgeRequest): Promise<unknown> {
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
        resolve: resolveResponse,
        reject: rejectResponse,
      }
    })
    try {
      await write(this.handle.stdin as Writable, line)
    } catch (error) {
      this.stop(error)
      throw error
    }
    return response
  }

  private onLine(line: string): void {
    const pending = this.pending
    if (pending === undefined) {
      this.stop(new BridgeProtocolError('Python bridge emitted an unsolicited response'))
      return
    }
    let response
    try {
      response = parseBridgeResponse(line)
      if (response.id !== pending.id) {
        throw new BridgeProtocolError(
          `Python bridge response id mismatch: expected ${pending.id}, received ${String(response.id)}`,
        )
      }
    } catch (error) {
      this.stop(error)
      return
    }
    this.pending = undefined
    if (response.ok) pending.resolve(response.result)
    else pending.reject(new BridgeRemoteError(response.error.code, response.error.message))
  }

  private stop(reason: unknown, terminate = true): void {
    if (this.stopped) return
    this.stopped = true
    const error = reason instanceof Error ? reason : new Error(String(reason))
    const pending = this.pending
    this.pending = undefined
    pending?.reject(error)
    this.onStopped(this)
    if (terminate) this.handle.terminate()
  }
}

function write(stream: Writable, data: string): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    stream.write(data, 'utf8', error => {
      if (error === null || error === undefined) resolveWrite()
      else rejectWrite(error)
    })
  })
}

export class BridgePool {
  private readonly clients = new Map<string, BridgeClient>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly generations = new Map<string, number>()
  private readonly options: ResolvedOptions
  private disposed = false
  private pythonPath: Promise<string> | undefined

  constructor(
    private readonly subprocess: SubprocessRuntime,
    options: BridgePoolOptions = {},
  ) {
    const cwd = options.cwd ?? process.cwd()
    this.options = {
      cwd,
      python: options.python ?? process.env.DSH_RLM_PYTHON ?? 'python3',
      stateRoot: resolve(cwd, options.stateRoot ?? process.env.DSH_RLM_STATE_DIR ?? '.dsh-rlm'),
    }
  }

  async execute(agentId: string, source: string, signal: AbortSignal): Promise<ExecuteResult> {
    const key = String(agentId)
    const generation = this.generations.get(key) ?? 0
    return this.serialized(key, async () => {
      signal.throwIfAborted()
      if ((this.generations.get(key) ?? 0) !== generation) {
        throw new Error('execute_python owner was disposed before execution')
      }
      if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
        throw new RangeError(`Python source exceeds ${MAX_SOURCE_BYTES} UTF-8 bytes`)
      }
      const client = await this.get(key, generation)
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
        return await client.execute(source)
      } catch (error) {
        signal.throwIfAborted()
        throw error
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    })
  }

  async disposeAgent(agentId: string): Promise<void> {
    const key = String(agentId)
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
    const client = this.clients.get(key)
    if (client === undefined) return
    this.clients.delete(key)
    await this.closeClient(client)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const clients = [...this.clients.values()]
    this.clients.clear()
    await Promise.allSettled(clients.map(async client => { await this.closeClient(client) }))
    this.queues.clear()
  }

  private async serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('DSH RLM bridge pool is disposed')
    const prior = this.queues.get(key) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.queues.set(key, tail)
    try {
      return await run
    } finally {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    }
  }

  private async get(key: string, generation: number): Promise<BridgeClient> {
    if (this.disposed) throw new Error('DSH RLM bridge pool is disposed')
    if ((this.generations.get(key) ?? 0) !== generation) {
      throw new Error('execute_python owner was disposed before bridge creation')
    }
    const existing = this.clients.get(key)
    if (existing !== undefined) return existing
    const python = await this.resolvePython()
    if (this.disposed) throw new Error('DSH RLM bridge pool is disposed')
    if ((this.generations.get(key) ?? 0) !== generation) {
      throw new Error('execute_python owner was disposed during bridge creation')
    }
    const raced = this.clients.get(key)
    if (raced !== undefined) return raced
    const sessionDir = resolve(this.options.stateRoot, sanitizeAgentId(key))
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
      client = new BridgeClient(key, handle, stopped => {
        if (this.clients.get(key) === stopped) this.clients.delete(key)
      })
    } catch (error) {
      handle.terminate()
      throw error
    }
    this.clients.set(key, client)
    return client
  }

  private async resolvePython(): Promise<string> {
    const existing = this.pythonPath
    if (existing !== undefined) return existing
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
      await client.waitForExit()
      return
    }
    try {
      await Promise.race([
        client.close(),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => { reject(new Error('Python bridge close timed out')) }, CLOSE_WAIT_MS)
          timer.unref()
        }),
      ])
    } catch {
      // The process may already have exited. terminate() is idempotent.
    } finally {
      client.terminate(new Error('Python bridge closed'))
      await client.waitForExit()
    }
  }
}
