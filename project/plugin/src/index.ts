import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type {} from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BridgePool, type BridgePoolOptions } from './bridge-client.js'
import { createHostCallbackDispatcher, createHostCallbackExecution } from './host-callbacks.js'
import type { ExecuteResult } from './protocol.js'

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
    error: { ...nullableString, required: true },
  },
  additionalProperties: false,
} as const

const executeOutput = {
  type: 'object',
  properties: {
    cell: {
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
      required: true,
    },
    checkpoint: {
      oneOf: [checkpoint, { type: 'null' }],
      required: true,
    },
    recovery_notice: { ...nullableString, required: true },
  },
  additionalProperties: false,
} as const

function renderResult(value: ExecuteResult): string {
  const sections: string[] = []
  if (value.recovery_notice !== null) {
    sections.push(`Recovery notice:\n${value.recovery_notice}`)
  }
  if (value.cell.stdout.length > 0) sections.push(`stdout:\n${value.cell.stdout}`)
  if (value.cell.stderr.length > 0) sections.push(`stderr:\n${value.cell.stderr}`)
  if (value.cell.display !== null) sections.push(value.cell.display)
  if (!value.cell.ok) {
    const heading = [value.cell.error_type, value.cell.error_message].filter(Boolean).join(': ')
    const error = value.cell.traceback ?? heading
    if (error.length > 0) sections.push(error)
  }
  if (value.checkpoint !== null && !value.checkpoint.ok) {
    sections.push(`Checkpoint failed: ${value.checkpoint.error ?? 'unknown error'}`)
  }
  if (value.checkpoint !== null && value.checkpoint.skipped.length > 0) {
    const shown = value.checkpoint.skipped.slice(0, 20)
      .map(issue => `${issue.name}: ${issue.reason}`)
    const remaining = value.checkpoint.skipped.length - shown.length
    if (remaining > 0) shown.push(`... and ${remaining} more`)
    sections.push(`Checkpoint skipped values (not recoverable):\n${shown.join('\n')}`)
  }
  if (sections.length === 0) sections.push('Python cell completed successfully.')
  return sections.join('\n\n')
}

/** Register the native execute_python tool in this preset's standing tool scope. */
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
      if (owner === undefined || ctx.agents.get(owner.id) !== owner
        || !ctx.agents.roots().includes(owner)) {
        throw new Error('execute_python requires a live root agent')
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

export type { CellResult, CheckpointResult, ExecuteResult, ValueIssue } from './protocol.js'
