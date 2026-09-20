export const MAX_SOURCE_BYTES = 1024 * 1024
export const MAX_LINE_BYTES = 2 * 1024 * 1024

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

export function parseBridgeResponse(line: string): BridgeResponse {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (cause) {
    throw new Error('Python bridge emitted invalid JSON', { cause })
  }
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new Error('Python bridge emitted an invalid response envelope')
  }
  if (value.ok === true) {
    if (typeof value.id !== 'string' || !Object.hasOwn(value, 'result')) {
      throw new Error('Python bridge emitted an invalid success response')
    }
    return { id: value.id, ok: true, result: value.result }
  }
  if ((typeof value.id !== 'string' && value.id !== null) || !isRecord(value.error)
    || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') {
    throw new Error('Python bridge emitted an invalid failure response')
  }
  return {
    id: value.id,
    ok: false,
    error: { code: value.error.code, message: value.error.message },
  }
}
