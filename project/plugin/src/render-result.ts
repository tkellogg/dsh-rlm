import type { ExecuteResult } from './protocol.js'

export function renderResult(value: ExecuteResult): string {
  if (value.execution.status === 'not_executed') {
    // A recovery gate is transport-successful but did not run Python.
    const notice = value.recovery_notice ?? 'Python runtime recovery is required.'
    return `${notice}\nSubmitted Python cell was not executed (recovery_gate); review runtime.recovery and run it again if still appropriate.`
  }
  const sections: string[] = []
  if (value.recovery_notice !== null) sections.push(`Recovery notice:
${value.recovery_notice}`)
  if (value.cell === null) sections.push('Python cell result was unavailable.')
  else {
    if (value.cell.stdout.length > 0) sections.push(`stdout:
${value.cell.stdout}`)
    if (value.cell.stderr.length > 0) sections.push(`stderr:
${value.cell.stderr}`)
    if (value.cell.display !== null) sections.push(value.cell.display)
    if (!value.cell.ok) {
      const heading = [value.cell.error_type, value.cell.error_message].filter(Boolean).join(': ')
      const error = value.cell.traceback ?? heading
      if (error.length > 0) sections.push(error)
    }
  }
  if (value.checkpoint?.notice_error !== null && value.checkpoint?.notice_error !== undefined) {
    sections.push(`Checkpoint failed: ${value.checkpoint.notice_error}`)
  }
  if (value.checkpoint !== null && value.checkpoint.newly_skipped.length > 0) {
    const shown = value.checkpoint.newly_skipped.slice(0, 20).map(issue => `${issue.name}: ${issue.reason}`)
    const remaining = value.checkpoint.newly_skipped.length - shown.length
    if (remaining > 0) shown.push(`... and ${remaining} more`)
    sections.push(`New user state is not recoverable:
${shown.join('\n')}\nInspect checkpoint.skipped for the full inventory.`)
  }
  if (sections.length === 0) sections.push('Python cell completed successfully.')
  return sections.join('\n\n')
}
