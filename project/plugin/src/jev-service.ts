import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-settings'
import { JevClient, JevError, type JudgeRequest, type JudgeResult } from './judge.js'

export interface JevSettings {
  enabled: boolean
  apiKeyEnv: string
  model: string
  timeoutMs: number
  baseURL: string
}

/** References only: secret values belong to DSH's credentials provider. */
export const Config = z.object({
  enabled: z.boolean().default(true).description('Enable optional Jev judging. Without a credential no requests are made.'),
  apiKeyEnv: z.string().role('credential-ref').default('TYPESAFE_API_KEY').description('API key managed by Harness credentials; environment configuration is also supported.'),
  model: z.string().default('jev-latest').description('Jev model used for structured judgments.'),
  timeoutMs: z.number().step(1).min(1).max(120000).default(10000).description('Request timeout in milliseconds.'),
  baseURL: z.string().default('https://api.typesafe.ai').description('Advanced: trusted endpoint root. Your API key and explicit state are sent to this server.'),
})

export function validateSettings(value: JevSettings): void {
  credentialRef(value.apiKeyEnv)
  if (!value.model.trim() || value.model.length > 256) throw new Error('Jev model must be a non-empty identifier of at most 256 characters')
  let url: URL
  try { url = new URL(value.baseURL) } catch { throw new Error('Jev endpoint must be a valid HTTPS root') }
  // Do not permit credentials to be sent over plaintext or hidden in URL fields.
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Jev endpoint must be an HTTPS root without a path, credentials, query, or fragment')
  }
}

export interface JevStatus {
  state: 'disabled' | 'not-configured' | 'configured'
  credentialSource: string | null
  model: string
  baseURL: string
}
export interface JevTestResult { ok: boolean; code: string; message: string }

declare module '@deepseek-ai/cordis' {
  interface Context { jev: JevService }
}

/** Optional, non-generative service shared by Harness callers and the RLM bridge. */
export class JevService extends Service {
  private _current: () => JevSettings
  private _fetch: typeof fetch | undefined
  private _lifetime = new AbortController()
  private _testing = false

  constructor(ctx: Context, entry: Partial<JevSettings> = {}, transport?: typeof fetch) {
    super(ctx, 'jev')
    const resolved = Config(entry) as JevSettings
    validateSettings(resolved)
    this._current = () => resolved
    this._fetch = transport
    ctx.effect(() => () => this._lifetime.abort())
    ctx.inject(['settings'], settingsCtx => {
      settingsCtx.settings.installSection(ctx, 'jev', Config, resolved, {
        setSource: source => { this._current = source },
        onChange: () => {},
        validate: validateSettings,
      })
    })
  }

  private async credentialOperation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this._current().timeoutMs)
    const fused = AbortSignal.any([this._lifetime.signal, timeout, ...(signal ? [signal] : [])])
    const abortError = () => new JevError(timeout.aborted ? 'TIMEOUT' : 'ABORTED', 'Jev credential operation interrupted')
    if (fused.aborted) throw abortError()
    let onAbort!: () => void
    try {
      return await Promise.race([
        Promise.resolve().then(operation).catch(() => { throw new JevError('AUTH', 'Jev credentials are unavailable') }),
        new Promise<never>((_, reject) => { onAbort = () => reject(abortError()); fused.addEventListener('abort', onAbort, { once: true }) }),
      ])
    } finally { fused.removeEventListener('abort', onAbort) }
  }

  async status(signal?: AbortSignal): Promise<JevStatus> {
    const config = this._current()
    const credentials = this.ctx.get('credentials')
    const info = credentials === undefined ? undefined : await this.credentialOperation(() => credentials.describe(credentialRef(config.apiKeyEnv)), signal)
    const ambient = credentials === undefined ? launchEnvironmentOf(this.ctx).get(config.apiKeyEnv) : undefined
    const configured = info?.configured ?? Boolean(ambient?.value.trim())
    return {
      state: !config.enabled ? 'disabled' : configured ? 'configured' : 'not-configured',
      credentialSource: info?.source ?? (ambient?.value.trim() ? ambient.source : null),
      model: config.model,
      baseURL: config.baseURL,
    }
  }

  async judge(request: JudgeRequest, signal?: AbortSignal): Promise<JudgeResult | null> {
    const fused = signal === undefined ? this._lifetime.signal : AbortSignal.any([signal, this._lifetime.signal])
    fused.throwIfAborted()
    const config = this._current()
    if (!config.enabled) return null
    const credentials = this.ctx.get('credentials')
    const key = credentials === undefined
      ? launchEnvironmentOf(this.ctx).get(config.apiKeyEnv)?.value
      : (await this.credentialOperation(() => credentials.resolve(credentialRef(config.apiKeyEnv)), fused))?.value
    fused.throwIfAborted()
    const latest = this._current()
    if (!latest.enabled || JSON.stringify(latest) !== JSON.stringify(config)) return null
    // An explicit blank prevents the standalone client's process.env fallback.
    const client = new JevClient({ apiKey: key ?? '', model: config.model, timeoutMs: config.timeoutMs,
      baseURL: config.baseURL, ...(this._fetch === undefined ? {} : { fetch: this._fetch }) })
    return await client.judge(request, fused)
  }

  async safeJudge(request: JudgeRequest, signal?: AbortSignal): Promise<JudgeResult | null> {
    try { return await this.judge(request, signal) }
    catch (error) {
      if (!(error instanceof JevError) || error.code === 'INVALID_REQUEST' || error.code === 'ABORTED' || signal?.aborted || this._lifetime.signal.aborted) throw error
      return null
    }
  }

  /** Fixed explicit test only: no conversation, caller state, or secret in the reply. */
  async testConnection(signal?: AbortSignal): Promise<JevTestResult> {
    if (this._testing) return { ok: false, code: 'BUSY', message: 'A connection test is already running.' }
    this._testing = true
    try {
      const status = await this.status(signal)
      if (status.state !== 'configured') return { ok: false, code: status.state, message: status.state === 'disabled' ? 'Jev is disabled.' : 'No API key is configured.' }
      const result = await this.judge({ state: { purpose: 'Jev connection test', word: 'hello' }, questions: {
        greeting: { type: 'choice', instructions: 'Classify the word.', criteria: { greeting: 'A greeting', other: 'Anything else' } },
      } }, signal)
      return result === null ? { ok: false, code: 'NOT_CONFIGURED', message: 'No judge decision is available.' }
        : { ok: true, code: 'OK', message: 'Jev returned a structured answer. Connection verified.' }
    } catch (error) {
      if (signal?.aborted || this._lifetime.signal.aborted || (error instanceof JevError && error.code === 'ABORTED')) throw new JevError('ABORTED', 'Jev call aborted')
      // Never echo provider text, request state, credentials, or arbitrary error messages.
      return { ok: false, code: error instanceof JevError ? error.code : 'UNAVAILABLE', message: 'Connection test failed. Check the credential, endpoint, and network.' }
    } finally { this._testing = false }
  }
}

export const name = 'dsh-jev'
export function apply(ctx: Context, config: Partial<JevSettings> = {}): void { ctx.plugin(JevService, config) }
