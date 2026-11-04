import type { ToolRule } from './spec'

const RULE = /^([A-Za-z0-9_:*.-]+)(?:\((.*)\))?$/

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 's')
}

function subjectOf(tool: string, input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  const key = tool === 'Bash' ? 'command' : 'file_path' in record ? 'file_path' : 'path' in record ? 'path' : 'url' in record ? 'url' : undefined
  const value = key ? record[key] : undefined
  return typeof value === 'string' ? value : ''
}

export function isValidToolRule(rule: string): boolean {
  return RULE.test(rule)
}

/** Matches Claude Code permission rule syntax: `Tool` or `Tool(glob)`. */
export function matchesToolRule(rule: ToolRule, tool: string, input: unknown): boolean {
  const match = RULE.exec(rule)
  if (!match) return false
  const [, toolGlob, argGlob] = match
  if (!globToRegExp(toolGlob ?? '').test(tool)) return false
  if (argGlob === undefined) return true
  return globToRegExp(argGlob).test(subjectOf(tool, input))
}

export function matchesAnyToolRule(rules: readonly ToolRule[], tool: string, input: unknown): boolean {
  return rules.some((rule) => matchesToolRule(rule, tool, input))
}
