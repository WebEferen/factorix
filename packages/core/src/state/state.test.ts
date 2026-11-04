import { describe, expect, it } from 'vitest'
import { canTransitionIssue } from './issue'
import { canTransitionRun, isTerminalRunState } from './run'

describe('run state machine', () => {
  it.each([
    ['queued', 'preparing', true],
    ['preparing', 'running', true],
    ['running', 'waiting_approval', true],
    ['waiting_approval', 'suspended', true],
    ['suspended', 'preparing', true],
    ['running', 'finalizing', true],
    ['finalizing', 'succeeded', true],
    ['queued', 'running', false],
    ['suspended', 'running', false],
    ['succeeded', 'queued', false],
    ['failed', 'running', false],
  ] as const)('%s -> %s is %s', (from, to, allowed) => {
    expect(canTransitionRun(from, to)).toBe(allowed)
  })

  it('knows its terminal states', () => {
    expect(isTerminalRunState('cancelled')).toBe(true)
    expect(isTerminalRunState('suspended')).toBe(false)
  })
})

describe('issue state machine', () => {
  it.each([
    ['untracked', 'queued', true],
    ['queued', 'active', true],
    ['active', 'waiting_human', true],
    ['awaiting_merge', 'done', true],
    ['failed', 'queued', true],
    ['done', 'queued', true],
    ['done', 'failed', false],
    ['untracked', 'done', false],
  ] as const)('%s -> %s is %s', (from, to, allowed) => {
    expect(canTransitionIssue(from, to)).toBe(allowed)
  })
})
