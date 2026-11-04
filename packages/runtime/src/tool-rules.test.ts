import { describe, expect, it } from 'vitest'
import { isValidToolRule, matchesToolRule } from './tool-rules'

describe('matchesToolRule', () => {
  it.each([
    ['Bash', 'Bash', { command: 'ls' }, true],
    ['Bash', 'Read', { file_path: '/x' }, false],
    ['Bash(git push*)', 'Bash', { command: 'git push origin main' }, true],
    ['Bash(git push*)', 'Bash', { command: 'git status' }, false],
    ['Edit(/workspace/.factorix/*)', 'Edit', { file_path: '/workspace/.factorix/spec.json' }, true],
    ['Edit(/workspace/.factorix/*)', 'Edit', { file_path: '/workspace/repo/a.ts' }, false],
    ['mcp__db__*', 'mcp__db__query', {}, true],
    ['Bash(rm -rf *)', 'Bash', null, false],
  ])('%s against %s %j -> %s', (rule, tool, input, expected) => {
    expect(matchesToolRule(rule, tool, input)).toBe(expected)
  })

  it('treats regex metacharacters in a glob literally', () => {
    expect(matchesToolRule('Bash(a.b)', 'Bash', { command: 'axb' })).toBe(false)
    expect(matchesToolRule('Bash(a.b)', 'Bash', { command: 'a.b' })).toBe(true)
  })

  it('rejects malformed rules', () => {
    expect(isValidToolRule('Bash(')).toBe(false)
    expect(matchesToolRule('Bash(', 'Bash', { command: 'x' })).toBe(false)
  })
})
