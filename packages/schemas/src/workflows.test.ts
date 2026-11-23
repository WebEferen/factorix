import { describe, expect, it } from 'vitest'
import {
  completePlaceholder,
  initialBlockConfig,
  integrationBlocks,
  nextScheduleTime,
  openPlaceholder,
  validateWorkflow,
  type WorkflowDefinition,
  workflowDefinition,
} from './workflows'

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
          block('tell', 'slack.send_message', NOTIFY),
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
    const issues = validateWorkflow({ nodes: [block('start', 'trigger.manual'), block('tell', 'slack.send_message', NOTIFY)], edges: [] })
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

describe('a ticketless trigger', () => {
  it('cannot lead to a block that works on a ticket, though another trigger can', () => {
    const slack = block('chat', 'trigger.slack.mention', { connectionId: 'c', channel: 'any' })
    const comment = block('c', 'tracker.comment', { body: 'x' })
    const create = block('make', 'tracker.create_issue', { title: '{{steps.chat.text}}', projectId: 'p' })
    expect(
      messages({ nodes: [slack, create, block('tell', 'slack.send_message', NOTIFY)], edges: [link('chat', 'make'), link('make', 'tell')] }),
    ).toEqual([])
    expect(messages({ nodes: [slack, create, comment], edges: [link('chat', 'make'), link('make', 'c')] })).toEqual([
      'Comment on ticket works on a ticket, and App mentioned starts without one',
    ])
    expect(
      messages({ nodes: [block('start', 'trigger.manual'), comment, slack, create], edges: [link('start', 'c'), link('chat', 'make')] }),
    ).toEqual([])
  })

  it('can ask an agent, but not have the answer posted on a ticket', () => {
    const slack = block('chat', 'trigger.slack.mention', { connectionId: 'c', channel: 'any' })
    const ask = (post: string) => block('ask', 'agent.prompt', { prompt: '{{steps.chat.text}}', post })
    const flow = (post: string) => ({
      nodes: [slack, ask(post), block('tell', 'slack.send_message', NOTIFY)],
      edges: [link('chat', 'ask'), link('ask', 'tell')],
    })
    expect(messages(flow('none'))).toEqual([])
    expect(messages(flow('comment'))).toEqual(['Post it on the ticket needs a ticket, and App mentioned starts without one'])
  })
})

describe('a Slack block', () => {
  it('is pinned to a place, which may be a channel, direct messages, or anywhere, and can reply where the run started', () => {
    const flow = (trigger: Record<string, unknown>, send: Record<string, unknown> = NOTIFY) =>
      messages({
        nodes: [block('chat', 'trigger.slack.message', { connectionId: 'c', ...trigger }), block('tell', 'slack.send_message', send)],
        edges: [link('chat', 'tell')],
      })
    expect(flow({})).toEqual(['Where is required'])
    for (const channel of ['C1', 'dm', 'any']) expect(flow({ channel })).toEqual([])
    expect(flow({ channel: 'dm' }, { ...NOTIFY, channel: 'reply' })).toEqual([])
    expect(flow({ channel: 'C1', from: ['U7', 'U8'] })).toEqual([])
    expect(flow({ channel: 'C1', from: 'U7' })).toEqual(['From has an unknown value'])
  })
})

describe('integrationBlocks', () => {
  it('offers an integration its blocks only once it is connected', () => {
    expect(integrationBlocks(['linear', 'gitlab'])).toEqual({})
    const slack = integrationBlocks(['linear', 'slack'])
    expect(Object.keys(slack)).toEqual(['trigger.slack.message', 'trigger.slack.mention', 'slack.send_message'])
    expect(slack['slack.send_message']).toMatchObject({ owner: { kind: 'integration', id: 'slack', name: 'Slack' } })
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

describe('nextScheduleTime', () => {
  const next = (config: Record<string, unknown>, after: string) => nextScheduleTime(config, new Date(after))?.toISOString() ?? null

  it('finds the next time of day in the block’s time zone', () => {
    expect(next({ days: 'daily', time: '02:00', timezone: 'UTC' }, '2026-11-16T01:00:00Z')).toBe('2026-11-16T02:00:00.000Z')
    expect(next({ days: 'daily', time: '02:00', timezone: 'UTC' }, '2026-11-16T02:00:00Z')).toBe('2026-11-17T02:00:00.000Z')
    expect(next({ days: 'daily', time: '2:30', timezone: 'Europe/Warsaw' }, '2026-11-16T12:00:00Z')).toBe('2026-11-17T01:30:00.000Z')
    expect(next({ days: 'daily', time: '09:00', timezone: 'Pacific/Auckland' }, '2026-11-16T12:00:00Z')).toBe('2026-11-16T20:00:00.000Z')
  })

  it('keeps to the chosen days, counted where the block lives', () => {
    // 2026-11-13 is a Friday.
    expect(next({ days: 'weekdays', time: '18:00', timezone: 'UTC' }, '2026-11-13T19:00:00Z')).toBe('2026-11-16T18:00:00.000Z')
    expect(next({ days: '0', time: '08:00', timezone: 'UTC' }, '2026-11-13T19:00:00Z')).toBe('2026-11-15T08:00:00.000Z')
    expect(next({ days: '1', time: '00:30', timezone: 'Asia/Tokyo' }, '2026-11-13T19:00:00Z')).toBe('2026-11-15T15:30:00.000Z')
  })

  it('follows the clock through a change of time', () => {
    expect(next({ days: 'daily', time: '08:00', timezone: 'Europe/Warsaw' }, '2026-03-28T12:00:00Z')).toBe('2026-03-29T06:00:00.000Z')
    expect(next({ days: 'daily', time: '08:00', timezone: 'Europe/Warsaw' }, '2026-10-24T12:00:00Z')).toBe('2026-10-25T07:00:00.000Z')
    expect(next({ days: 'daily', time: '02:30', timezone: 'Europe/Warsaw' }, '2026-03-28T12:00:00Z')).toBe('2026-03-29T01:30:00.000Z')
  })

  it('refuses settings that name no time', () => {
    expect(next({ days: 'daily', time: '25:00', timezone: 'UTC' }, '2026-11-16T01:00:00Z')).toBeNull()
    expect(next({ days: 'daily', time: '02:00', timezone: 'Mars/Olympus' }, '2026-11-16T01:00:00Z')).toBeNull()
    expect(next({ days: 'sometimes', time: '02:00', timezone: 'UTC' }, '2026-11-16T01:00:00Z')).toBeNull()
  })
})
