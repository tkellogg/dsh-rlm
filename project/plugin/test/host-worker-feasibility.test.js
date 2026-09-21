import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'

const turn = () => new Promise(resolve => setImmediate(resolve))

async function fixture(mode) {
  const ctx = new Context()
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(ToolRuntime, { mode })
  await turn()
  const stages = []
  ctx.on('tools/pre-execute', (_exec, next) => { stages.push('pre'); return next() })
  ctx.on('tools/execute', (_exec, next) => { stages.push('execute'); return next() })
  ctx.on('tools/post-execute', (_exec, _result, next) => { stages.push('post'); return next() })
  ctx.tools.register(defineTool({
    name: 'worker_probe',
    description: 'Return a fixture value.',
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute({ value }, exec) {
      return `${value}:${String(exec.callId)}:${String(exec.rootCallId)}`
    },
  }))
  return { ctx, stages }
}

test('fresh parentless root dispatch is supported in native mode and traverses pipeline', async () => {
  const { ctx, stages } = await fixture('native')
  const result = await ctx.tools.execute({
    callId: ToolCallId('worker:1'),
    name: 'worker_probe',
    arguments: { value: 'ok' },
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, false)
  assert.equal(result.value, 'ok:worker:1:worker:1')
  assert.deepEqual(stages, ['pre', 'execute', 'post'])
})

test('effective ptc mode rejects the same parentless native dispatch before policy/body', async () => {
  const { ctx, stages } = await fixture('ptc')
  const result = await ctx.tools.execute({
    callId: ToolCallId('worker:ptc:1'),
    name: 'worker_probe',
    arguments: { value: 'denied' },
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, true)
  assert.equal(result.error.info?.code, 'UNKNOWN_TOOL')
  assert.match(result.error.message, /only `run_code` is callable directly/)
  assert.deepEqual(stages, [])
})

test('both mode permits native fresh-root dispatch through the full pipeline', async () => {
  const { ctx, stages } = await fixture('both')
  const result = await ctx.tools.execute({
    callId: ToolCallId('worker:both:1'),
    name: 'worker_probe',
    arguments: { value: 'ok' },
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, false)
  assert.equal(result.value, 'ok:worker:both:1:worker:both:1')
  assert.deepEqual(stages, ['pre', 'execute', 'post'])
})
