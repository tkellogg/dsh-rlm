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
import type { BridgeCallbackDispatcher } from './bridge-client.js'
import type { CallbackRequest } from './protocol.js'

const DENIED_TOOLS = new Set(['execute_python', 'subagent_fork'])

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
        return await completeModel(ctx, request, execution, agent, signal)
      })
    },
  }
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
  execution: HostCallbackExecution,
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
