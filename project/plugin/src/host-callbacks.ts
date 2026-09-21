import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BlockAssembler,
  ReasoningEffortId,
  ToolCallId,
  createUserMessage,
  type GenerateOptions,
  type LlmCallConfig,
} from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { sanitizeAgentId, type BridgeCallbackDispatcher } from './bridge-client.js'
import type { CallbackRequest, WorkerLeaseWire, WorkerRequest } from './protocol.js'
import { HostWorkerAuthority, WorkerInvocationError, type WorkerLease } from './host-worker-authority.js'

const DENIED_TOOLS = new Set(['execute_python', 'subagent_fork'])
// Cooperative pressure ceiling across both host inbox lists. The caller may
// narrow it, but cannot reserve capacity or raise this deployment-owned bound.
const DRIVER_INBOX_HARD_LIMIT = 64

export interface HostCallbackExecution {
  readonly outer: ToolRunContext
  toolTail: Promise<void>
  toolSequence: number
  callbackSource?: AbortSignal
  callbackSignal?: AbortSignal
}

export function createHostCallbackExecution(outer: ToolRunContext): HostCallbackExecution {
  return { outer, toolTail: Promise.resolve(), toolSequence: 0 }
}

function hostError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

function requireExecution(value: unknown): HostCallbackExecution {
  if (typeof value !== 'object' || value === null || !('outer' in value)
    || !('toolTail' in value) || !('toolSequence' in value)) {
    throw hostError('CALLBACK_CONTEXT_MISSING', 'Host callback has no owning tool execution')
  }
  return value as HostCallbackExecution
}

function requireLiveAgent(ctx: Context, execution: HostCallbackExecution): Agent {
  const agent = execution.outer.agent
  if (agent === undefined) throw hostError('AGENT_REQUIRED', 'Host callback requires an owning agent')
  if (ctx.agents.get(agent.id) !== agent) {
    throw hostError('AGENT_DISPOSED', 'Host callback owning agent is no longer live')
  }
  return agent
}

function fusedSignal(execution: HostCallbackExecution, callback: AbortSignal): AbortSignal {
  if (execution.callbackSignal !== undefined) {
    if (execution.callbackSource !== callback) {
      throw hostError('CALLBACK_SIGNAL_MISMATCH', 'Host callbacks changed signal within one execute')
    }
    return execution.callbackSignal
  }
  execution.callbackSource = callback
  execution.callbackSignal = AbortSignal.any([
    execution.outer.signal,
    callback,
    AbortSignal.timeout(120_000),
  ])
  return execution.callbackSignal
}

function serializeToolCall<T>(execution: HostCallbackExecution, operation: () => Promise<T>): Promise<T> {
  const run = execution.toolTail.then(operation, operation)
  execution.toolTail = run.then(() => undefined, () => undefined)
  return run
}

