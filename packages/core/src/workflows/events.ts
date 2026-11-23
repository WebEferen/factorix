export type AgentResult = 'succeeded' | 'failed' | 'cancelled'
export type MergeRequestEvent = 'opened' | 'merged' | 'closed'

export type WorkflowEvent =
  | { kind: 'manual' }
  | { kind: 'schedule'; scheduledFor: string }
  | { kind: 'issue.created' }
  | { kind: 'status.changed'; from: string | null; to: string }
  | { kind: 'label.added'; label: string }
  | { kind: 'agent.finished'; result: AgentResult }
  | { kind: 'merge_request'; event: MergeRequestEvent; url?: string | null }
  /**
   * From outside the tracker, like a Slack message or a plugin. It starts runs with no ticket. `filters` names the
   * trigger's fields that narrow which events start it, for a plugin's trigger.
   */
  | { kind: 'external'; type: string; data: Record<string, string>; filters?: readonly string[] }

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
    case 'trigger.slack.message':
    case 'trigger.slack.mention': {
      if (event.kind !== 'external' || event.type !== node.type || !same(config.connectionId, event.data.connectionId)) return false
      const text = String(event.data.text ?? '').toLowerCase()
      // 'any' and 'dm' are SLACK_ANYWHERE and SLACK_DIRECT. A trigger with no place set starts on nothing.
      const place = config.channel === 'any' || (config.channel === 'dm' ? event.data.channelType === 'im' : config.channel === event.data.channel)
      const from = Array.isArray(config.from) ? config.from : []
      return (
        place &&
        (from.length === 0 || from.includes(event.data.user)) &&
        (blank(config.contains) || text.includes(String(config.contains).trim().toLowerCase()))
      )
    }
    default:
      // A plugin's trigger: every one of its fields filled in has to match the event's value under the same key.
      return (
        event.kind === 'external' &&
        event.type === node.type &&
        node.type.startsWith('trigger.plugin.') &&
        (event.filters ?? []).every((key) => blank(config[key]) || same(config[key], event.data[key]))
      )
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
