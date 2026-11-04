export const MAX_TOOL_OUTPUT_CHARS = 20_000

export function truncateOutput(output: string): { output: string; truncated?: boolean } {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return { output }
  const half = MAX_TOOL_OUTPUT_CHARS / 2
  return {
    output: `${output.slice(0, half)}\n... ${output.length - MAX_TOOL_OUTPUT_CHARS} characters omitted ...\n${output.slice(-half)}`,
    truncated: true,
  }
}

export function summarizeInput(tool: string, input: unknown): string {
  if (input !== null && typeof input === 'object') {
    const record = input as Record<string, unknown>
    for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
      const value = record[key]
      if (typeof value === 'string') return `${tool} ${value}`.slice(0, 200)
    }
  }
  return tool
}
