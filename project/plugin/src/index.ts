import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BridgePool, type BridgePoolOptions } from './bridge-client.js'
import type { ExecuteResult } from './protocol.js'

export const name = 'dsh-rlm'
export const inject = ['tools', 'subprocess']

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

/** Register the native execute_python tool and its owner-scoped bridge pool. */
export function apply(ctx: Context, config: Config = {}): void {
  const pool = new BridgePool(ctx.subprocess, config)

  ctx.effect(() => async () => {
    await pool.dispose()
  }, 'dsh-rlm Python bridge cleanup')

  ctx.on('agent/disposed', ({ agent }) => {
    void pool.disposeAgent(String(agent.id))
  })

  ctx.tools.register(defineTool({
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
      const agent = exec.agent
      if (agent === undefined) throw new Error('execute_python requires an owning agent')
      return pool.execute(String(agent.id), args.source, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Execute Python' }),
  }))
}

export type { CellResult, CheckpointResult, ExecuteResult, ValueIssue } from './protocol.js'
