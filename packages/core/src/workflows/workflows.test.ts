import { describe, expect, it } from 'vitest'
import { FAILED_HANDLE, planWorkflow, type StepState, type WorkflowGraph } from './engine'
import { agentResultOf, evaluateRules, triggerMatches, waitMatches } from './events'
import { escapeMarkdown, renderTemplate } from './template'

const nodes = (...ids: string[]) => ids.map((id) => ({ id, type: 'x' }))
const edge = (source: string, target: string, sourceHandle = 'next') => ({ source, target, sourceHandle })
const done = (handle = 'next'): StepState => ({ status: 'succeeded', handle })
const pending: StepState = { status: 'pending', handle: null }

describe('planWorkflow', () => {
  const chain: WorkflowGraph = { nodes: nodes('t', 'a', 'b'), edges: [edge('t', 'a'), edge('a', 'b')] }

  it('walks a chain one step at a time and finishes', () => {
    expect(planWorkflow(chain, { t: done(), a: pending, b: pending })).toEqual({ ready: ['a'], skip: [], outcome: 'running' })
    expect(planWorkflow(chain, { t: done(), a: { status: 'running', handle: null }, b: pending }).ready).toEqual([])
    expect(planWorkflow(chain, { t: done(), a: done(), b: done() }).outcome).toBe('succeeded')
  })

  const branch: WorkflowGraph = {
    nodes: nodes('t', 'if', 'yes', 'no', 'after-no', 'end'),
    edges: [
      edge('t', 'if'),
      edge('if', 'yes', 'true'),
      edge('if', 'no', 'false'),
      edge('no', 'after-no'),
      edge('yes', 'end'),
      edge('after-no', 'end'),
    ],
  }

  it('takes one side of a condition, skips everything only the other side leads to, and still reaches the merge', () => {
    const plan = planWorkflow(branch, { t: done(), if: done('true'), yes: pending, no: pending, 'after-no': pending, end: pending })
    expect(plan.ready).toEqual(['yes'])
    expect(plan.skip).toEqual(['no', 'after-no'])
    const merged = planWorkflow(branch, {
      t: done(),
      if: done('true'),
      yes: done(),
      no: { status: 'skipped', handle: null },
      'after-no': { status: 'skipped', handle: null },
      end: pending,
    })
    expect(merged.ready).toEqual(['end'])
  })

  it('skips the merge when nothing reaches it, and finishes', () => {
    const graph: WorkflowGraph = { nodes: nodes('t', 'if', 'yes', 'end'), edges: [edge('t', 'if'), edge('if', 'yes', 'true'), edge('yes', 'end')] }
    expect(planWorkflow(graph, { t: done(), if: done('false'), yes: pending, end: pending })).toEqual({
      ready: [],
      skip: ['yes', 'end'],
      outcome: 'succeeded',
    })
  })

  const parallel: WorkflowGraph = {
    nodes: nodes('t', 'a', 'b', 'join'),
    edges: [edge('t', 'a'), edge('t', 'b'), edge('a', 'join'), edge('b', 'join')],
  }

  it('runs parallel branches together and joins only when both are done', () => {
    expect(planWorkflow(parallel, { t: done(), a: pending, b: pending, join: pending }).ready).toEqual(['a', 'b'])
    expect(planWorkflow(parallel, { t: done(), a: done(), b: { status: 'waiting', handle: null }, join: pending }).ready).toEqual([])
    expect(planWorkflow(parallel, { t: done(), a: done(), b: done(), join: pending }).ready).toEqual(['join'])
  })

  it('leaves a trigger that did not fire out of the run', () => {
    const graph: WorkflowGraph = { nodes: nodes('hand', 'auto', 'a'), edges: [edge('hand', 'a'), edge('auto', 'a')] }
    expect(planWorkflow(graph, { hand: done(), auto: { status: 'skipped', handle: null }, a: pending }).ready).toEqual(['a'])
  })

  it('fails the run on an unconnected failure and stops starting anything', () => {
    const graph: WorkflowGraph = { nodes: nodes('t', 'a', 'b', 'c'), edges: [edge('t', 'a'), edge('t', 'c'), edge('a', 'b')] }
    const steps = { t: done(), a: { status: 'failed', handle: FAILED_HANDLE } as StepState, b: pending, c: pending }
    expect(planWorkflow(graph, steps)).toEqual({ ready: [], skip: [], outcome: 'failed' })
  })

  it('follows the failure output when it is connected', () => {
    const graph: WorkflowGraph = {
      nodes: nodes('t', 'a', 'ok', 'recover'),
      edges: [edge('t', 'a'), edge('a', 'ok'), edge('a', 'recover', FAILED_HANDLE)],
    }
    const plan = planWorkflow(graph, { t: done(), a: { status: 'failed', handle: FAILED_HANDLE }, ok: pending, recover: pending })
    expect(plan.ready).toEqual(['recover'])
    expect(plan.skip).toEqual(['ok'])
  })
})

