export const MAX_SOURCE_BYTES = 1024 * 1024
export const MAX_LINE_BYTES = 2 * 1024 * 1024
export const MAX_CALLBACK_BYTES = 1024 * 1024
export const MAX_CALLBACK_ID_CHARS = 1024
export const MAX_CALLBACKS_IN_FLIGHT = 32
export const MAX_CALLBACKS_PER_EXECUTE = 64
export const HOST_CALLBACK_CAPABILITY = 'host-callback-v1' as const

export interface ValueIssue {
  name: string
  reason: string
}

export interface CellResult {
  ok: boolean
  stdout: string
  stderr: string
  display: string | null
  error_type: string | null
  error_message: string | null
  traceback: string | null
}

export interface CheckpointResult {
  ok: boolean
  checkpoint_id: string
  created_at: string
  byte_count: number
  saved: string[]
  skipped: ValueIssue[]
  error: string | null
}

export interface ExecuteResult {
  cell: CellResult
  checkpoint: CheckpointResult | null
  recovery_notice: string | null
}

export interface ExecuteRequest {
  id: string
  method: 'execute'
  source: string
  capabilities: [typeof HOST_CALLBACK_CAPABILITY]
}

export interface CloseRequest {
  id: string
  method: 'close'
}

export type BridgeRequest = ExecuteRequest | CloseRequest

interface SuccessResponse {
  id: string
  ok: true
  result: unknown
}

interface FailureResponse {
  id: string | null
  ok: false
  error: {
    code: string
    message: string
  }
}

export type BridgeResponse = SuccessResponse | FailureResponse

export type CallbackMethod = 'tools.list' | 'tools.call' | 'models.complete'

export interface CallbackRequest {
  kind: 'callback'
  id: string
  parent_id: string
  method: CallbackMethod
  params: Record<string, unknown>
}

export interface CallbackSuccess {
  kind: 'callback_result'
  id: string
  ok: true
  result: unknown
}

export interface CallbackFailure {
  kind: 'callback_result'
  id: string
  ok: false
  error: {
    code: string
    message: string
  }
}

export type CallbackResult = CallbackSuccess | CallbackFailure
export type BridgeFrame = BridgeResponse | CallbackRequest

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

function isValueIssue(value: unknown): value is ValueIssue {
  return isRecord(value) && typeof value.name === 'string' && typeof value.reason === 'string'
}

function isCellResult(value: unknown): value is CellResult {
  return isRecord(value)
    && typeof value.ok === 'boolean'
    && typeof value.stdout === 'string'
    && typeof value.stderr === 'string'
    && isNullableString(value.display)
    && isNullableString(value.error_type)
    && isNullableString(value.error_message)
    && isNullableString(value.traceback)
}

function isCheckpointResult(value: unknown): value is CheckpointResult {
  return isRecord(value)
    && typeof value.ok === 'boolean'
    && typeof value.checkpoint_id === 'string'
    && typeof value.created_at === 'string'
    && Number.isSafeInteger(value.byte_count)
    && (value.byte_count as number) >= 0
    && Array.isArray(value.saved)
    && value.saved.every(item => typeof item === 'string')
    && Array.isArray(value.skipped)
    && value.skipped.every(isValueIssue)
    && isNullableString(value.error)
}

export function isExecuteResult(value: unknown): value is ExecuteResult {
  return isRecord(value)
    && isCellResult(value.cell)
    && (value.checkpoint === null || isCheckpointResult(value.checkpoint))
    && isNullableString(value.recovery_notice)
}

export function isCloseResult(value: unknown): value is { closed: true } {
  return isRecord(value) && value.closed === true
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch (cause) {
    throw new Error('Python bridge emitted invalid JSON', { cause })
  }
}

function isBoundedCallbackId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CALLBACK_ID_CHARS
}

function validateCallbackParams(method: CallbackMethod, params: Record<string, unknown>): void {
  if (method === 'tools.list') {
    if (!hasExactKeys(params, [])) throw new Error('tools.list callback params must be empty')
    return
  }
  if (method === 'tools.call') {
    if (!hasExactKeys(params, ['name', 'arguments']) || typeof params.name !== 'string'
      || params.name.length === 0 || params.name.length > 1024 || !isRecord(params.arguments)
      || !isJsonValue(params.arguments)) {
      throw new Error('Python bridge emitted invalid tools.call callback params')
    }
    return
  }
  const allowed = ['prompt', 'system', 'provider', 'model', 'reasoning_effort', 'max_tokens']
  if (!Object.keys(params).every(key => allowed.includes(key))
    || typeof params.prompt !== 'string'
    || (Object.hasOwn(params, 'system') && typeof params.system !== 'string')
    || (Object.hasOwn(params, 'provider') && (typeof params.provider !== 'string' || params.provider.length === 0 || params.provider.length > 1024))
    || (Object.hasOwn(params, 'model') && (typeof params.model !== 'string' || params.model.length === 0 || params.model.length > 1024))
    || Object.hasOwn(params, 'provider') !== Object.hasOwn(params, 'model')
    || (Object.hasOwn(params, 'reasoning_effort') && (typeof params.reasoning_effort !== 'string'
      || params.reasoning_effort.length === 0 || params.reasoning_effort.length > 128))
    || (Object.hasOwn(params, 'max_tokens') && (!Number.isSafeInteger(params.max_tokens)
      || (params.max_tokens as number) <= 0 || (params.max_tokens as number) > 1_000_000))) {
    throw new Error('Python bridge emitted invalid models.complete callback params')
  }
}

export function parseBridgeFrame(line: string): BridgeFrame {
  const value = parseJsonLine(line)
  if (isRecord(value) && value.kind === 'callback') {
    if (!hasExactKeys(value, ['kind', 'id', 'parent_id', 'method', 'params'])
      || !isBoundedCallbackId(value.id) || !isBoundedCallbackId(value.parent_id)
      || (value.method !== 'tools.list' && value.method !== 'tools.call' && value.method !== 'models.complete')
      || !isRecord(value.params)) {
      throw new Error('Python bridge emitted an invalid callback envelope')
    }
    validateCallbackParams(value.method, value.params)
    return {
      kind: 'callback',
      id: value.id,
      parent_id: value.parent_id,
      method: value.method,
      params: value.params,
    }
  }
  return parseBridgeResponseValue(value)
}

export function parseBridgeResponse(line: string): BridgeResponse {
  return parseBridgeResponseValue(parseJsonLine(line))
}

function parseBridgeResponseValue(value: unknown): BridgeResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new Error('Python bridge emitted an invalid response envelope')
  }
  if (value.ok === true) {
    if (!hasExactKeys(value, ['id', 'ok', 'result']) || !isBoundedCallbackId(value.id)) {
      throw new Error('Python bridge emitted an invalid success response')
    }
    return { id: value.id, ok: true, result: value.result }
  }
  if (!hasExactKeys(value, ['id', 'ok', 'error'])
    || (value.id !== null && !isBoundedCallbackId(value.id)) || !isRecord(value.error)
    || !hasExactKeys(value.error, ['code', 'message'])
    || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') {
    throw new Error('Python bridge emitted an invalid failure response')
  }
  return {
    id: value.id,
    ok: false,
    error: { code: value.error.code, message: value.error.message },
  }
}