/** Build the dispatcher used by one shared BridgePool. */
export function createHostCallbackDispatcher(ctx: Context): BridgeCallbackDispatcher {
  let globalWorkerPermits = 0
  const acquirePermit = (): void => { if (globalWorkerPermits >= 64) throw hostError('WORKER_GLOBAL_CAPACITY', 'Global host worker capacity reached'); globalWorkerPermits += 1 }
  const releasePermit = (): void => { globalWorkerPermits = Math.max(0, globalWorkerPermits - 1) }
  const runs = new Map<string, { authority: HostWorkerAuthority<Agent>, owner: Agent, lifetimes: Map<string, { timer: ReturnType<typeof setTimeout>, expiresAt: number }> }>()
  return {
    async dispatch(request, rawExecution, callbackSignal) {
      const execution = requireExecution(rawExecution)
      const agent = requireLiveAgent(ctx, execution)
      const signal = fusedSignal(execution, callbackSignal)
      signal.throwIfAborted()
      return await ctx.agents.withInitiator(agent, async () => {
        if (request.method === 'tools.list') {
          return ctx.tools.schemas(agent).filter(schema => !DENIED_TOOLS.has(schema.name))
        }
        if (request.method === 'tools.call') {
          return await serializeToolCall(execution, async () => {
            signal.throwIfAborted()
            return await callTool(ctx, request, execution, agent, signal)
          })
        }
        if (request.method === 'mailbox.delivery') {
          return deliverMailbox(ctx, request, execution, agent, signal)
        }
        return await completeModel(ctx, request, agent, signal)
      })
    },
    async dispatchWorker(request, rawExecution, bridgeInstanceId) {
      if (request.kind === 'worker_admit') {
        try {
          const agent = requireLiveAgent(ctx, requireExecution(rawExecution))
          let run = runs.get(bridgeInstanceId)
          if (run === undefined) {
            run = { authority: new HostWorkerAuthority({ owner: agent, generation: 0, ownerIsLive: owner => ctx.agents.get(owner.id) === owner, acquirePermit, releasePermit }), owner: agent, lifetimes: new Map() }
            runs.set(bridgeInstanceId, run)
          } else if (run.owner !== agent) throw hostError('AGENT_MISMATCH', 'Worker bridge owner changed')
          const lease = run.authority.admit(request.run_id, request.worker_id)
          if (request.lifetime_ms !== null) {
            const timer = setTimeout(() => { try { run?.authority.release(lease, hostError('WORKER_EXPIRED', 'Host worker lifetime expired')) } catch { /* already released */ }; run?.lifetimes.delete(lease.admissionId) }, request.lifetime_ms)
            run.lifetimes.set(lease.admissionId, { timer, expiresAt: Date.now() + request.lifetime_ms })
          }
          return { kind: 'worker_admit_result', id: request.id, ok: true, lease: toWireLease(lease) }
        } catch (error) { return simpleWorkerFailure('worker_admit_result', request.id, error) }
      }
      const run = runs.get(bridgeInstanceId)
      if (run === undefined) { const error = hostError('LEASE_INVALID', 'host worker lease is not live'); return request.kind === 'worker_invoke' ? invokeWorkerFailure(request.id, null, error, false) : simpleWorkerFailure(request.kind === 'worker_release' ? 'worker_release_result' : 'worker_cancel_result', request.id, error) }
      const lease = fromWireLease(request.lease)
      if (request.kind === 'worker_cancel') {
        try { return { kind: 'worker_cancel_result', id: request.id, ok: true, cancelled: run.authority.cancel(lease, request.invocation_id) } }
        catch (error) { return simpleWorkerFailure('worker_cancel_result', request.id, error) }
      }
      if (request.kind === 'worker_release') {
        try { run.authority.release(lease); const lifetime = run.lifetimes.get(lease.admissionId); if (lifetime !== undefined) clearTimeout(lifetime.timer); run.lifetimes.delete(lease.admissionId); return { kind: 'worker_release_result', id: request.id, ok: true, released: true } }
        catch (error) { return simpleWorkerFailure('worker_release_result', request.id, error) }
      }
      const lifetime = run.lifetimes.get(lease.admissionId)
      if (lifetime !== undefined && Date.now() >= lifetime.expiresAt) { try { run.authority.release(lease, hostError('WORKER_EXPIRED', 'Host worker lifetime expired')) } catch { /* expired concurrently */ }; return invokeWorkerFailure(request.id, null, hostError('WORKER_EXPIRED', 'Host worker lifetime expired'), false) }
      let effectId: string | null = null
      try {
        const result = await run.authority.invoke(lease, request.id, async (signal, freshEffectId, agent) => {
          effectId = freshEffectId
          if (ctx.agents.get(agent.id) !== agent) throw hostError('AGENT_DISPOSED', 'Host worker owner is no longer live')
          return await ctx.agents.withInitiator(agent, async () => await dispatchFreshWorker(ctx, request, agent, signal, freshEffectId))
        }, request.timeout_ms)
        return { kind: 'worker_result', id: request.id, ok: true, effect_id: effectId, result }
      } catch (error) {
        if (error instanceof WorkerInvocationError) return invokeWorkerFailure(request.id, error.effectId, error, error.outcomeUnknown)
        return invokeWorkerFailure(request.id, effectId, error, false)
      }
    },
    revokeWorkers(bridgeInstanceId, reason) { const run = runs.get(bridgeInstanceId); if (run !== undefined) { for (const lifetime of run.lifetimes.values()) clearTimeout(lifetime.timer); run.lifetimes.clear(); run.authority.revoke(reason); runs.delete(bridgeInstanceId) } },
  }
}

