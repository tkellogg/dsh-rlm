import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import yaml from 'js-yaml'
import { renderResult } from '../lib/render-result.js'

const jsExpression = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: source => source })
const schema = yaml.DEFAULT_SCHEMA.extend([jsExpression])
const loadYaml = path => yaml.load(readFileSync(path, 'utf8'), { schema })
const compactionRow = document => document.find(row => row?.id === 'compaction')

test('RLM compaction group matches the shipped Standard preset structurally', () => {
  const rlm = loadYaml(new URL('../presets/rlm/agent.cordis.yml', import.meta.url))
  const standard = loadYaml(new URL('../node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml', import.meta.url))
  const actual = compactionRow(rlm)
  assert.deepEqual(actual, compactionRow(standard))
  assert.deepEqual(actual, {
    id: 'compaction', name: 'cordis:group', group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: {
        thresholdChars: 8192, headChars: 4096, tailChars: 1024,
      } },
    ],
  })
})

function installedRequire() {
  const executable = process.env.PATH.split(delimiter).map(dir => join(dir, 'dsh')).find(existsSync)
  assert.ok(executable, 'the installed dsh executable must be on PATH')
  return createRequire(realpathSync(executable))
}

test('installed pruner preserves recovery prefix and nonrecoverable checkpoint tail', async () => {
  // Resolve from the installed dsh entry point, never from a machine-specific npm path.
  const modulePath = installedRequire().resolve('@deepseek-ai/dsh-compaction-tool-result-pruner')
  const { ToolResultPruner, PRUNE_MARKER } = await import(modulePath)
  const recovery = 'MANDATORY RECOVERY: restored durable state before continuing.'
  const noticeError = 'CHECKPOINT FAILURE: disk write rejected.'
  const skipped = 'NONRECOVERABLE WARNING: live_socket cannot be serialized.'
  const rendered = renderResult({
    recovery_notice: recovery,
    cell: { ok: true, stdout: 'x'.repeat(12000), stderr: '', display: null,
      error_type: null, error_message: null, traceback: null },
    checkpoint: { ok: false, checkpoint_id: 'cp', created_at: 'now', byte_count: 0,
      saved: [], skipped: [{ name: 'live_socket', reason: skipped }],
      newly_skipped: [{ name: 'live_socket', reason: skipped }], notice_error: noticeError, error: noticeError },
  })
  assert.ok(rendered.startsWith(`Recovery notice:\n${recovery}`))
  assert.ok(rendered.endsWith(`live_socket: ${skipped}\nInspect checkpoint.skipped for the full inventory.`))
  assert.ok(rendered.length > 8192)

  // Instantiate the actual installed implementation; pruneContent is its public service method.
  const pruner = Object.create(ToolResultPruner.prototype)
  pruner.config = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
  const [block] = pruner.pruneContent([{ type: 'text', text: rendered }])
  assert.equal(block.text, rendered.slice(0, 4096) + PRUNE_MARKER + rendered.slice(-1024))
  assert.ok(block.text.startsWith(`Recovery notice:\n${recovery}`), 'safety recovery beginning survives head retention')
  assert.ok(block.text.includes(`Checkpoint failed: ${noticeError}`), 'checkpoint failure survives tail retention')
  assert.ok(block.text.endsWith(`live_socket: ${skipped}\nInspect checkpoint.skipped for the full inventory.`),
    'nonrecoverable warning remains the final retained text')
})
