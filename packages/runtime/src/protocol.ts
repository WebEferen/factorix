import type { RunCommand } from './commands'
import type { RunEvent } from './events'
import type { RunSpec } from './spec'

export const JOURNAL_FILE = 'events.jsonl'

export function encodeLine(value: RunEvent | RunCommand | RunSpec): string {
  return `${JSON.stringify(value)}\n`
}

export function decodeEvent(line: string): RunEvent | null {
  try {
    const value = JSON.parse(line) as Partial<RunEvent>
    return typeof value.seq === 'number' && typeof value.type === 'string' ? (value as RunEvent) : null
  } catch {
    return null
  }
}

export function decodeCommand(line: string): RunCommand | null {
  try {
    const value = JSON.parse(line) as Partial<RunCommand>
    return typeof value.type === 'string' ? (value as RunCommand) : null
  } catch {
    return null
  }
}

/** Splits a byte stream into complete lines, keeping any trailing fragment for the next chunk. */
export class LineSplitter {
  private buffer = ''

  push(chunk: string): string[] {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    return lines.filter((line) => line.length > 0)
  }

  flush(): string | null {
    const rest = this.buffer
    this.buffer = ''
    return rest.length > 0 ? rest : null
  }
}
