export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type ChoiceQuestion = { type: 'choice', instructions?: JsonValue, criteria: Record<string, JsonValue> }
export type ScoreQuestion = { type: 'score', instructions?: JsonValue, criteria: JsonValue[] }
export type NoulQuestion = { type: 'noul', instructions?: JsonValue, criteria?: { true?: JsonValue, false?: JsonValue } | null }
export type JudgeQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion
export interface JudgeRequest { state: JsonValue, questions: Record<string, JudgeQuestion>, model?: string, timeout_ms?: number }
export interface JudgeResult { model: string, answers: Record<string, JsonValue>, usage?: { input_tokens: number, output_tokens: number } }
export type JevErrorCode = 'INVALID_REQUEST'|'TRANSPORT'|'TIMEOUT'|'AUTH'|'RATE_LIMIT'|'SERVER'|'MALFORMED_RESPONSE'|'ABORTED'

export class JevError extends Error {
  constructor(readonly code: JevErrorCode, message: string, readonly status?: number) { super(message); this.name = 'JevError' }
}
export interface JevClientConfig { apiKey?: string, apiKeyEnv?: string, baseURL?: string, model?: string, timeoutMs?: number, fetch?: typeof fetch }

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function finiteJson(value: unknown, depth=0): value is JsonValue {
  if (depth > 20) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => finiteJson(item, depth+1))
  return record(value) && Object.keys(value).length <= 1000 && Object.values(value).every(item => finiteJson(item, depth+1))
}
function validateRequest(request: JudgeRequest): void {
  if (!finiteJson(request.state) || !record(request.questions) || Object.keys(request.questions).length === 0 || Object.keys(request.questions).length > 100) throw new JevError('INVALID_REQUEST','judge request requires bounded JSON state and 1..100 questions')
  for (const [id,q] of Object.entries(request.questions)) {
    if (!id || id.length > 256 || !record(q) || !['choice','score','noul'].includes(String(q.type))) throw new JevError('INVALID_REQUEST','invalid judge question')
    if (q.type === 'choice' && (!record(q.criteria) || Object.keys(q.criteria).length < 2)) throw new JevError('INVALID_REQUEST','choice requires at least two criteria')
    if (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10)) throw new JevError('INVALID_REQUEST','score requires 2..10 criteria')
    if (!finiteJson(q)) throw new JevError('INVALID_REQUEST','question must be bounded JSON')
  }
  if (request.timeout_ms !== undefined && (!Number.isSafeInteger(request.timeout_ms) || request.timeout_ms <= 0 || request.timeout_ms > 120000)) throw new JevError('INVALID_REQUEST','timeout_ms must be in 1..120000')
}
function validateResult(value: unknown, questions: Record<string,JudgeQuestion>): JudgeResult {
  if (!record(value) || typeof value.model !== 'string' || !record(value.answers)) throw new JevError('MALFORMED_RESPONSE','Jev returned an invalid response')
  const expected=Object.keys(questions); const actual=Object.keys(value.answers); if (actual.length !== expected.length || expected.some(id => !Object.hasOwn(value.answers as object,id))) throw new JevError('MALFORMED_RESPONSE','Jev response answer IDs do not match questions')
  for (const id of expected) { const answer=(value.answers as Record<string,unknown>)[id]; const question=questions[id]; if (question === undefined || !record(answer) || answer.type !== question.type || !finiteJson(answer)) throw new JevError('MALFORMED_RESPONSE','Jev returned an invalid typed answer') }
  const usage=record(value.usage) && Number.isSafeInteger(value.usage.input_tokens) && Number.isSafeInteger(value.usage.output_tokens) ? {input_tokens:value.usage.input_tokens as number,output_tokens:value.usage.output_tokens as number}:undefined
  return {model:value.model,answers:value.answers as Record<string,JsonValue>,...(usage===undefined?{}:{usage})}
}
export class JevClient {
  constructor(private readonly config: JevClientConfig={}) {}
  get available(): boolean { return Boolean((this.config.apiKey ?? process.env[this.config.apiKeyEnv ?? 'TYPESAFE_API_KEY'])?.trim()) }
  async judge(request: JudgeRequest, signal?: AbortSignal): Promise<JudgeResult|null> {
    validateRequest(request)
    const key=(this.config.apiKey ?? process.env[this.config.apiKeyEnv ?? 'TYPESAFE_API_KEY'])?.trim(); if (!key) return null
    const timeout=request.timeout_ms ?? this.config.timeoutMs ?? 10000; const timeoutSignal=AbortSignal.timeout(timeout); const fused=signal===undefined?timeoutSignal:AbortSignal.any([signal,timeoutSignal])
    const base=(this.config.baseURL ?? 'https://api.typesafe.ai').replace(/\/$/,''); let response:Response
    try { response=await (this.config.fetch ?? fetch)(`${base}/v1/systemone`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({state:request.state,model:request.model ?? this.config.model ?? 'jev-latest',questions:request.questions}),signal:fused,redirect:'error'}) }
    catch(error) { if (signal?.aborted) throw new JevError('ABORTED','Jev call aborted'); if (timeoutSignal.aborted) throw new JevError('TIMEOUT','Jev call timed out'); throw new JevError('TRANSPORT','Jev transport failed') }
    if (!response.ok) { const code=response.status===401||response.status===403?'AUTH':response.status===429?'RATE_LIMIT':response.status>=500?'SERVER':'TRANSPORT'; throw new JevError(code,'Jev request failed',response.status) }
    let value:unknown; try { value=await response.json() } catch { throw new JevError('MALFORMED_RESPONSE','Jev returned invalid JSON') }
    return validateResult(value,request.questions)
  }
  async safeJudge(request: JudgeRequest, signal?: AbortSignal): Promise<JudgeResult|null> { try { return await this.judge(request,signal) } catch(error) { if (signal?.aborted) throw error; return null } }
}
