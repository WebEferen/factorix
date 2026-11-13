import { describe, expect, it } from 'vitest'
import { completePlaceholder, initialBlockConfig, openPlaceholder, validateWorkflow, type WorkflowDefinition, workflowDefinition } from './workflows'

const block = (id: string, type: string, config: Record<string, unknown> = {}) =>
  ({ id, type, position: { x: 0, y: 0 }, config: { ...initialBlockConfig(type), ...config } }) as WorkflowDefinition['nodes'][number]
const link = (source: string, target: string, sourceHandle = 'next') => ({ id: `${source}-${sourceHandle}-${target}`, source, target, sourceHandle })
const messages = (definition: WorkflowDefinition) => validateWorkflow(definition).map((issue) => issue.message)

const NOTIFY = { connectionId: 'c', channel: 'C1', message: 'Hi' }

describe('validateWorkflow', () => {
  it('accepts a complete workflow with a branch and parallel paths', () => {
    expect(
      validateWorkflow({
        nodes: [
          block('start', 'trigger.manual'),
          block('check', 'logic.condition', { rules: [{ field: 'status', operator: 'is', value: 'Todo' }] }),
          block('tell', 'notify.send', NOTIFY),
          block('work', 'agent.run'),
        ],
        edges: [link('start', 'check'), link('check', 'tell', 'true'), link('check', 'work', 'false'), link('start', 'tell')],
      }),
    ).toEqual([])
  })

  it('asks for a way to start', () => {
    expect(messages({ nodes: [], edges: [] })).toContain('Add a block that starts the workflow')
  })

  it('flags blocks that do nothing or that nothing reaches', () => {
    const issues = validateWorkflow({ nodes: [block('start', 'trigger.manual'), block('tell', 'notify.send', NOTIFY)], edges: [] })
    expect(issues).toContainEqual({ nodeId: 'start', message: 'Nothing happens after this block' })
    expect(issues).toContainEqual({ nodeId: 'tell', message: 'Nothing leads to this block' })
  })

  it('refuses a loop', () => {
    const a = block('a', 'tracker.comment', { body: 'x' })
    const b = block('b', 'tracker.comment', { body: 'y' })
    expect(messages({ nodes: [block('start', 'trigger.manual'), a, b], edges: [link('start', 'a'), link('a', 'b'), link('b', 'a')] })).toContain(
      'Connections cannot loop back on themselves',
    )
  })

  it('refuses a connection into a trigger, through an unknown output, or to nowhere', () => {
    const nodes = [block('start', 'trigger.manual'), block('other', 'trigger.manual'), block('c', 'tracker.comment', { body: 'x' })]
    expect(messages({ nodes, edges: [link('c', 'other')] })).toContain('Nothing can lead into a starting block')
    expect(messages({ nodes, edges: [link('start', 'c', 'made-up')] })).toContain('A connection leaves through an unknown output')
    expect(messages({ nodes, edges: [link('start', 'ghost')] })).toContain('A connection points nowhere')
  })

  it('requires fields, but only those that apply', () => {
    expect(messages({ nodes: [block('start', 'trigger.manual'), block('c', 'tracker.comment')], edges: [link('start', 'c')] })).toEqual([
      'Comment is required',
    ])
    const waiting = block('w', 'logic.wait_for', { event: 'merge_request.merged', to: '' })
    expect(messages({ nodes: [block('start', 'trigger.manual'), waiting], edges: [link('start', 'w')] })).toEqual([])
  })

  it('checks numbers, options, length, and rules', () => {
    const start = block('start', 'trigger.manual')
    const check = (node: WorkflowDefinition['nodes'][number]) => messages({ nodes: [start, node], edges: [link('start', node.id)] })
    expect(check(block('w', 'logic.wait', { amount: 0 }))).toEqual(['For must be at least 1'])
    expect(check(block('w', 'logic.wait', { unit: 'years' }))).toEqual(['Unit has an unknown value'])
    expect(check(block('c', 'tracker.comment', { body: 'x'.repeat(5000) }))).toEqual(['Comment is too long'])
    expect(check(block('r', 'logic.condition', { rules: [{ field: 'labels', operator: 'is', value: '' }] }))).toEqual(['A rule has no value'])
    expect(check(block('r', 'logic.condition', { rules: [{ field: 'labels', operator: 'is_empty' }] }))).toEqual([])
    expect(check(block('r', 'logic.condition', { rules: [{ field: 'secret', operator: 'is', value: 'x' }] }))).toEqual(['A rule is incomplete'])
  })
})

describe('workflowDefinition', () => {
  it('rejects unknown block types and unsafe ids', () => {
    expect(workflowDefinition.safeParse({ nodes: [{ id: 'a', type: 'shell.exec', position: { x: 0, y: 0 }, config: {} }], edges: [] }).success).toBe(
      false,
    )
    expect(
      workflowDefinition.safeParse({ nodes: [{ id: '../a', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {} }], edges: [] }).success,
    ).toBe(false)
  })
})

describe('completing a variable', () => {
  it('sees the placeholder being typed before the caret, and nothing once it is closed', () => {
    expect(openPlaceholder('Hi {{', 5)).toEqual({ start: 3, query: '' })
    expect(openPlaceholder('Hi {{ steps.ask-1.te', 20)).toEqual({ start: 3, query: 'steps.ask-1.te' })
    expect(openPlaceholder('Hi {{issue.title}} there', 24)).toBeNull()
    expect(openPlaceholder('Hi {{issue.title}} there', 12)).toEqual({ start: 3, query: 'issue.t' })
    expect(openPlaceholder('Hi {', 4)).toBeNull()
  })

  it('replaces what was typed, keeps the rest, and does not double the closing braces', () => {
    expect(completePlaceholder('Hi {{st there', 7, 'steps.ask-1.text')).toEqual({ text: 'Hi {{steps.ask-1.text}} there', caret: 23 })
    expect(completePlaceholder('Hi {{iss}} there', 8, 'issue.title')).toEqual({ text: 'Hi {{issue.title}} there', caret: 18 })
    expect(completePlaceholder('Hi {{issue.title}}', 9, 'issue.url')).toEqual({ text: 'Hi {{issue.url}}', caret: 16 })
  })
})
