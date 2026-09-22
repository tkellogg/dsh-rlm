import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type {} from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BridgePool, type BridgePoolOptions } from './bridge-client.js'
import { createHostCallbackDispatcher, createHostCallbackExecution } from './host-callbacks.js'
import { isRlmAgent } from './policy.js'
import type { ExecuteResult } from './protocol.js'
export { JevClient, JevError } from './judge.js'
export type { JudgeRequest, JudgeResult, JudgeQuestion, ChoiceQuestion, ScoreQuestion, NoulQuestion, JevClientConfig } from './judge.js'
import { renderResult } from './render-result.js'

export const name = 'dsh-rlm'
export const inject = ['tools', 'subprocess', 'agents', 'llm']

/** Optional overrides. Environment variables remain the normal configuration path. */
export interface Config extends BridgePoolOptions {}

const nullableString = {
  oneOf: [
    { type: 'string' },
    { type: 'null' },
  ],
} as const

const valueIssue = {
  type: 'object',
  properties: {
    name: { type: 'string', required: true },
    reason: { type: 'string', required: true },
  },
  additionalProperties: false,
} as const

const checkpoint = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', required: true },
    checkpoint_id: { type: 'string', required: true },
    created_at: { type: 'string', required: true },
    byte_count: { type: 'integer', required: true },
    saved: { type: 'array', items: { type: 'string' }, required: true },
    skipped: { type: 'array', items: valueIssue, required: true },
    newly_skipped: { type: 'array', items: valueIssue, required: true },
    notice_error: { ...nullableString, required: true },
    error: { ...nullableString, required: true },
  },
  additionalProperties: false,
} as const

const execution = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['executed', 'not_executed'], required: true },
    reason: { oneOf: [{ type: 'string', enum: ['recovery_gate'] }, { type: 'null' }], required: true },
  },
  additionalProperties: false,
} as const

const executeCell = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', required: true },
    stdout: { type: 'string', required: true },
    stderr: { type: 'string', required: true },
    display: { ...nullableString, required: true },
    error_type: { ...nullableString, required: true },
    error_message: { ...nullableString, required: true },
    traceback: { ...nullableString, required: true },
  },
  additionalProperties: false,
} as const

const executeOutput = {
  type: 'object',
  properties: {
    execution: { ...execution, required: true },
    cell: { oneOf: [executeCell, { type: 'null' }], required: true },
    checkpoint: {
      oneOf: [checkpoint, { type: 'null' }],
      required: true,
    },
    recovery_notice: { ...nullableString, required: true },
  },
  additionalProperties: false,
} as const

/** Register execute_python with one isolated bridge per live RLM agent identity. */
export function apply(ctx: Context, config: Config = {}): void {
  const pool = new BridgePool(ctx.subprocess, config, createHostCallbackDispatcher(ctx))
  const tool = defineTool({
    name: 'execute_python',
    description: "Execute a Python cell in this agent's persistent RLM session. Variables and imports persist across calls, and successful cells are checkpointed for crash recovery.",
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: 'Python source code. Top-level await is supported.',
      },
    },
    output: {
      schema: executeOutput,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args, exec) {
      const owner = exec.agent
      if (owner === undefined || ctx.agents.get(owner.id) !== owner || !isRlmAgent(owner)) {
        throw new Error('execute_python requires a live RLM agent')
      }
      return await pool.execute(
        String(owner.id),
        args.source,
        exec.signal,
        createHostCallbackExecution(exec),
      )
    },
    presentCall: () => ({ card: 'generic', title: 'Execute Python' }),
  })

  ctx.effect(() => {
    const unregister = ctx.tools.register(tool)
    return async () => {
      unregister()
      await pool.dispose()
    }
  }, 'dsh-rlm Python bridge and tool cleanup')

  const retireAgent = (agentId: string): void => {
    void pool.disposeAgent(agentId).catch(error => {
      ctx.logger.warn(`dsh-rlm: failed to retire Python bridge for agent ${agentId}: ${String(error)}`)
    })
  }
  ctx.on('agent/disposed', ({ agent }) => { retireAgent(String(agent.id)) })
  ctx.on('agent-preset/selected', (sessionId, preset) => {
    if (preset !== 'rlm') retireAgent(String(sessionId))
  })
}

export type { CellResult, CheckpointResult, ExecuteResult, ExecutionOutcome, ValueIssue } from './protocol.js'
