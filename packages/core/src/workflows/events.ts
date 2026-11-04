export type AgentResult = 'succeeded' | 'failed' | 'cancelled'
export type MergeRequestEvent = 'opened' | 'merged' | 'closed'

export type WorkflowEvent =
  | { kind: 'manual' }
  | { kind: 'issue.created' }
  | { kind: 'status.changed'; from: string | null; to: string }
  | { kind: 'label.added'; label: string }
  | { kind: 'agent.finished'; result: AgentResult }
  | { kind: 'merge_request'; event: MergeRequestEvent; url?: string | null }

type Config = Record<string, unknown>

const same = (a: unknown, b: unknown) =>
  String(a ?? '')
    .trim()
    .toLowerCase() ===
  String(b ?? '')
    .trim()
    .toLowerCase()
const blank = (value: unknown) => value === undefined || value === null || value === ''

export function triggerMatches(node: { type: string; config: Config }, event: WorkflowEvent): boolean {
  const { config } = node
  switch (node.type) {
    case 'trigger.issue_created':
      return event.kind === 'issue.created'
    case 'trigger.status_changed':
      return event.kind === 'status.changed' && (blank(config.to) || same(config.to, event.to))
    case 'trigger.label_added':
      return event.kind === 'label.added' && (blank(config.label) || same(config.label, event.label))
    case 'trigger.agent_finished':
      if (event.kind !== 'agent.finished') return false
      if (blank(config.result) || config.result === 'any') return event.result !== 'cancelled'
      return config.result === event.result
    case 'trigger.merge_request':
      return event.kind === 'merge_request' && (blank(config.event) || config.event === event.event)
    default:
      return false
  }
}

/** What a "Wait for event" block is waiting on, in the same terms as a trigger. */
export function waitMatches(config: Config, event: WorkflowEvent): boolean {
  switch (config.event) {
    case 'status.changed':
      return triggerMatches({ type: 'trigger.status_changed', config }, event)
    case 'label.added':
      return triggerMatches({ type: 'trigger.label_added', config }, event)
    case 'agent.finished':
      return event.kind === 'agent.finished'
    case 'merge_request.opened':
    case 'merge_request.merged':
    case 'merge_request.closed':
      return event.kind === 'merge_request' && `merge_request.${event.event}` === config.event
    default:
      return false
  }
}

export interface ConditionRule {
  field: string
  operator: string
  value?: string
}

export type IssueFacts = Record<string, string | string[] | null | undefined>

function ruleHolds(rule: ConditionRule, facts: IssueFacts): boolean {
  const fact = facts[rule.field]
  const values = (Array.isArray(fact) ? fact : [fact]).filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase())
  const wanted = String(rule.value ?? '')
    .trim()
    .toLowerCase()
  switch (rule.operator) {
    case 'is':
      return values.includes(wanted)
    case 'is_not':
      return !values.includes(wanted)
    case 'contains':
      return values.some((value) => value.includes(wanted))
    case 'not_contains':
      return !values.some((value) => value.includes(wanted))
    case 'is_empty':
      return values.length === 0
    case 'not_empty':
      return values.length > 0
    default:
      return false
  }
}

export function evaluateRules(rules: ConditionRule[], match: unknown, facts: IssueFacts): boolean {
  return match === 'any' ? rules.some((rule) => ruleHolds(rule, facts)) : rules.every((rule) => ruleHolds(rule, facts))
}

/** Merging is a person's or a pipeline's doing, so reaching done from awaiting_merge is not an agent finishing. */
export function agentResultOf(from: string, to: string): AgentResult | null {
  if (from === 'untracked' || from === to) return null
  if (to === 'awaiting_merge') return 'succeeded'
  if (to === 'done') return from === 'awaiting_merge' ? null : 'succeeded'
  if (to === 'failed') return 'failed'
  if (to === 'cancelled') return 'cancelled'
  return null
}