function deliverMailbox(
  ctx: Context,
  request: CallbackRequest,
  execution: HostCallbackExecution,
  agent: Agent,
  signal: AbortSignal,
): { message_id: string, accepted_at: string } {
  signal.throwIfAborted()
  if (ctx.agents.get(agent.id) !== agent || execution.outer.agent !== agent) {
    throw hostError('AGENT_DISPOSED', 'Mailbox owner is no longer the live agent')
  }
  if (request.params.mailbox_id !== sanitizeAgentId(String(agent.id))) {
    throw hostError('MAILBOX_DESTINATION_MISMATCH', 'Mailbox destination does not belong to this bridge owner')
  }
  const requestedCapacity = request.params.capacity as number
  const pressureLimit = Math.min(requestedCapacity, DRIVER_INBOX_HARD_LIMIT)
  if (agent.inbox.nextTurn.length + agent.inbox.nextStep.length >= pressureLimit) {
    throw hostError('MAILBOX_FULL', `Driver inbox pressure limit reached (${pressureLimit})`)
  }
  const body = request.params.body
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-rlm' },
  })
  const mode = request.params.mode
  // These methods synchronously splice the durable DSH inbox before returning.
  // No await may separate the authority check from admission.
  if (mode === 'followup') agent.followup(message)
  else if (mode === 'inject') agent.inject(message)
  else agent.steer(message)
  return { message_id: String(message.id), accepted_at: new Date().toISOString() }
}

async function callTool(
  ctx: Context,
  request: CallbackRequest,
  execution: HostCallbackExecution,
  agent: Agent,
  signal: AbortSignal,
): Promise<unknown> {
  const toolName = request.params.name as string
  if (DENIED_TOOLS.has(toolName)) {
    throw hostError('REENTRANT_TOOL_DENIED', `Host callback cannot call ${toolName}`)
  }
  execution.toolSequence += 1
  const callId = ToolCallId(`${String(execution.outer.callId)}:rlm:${execution.toolSequence}`)
  const result = await ctx.tools.execute({
    callId,
    rootCallId: execution.outer.rootCallId,
    parent: execution.outer.token,
    name: toolName,
    arguments: request.params.arguments,
    agent,
    signal,
  })
  for (const context of result.additionalContexts ?? []) execution.outer.deferContext(context)
  if (result.concludesTurn) execution.outer.concludeTurn()
  if (result.isError) {
    throw hostError(result.error.info?.code ?? 'TOOL_ERROR', result.error.message)
  }
  return result.value
}