describe('triggerMatches', () => {
  it.each([
    ['trigger.issue_created', {}, { kind: 'issue.created' }, true],
    ['trigger.manual', {}, { kind: 'issue.created' }, false],
    ['trigger.status_changed', {}, { kind: 'status.changed', from: 'Todo', to: 'Done' }, true],
    ['trigger.status_changed', { to: 'done' }, { kind: 'status.changed', from: 'Todo', to: 'Done' }, true],
    ['trigger.status_changed', { to: 'In Review' }, { kind: 'status.changed', from: 'Todo', to: 'Done' }, false],
    ['trigger.label_added', { label: 'Bug' }, { kind: 'label.added', label: 'bug' }, true],
    ['trigger.label_added', { label: 'Bug' }, { kind: 'label.added', label: 'feature' }, false],
    ['trigger.agent_finished', { result: 'any' }, { kind: 'agent.finished', result: 'failed' }, true],
    ['trigger.agent_finished', { result: 'any' }, { kind: 'agent.finished', result: 'cancelled' }, false],
    ['trigger.agent_finished', { result: 'failed' }, { kind: 'agent.finished', result: 'succeeded' }, false],
    ['trigger.merge_request', { event: 'merged' }, { kind: 'merge_request', event: 'merged' }, true],
    ['trigger.merge_request', { event: 'merged' }, { kind: 'merge_request', event: 'closed' }, false],
  ] as const)('%s %j on %j is %s', (type, config, event, expected) => {
    expect(triggerMatches({ type, config }, event)).toBe(expected)
  })
})

describe('waitMatches', () => {
  it('reads the same events as triggers', () => {
    expect(waitMatches({ event: 'merge_request.merged' }, { kind: 'merge_request', event: 'merged' })).toBe(true)
    expect(waitMatches({ event: 'merge_request.merged' }, { kind: 'merge_request', event: 'opened' })).toBe(false)
    expect(waitMatches({ event: 'status.changed', to: 'Done' }, { kind: 'status.changed', from: null, to: 'Done' })).toBe(true)
    expect(waitMatches({ event: 'agent.finished' }, { kind: 'agent.finished', result: 'cancelled' })).toBe(true)
    expect(waitMatches({ event: 'nonsense' }, { kind: 'manual' })).toBe(false)
  })
})

describe('evaluateRules', () => {
  const facts = { status: 'Todo', labels: ['Bug', 'Backend'], title: 'Fix the login page', assignee: null }
  it.each([
    [{ field: 'status', operator: 'is', value: 'todo' }, true],
    [{ field: 'status', operator: 'is_not', value: 'Todo' }, false],
    [{ field: 'labels', operator: 'is', value: 'bug' }, true],
    [{ field: 'labels', operator: 'is_not', value: 'frontend' }, true],
    [{ field: 'title', operator: 'contains', value: 'LOGIN' }, true],
    [{ field: 'title', operator: 'not_contains', value: 'login' }, false],
    [{ field: 'assignee', operator: 'is_empty' }, true],
    [{ field: 'assignee', operator: 'not_empty' }, false],
    [{ field: 'status', operator: 'unknown', value: 'x' }, false],
  ])('%j is %s', (rule, expected) => {
    expect(evaluateRules([rule], 'all', facts)).toBe(expected)
  })

  it('combines rules with all or any', () => {
    const yes = { field: 'status', operator: 'is', value: 'Todo' }
    const no = { field: 'status', operator: 'is', value: 'Done' }
    expect(evaluateRules([yes, no], 'all', facts)).toBe(false)
    expect(evaluateRules([yes, no], 'any', facts)).toBe(true)
  })
})

describe('agentResultOf', () => {
  it.each([
    ['active', 'awaiting_merge', 'succeeded'],
    ['active', 'done', 'succeeded'],
    ['active', 'failed', 'failed'],
    ['waiting_human', 'cancelled', 'cancelled'],
    ['awaiting_merge', 'done', null],
    ['queued', 'active', null],
    ['active', 'waiting_human', null],
    ['untracked', 'cancelled', null],
    ['failed', 'failed', null],
  ])('%s to %s is %s', (from, to, expected) => {
    expect(agentResultOf(from, to)).toBe(expected)
  })
})

describe('renderTemplate', () => {
  const values = { issue: { identifier: 'ABC-1', title: 'A {{issue.identifier}} title', labels: ['a', 'b'], none: null } }

  it('fills values, blanks what it cannot find, and joins lists', () => {
    expect(renderTemplate('{{ issue.identifier }}: {{issue.labels}} {{issue.missing}}{{issue.none}}', values)).toBe('ABC-1: a, b ')
  })

  it('does not expand a value a second time', () => {
    expect(renderTemplate('{{issue.title}}', values)).toBe('A {{issue.identifier}} title')
  })

  it('cannot reach the prototype chain', () => {
    expect(renderTemplate('{{constructor.name}}{{issue.__proto__.constructor}}', values)).toBe('')
  })

  it('escapes values and leaves the template itself alone', () => {
    const hostile = { title: '[click](http://evil) <!channel> @here' }
    const output = renderTemplate('**Ticket** {{title}}', hostile, escapeMarkdown)
    expect(output).toBe('**Ticket** \\[click\\]\\(http://evil\\) \\<\\!channel\\> \\@here')
  })
})
