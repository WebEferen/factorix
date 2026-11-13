import type { RunEvent } from '@factorix/runtime'

const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

/** One event as terminal text, or null for what a person following a run does not need. */
export function renderEvent(event: RunEvent): string | null {
  switch (event.type) {
    case 'run.started':
      return `▸ started on ${event.model} (${event.runtime})`
    case 'message':
      if (event.partial) return null
      return event.role === 'user' ? `you: ${event.text}` : event.text
    case 'tool.call':
      return `  → ${event.tool}${event.summary ? `: ${event.summary}` : ''}`
    case 'tool.result':
      return event.isError ? `  ✗ ${firstLine(event.output)}` : null
    case 'file.change':
      return `  ± ${event.path} (${event.kind})`
    case 'approval.requested':
      return `? waiting for you (${event.kind}): ${event.summary}\n  fx approve ${event.approvalId}   or   fx reject ${event.approvalId} -m "why"`
    case 'approval.resolved':
      return `  ${event.decision === 'approve' ? 'approved' : 'rejected'} by ${event.by}`
    case 'log':
      return event.level === 'warn' || event.level === 'error' ? `  ! ${event.message}` : null
    case 'error':
      return `error (${event.code}): ${event.message}`
    case 'done': {
      const cost = event.usage.costUsd === undefined ? '' : `, $${event.usage.costUsd.toFixed(2)}`
      return `■ ${event.outcome} after ${event.usage.turns} turns${cost}`
    }
    default:
      return null
  }
}

export function table(rows: string[][]): string {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length)
    })
  }
  return rows.map((row) => row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join('  ')).join('\n')
}