async function completeModel(
  ctx: Context,
  request: CallbackRequest,
  agent: Agent,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted()
  const params = request.params
  const header = agent.session.requestHeader()?.config
  const fallback = agent.options
  const baseProvider = header?.provider ?? fallback.provider
  const baseModel = header?.model ?? fallback.model
  const explicitRoute = typeof params.provider === 'string' && typeof params.model === 'string'
  const provider = explicitRoute ? params.provider as string : baseProvider
  const model = explicitRoute ? params.model as string : baseModel
  if (provider === undefined || model === undefined) {
    throw hostError('MODEL_ROUTE_REQUIRED', 'models.complete requires a provider and model route')
  }

  const sameRoute = provider === baseProvider && model === baseModel
  const inheritedEffort = header?.reasoningEffort ?? fallback.reasoningEffort
  const reasoningEffort = typeof params.reasoning_effort === 'string'
    ? ReasoningEffortId(params.reasoning_effort)
    : (!explicitRoute || sameRoute ? inheritedEffort : undefined)
  const maxTokens = typeof params.max_tokens === 'number'
    ? params.max_tokens
    : (header?.maxTokens ?? fallback.maxTokens)
  const message = createUserMessage({
    content: [{ type: 'text', text: params.prompt as string }],
    source: { kind: 'plugin', plugin: 'dsh-rlm' },
  })
  const proposedConfig: LlmCallConfig = {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(header?.temperature === undefined ? {} : { temperature: header.temperature }),
    ...(header?.stop === undefined ? {} : { stop: [...header.stop] }),
  }
  const prepared = await ctx.llm.prepareCall(proposedConfig, signal)
  const options: GenerateOptions = {
    ...prepared.config,
    messages: [message],
    tools: [],
    signal,
    sessionId: agent.id,
    ...(typeof params.system === 'string' ? { system: params.system } : {}),
  }
  const assembler = new BlockAssembler()
  let sawFinish = false
  for await (const chunk of prepared.stream(options)) {
    signal.throwIfAborted()
    if (chunk.type === 'finish') sawFinish = true
    assembler.push(chunk)
  }
  if (!sawFinish) throw hostError('STREAM_INCOMPLETE', 'models.complete stream ended without a finish chunk')
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw hostError(finish.failure.code, finish.failure.message)
  }
  const blocks = assembler.blocks()
  if (finish.kind === 'tool-calls' || blocks.some(block => block.type === 'tool-call')) {
    throw hostError('UNEXPECTED_TOOL_CALL', 'models.complete returned an unexpected tool call')
  }
  const text = blocks
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return {
    text,
    provider: prepared.config.provider,
    model: prepared.config.model,
    finish,
    usage: assembler.usage ?? null,
  }
}
function toWireLease(lease: WorkerLease): WorkerLeaseWire { return { run_id: lease.runId, worker_id: lease.workerId, generation: lease.generation, admission_id: lease.admissionId } }
function fromWireLease(lease: WorkerLeaseWire): WorkerLease { return { runId: lease.run_id, workerId: lease.worker_id, generation: lease.generation, admissionId: lease.admission_id } }
function errorParts(error: unknown): { code: string, message: string } { return { code: (error as { code?: string })?.code ?? 'WORKER_ERROR', message: (error instanceof Error ? error.message : String(error)).slice(0, 8192) } }
function simpleWorkerFailure(kind: string, id: string, error: unknown): Record<string, unknown> { return { kind, id, ok: false, error: errorParts(error) } }
function invokeWorkerFailure(id: string, effectId: string | null, error: unknown, outcomeUnknown: boolean): Record<string, unknown> { return { kind: 'worker_result', id, ok: false, effect_id: effectId, error: { ...errorParts(error), outcome_unknown: outcomeUnknown } } }

async function dispatchFreshWorker(ctx: Context, request: Extract<WorkerRequest, { kind: 'worker_invoke' }>, agent: Agent, signal: AbortSignal, effectId: string): Promise<unknown> {
  signal.throwIfAborted()
  if (request.method === 'tools.list') return ctx.tools.schemas(agent).filter(schema => !DENIED_TOOLS.has(schema.name))
  if (request.method === 'tools.call') {
    const toolName = request.params.name as string
    if (DENIED_TOOLS.has(toolName)) throw hostError('REENTRANT_TOOL_DENIED', `Host worker cannot call ${toolName}`)
    const result = await ctx.tools.execute({ callId: ToolCallId(`rlm-worker:${effectId}`), name: toolName, arguments: request.params.arguments, agent, signal })
    if (result.isError) throw hostError(result.error.info?.code ?? 'TOOL_ERROR', result.error.message)
    return result.value
  }
  return await completeModel(ctx, { kind: 'callback', id: request.id, parent_id: request.id, method: 'models.complete', params: request.params }, agent, signal)
}
