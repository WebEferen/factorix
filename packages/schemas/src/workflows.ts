import { z } from 'zod'

export type BlockCategory = 'trigger' | 'logic' | 'agent' | 'tracker' | 'integration' | 'plugin'

export interface BlockOutput {
  id: string
  label: string
  /** Leaving through this output counts as a failure unless something is connected to it. */
  failure?: boolean
}

export type BlockFieldKind =
  | 'text'
  | 'template'
  | 'longTemplate'
  | 'number'
  | 'select'
  | 'agent'
  | 'skills'
  | 'model'
  | 'project'
  | 'status'
  | 'label'
  | 'connection'
  | 'channel'
  | 'people'
  | 'rules'

export interface BlockField {
  key: string
  label: string
  kind: BlockFieldKind
  required?: boolean
  placeholder?: string
  hint?: string
  /**
   * `needsTicket` marks a choice that works on the run's ticket, so no ticketless trigger may lead to a block that makes it.
   * A channel field offers these beside the connection's channels.
   */
  options?: { value: string; label: string; needsTicket?: boolean }[]
  /** The options come from a plugin, per organization, so they are not checked here. */
  dynamic?: boolean
  /** Starting value for a new block. */
  initial?: unknown
  min?: number
  max?: number
  /** Only applies when another field has one of these values. */
  when?: { key: string; in: string[] }
}

export interface BlockSpec {
  category: BlockCategory
  title: string
  description: string
  fields: BlockField[]
  outputs: BlockOutput[]
  /** What the block hands to later blocks, listed as variables. `when` limits one to certain values of a field. */
  provides?: { key: string; label: string; when?: { key: string; in: string[] } }[]
  /**
   * The integration or plugin a block belongs to. The editor lists it under that name, and only while the organization
   * has it: a connection of that kind for an integration, the plugin turned on for a plugin.
   */
  owner?: { kind: 'integration' | 'plugin'; id: string; name: string }
  /** A trigger that starts a run with no ticket, like a message in a chat. */
  ticketless?: boolean
  /** A block that works on the run's ticket, so no ticketless trigger may lead to it. */
  needsTicket?: boolean
}

/** Blocks the organization can add beyond Factorix's own: those of its integrations and plugins. */
export type BlockCatalog = Record<string, BlockSpec>

/** A plugin's block is `plugin.<plugin id>.<block key>`, so a workflow names the plugin it depends on. */
export const PLUGIN_BLOCK_TYPE = /^plugin\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z][a-z0-9_]{0,39})$/

export function pluginBlockType(pluginId: string, key: string): string {
  return `plugin.${pluginId}.${key}`
}

export function parsePluginBlockType(type: string): { pluginId: string; key: string } | null {
  const match = PLUGIN_BLOCK_TYPE.exec(type)
  return match?.[1] && match[2] ? { pluginId: match[1], key: match[2] } : null
}

/** A plugin's trigger is `trigger.plugin.<plugin id>.<key>`, and starts a run with no ticket. */
export const PLUGIN_TRIGGER_TYPE = /^trigger\.plugin\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z][a-z0-9_]{0,39})$/

export function pluginTriggerType(pluginId: string, key: string): string {
  return `trigger.plugin.${pluginId}.${key}`
}

export function parsePluginTriggerType(type: string): { pluginId: string; key: string } | null {
  const match = PLUGIN_TRIGGER_TYPE.exec(type)
  return match?.[1] && match[2] ? { pluginId: match[1], key: match[2] } : null
}

const NEXT: BlockOutput = { id: 'next', label: 'Next' }
const FAILED: BlockOutput = { id: 'failed', label: 'Failed', failure: true }

const STATUS_FIELD_HINT = 'Leave empty for any status.'

const SLACK = { kind: 'integration', id: 'slack', name: 'Slack' } as const
/** Values a Slack channel field takes beside a channel's id. Slack's ids are upper case, so they never collide. */
export const SLACK_DIRECT = 'dm'
export const SLACK_ANYWHERE = 'any'
export const SLACK_REPLY = 'reply'
const SLACK_PLACE_HINT = 'Pick one channel unless the workflow is meant for everyone who can reach the app.'
const SLACK_FROM = { key: 'from', label: 'From', kind: 'people', hint: 'Leave empty for anyone who can post there.' } as const
const SLACK_MESSAGE = [
  { key: 'text', label: 'Message' },
  { key: 'user', label: 'Author, as a Slack ID' },
  { key: 'channel', label: 'Channel ID' },
  { key: 'thread', label: 'Thread to reply in' },
]

export const WORKFLOW_BLOCKS = {
  'trigger.manual': {
    category: 'trigger',
    title: 'Run by hand',
    description: 'Starts when someone runs this workflow on a ticket.',
    fields: [],
    outputs: [NEXT],
  },
  'trigger.schedule': {
    category: 'trigger',
    title: 'On a schedule',
    description: 'Starts by itself at a set time, on one ticket that collects the results.',
    fields: [
      {
        key: 'days',
        label: 'Days',
        kind: 'select',
        initial: 'daily',
        required: true,
        options: [
          { value: 'daily', label: 'Every day' },
          { value: 'weekdays', label: 'Monday to Friday' },
          { value: '1', label: 'Mondays' },
          { value: '2', label: 'Tuesdays' },
          { value: '3', label: 'Wednesdays' },
          { value: '4', label: 'Thursdays' },
          { value: '5', label: 'Fridays' },
          { value: '6', label: 'Saturdays' },
          { value: '0', label: 'Sundays' },
        ],
      },
      { key: 'time', label: 'Time', kind: 'text', initial: '02:00', required: true, placeholder: '02:00', hint: '24-hour, as HH:MM.' },
      { key: 'timezone', label: 'Time zone', kind: 'text', initial: 'UTC', required: true, placeholder: 'Europe/Warsaw' },
      {
        key: 'issue',
        label: 'Ticket',
        kind: 'text',
        required: true,
        placeholder: 'ENG-12',
        hint: 'Every run works on this ticket, so its results stay in one place.',
      },
    ],
    outputs: [NEXT],
    provides: [{ key: 'scheduledFor', label: 'Scheduled time' }],
  },
  'trigger.issue_created': {
    category: 'trigger',
    title: 'Ticket created',
    description: 'Starts when a new ticket appears in the project.',
    fields: [],
    outputs: [NEXT],
  },
  'trigger.status_changed': {
    category: 'trigger',
    title: 'Status changed',
    description: 'Starts when a ticket moves to another status.',
    fields: [{ key: 'to', label: 'New status', kind: 'status', hint: STATUS_FIELD_HINT }],
    outputs: [NEXT],
    provides: [
      { key: 'from', label: 'Old status' },
      { key: 'to', label: 'New status' },
    ],
  },
  'trigger.label_added': {
    category: 'trigger',
    title: 'Label added',
    description: 'Starts when a ticket gets a label.',
    fields: [{ key: 'label', label: 'Label', kind: 'label', hint: 'Leave empty for any label.' }],
    outputs: [NEXT],
    provides: [{ key: 'label', label: 'Label' }],
  },
  'trigger.agent_finished': {
    category: 'trigger',
    title: 'Agent finished',
    description: 'Starts when agents finish working on a ticket.',
    fields: [
      {
        key: 'result',
        label: 'Result',
        kind: 'select',
        initial: 'any',
        options: [
          { value: 'any', label: 'Succeeded or failed' },
          { value: 'succeeded', label: 'Succeeded' },
          { value: 'failed', label: 'Failed' },
        ],
      },
    ],
    outputs: [NEXT],
    provides: [{ key: 'result', label: 'Result' }],
  },
  'trigger.merge_request': {
    category: 'trigger',
    title: 'Merge request',
    description: 'Starts when a merge request of the ticket changes.',
    fields: [
      {
        key: 'event',
        label: 'When it is',
        kind: 'select',
        initial: 'merged',
        required: true,
        options: [
          { value: 'opened', label: 'Opened' },
          { value: 'merged', label: 'Merged' },
          { value: 'closed', label: 'Closed without merging' },
        ],
      },
    ],
    outputs: [NEXT],
    provides: [
      { key: 'event', label: 'What happened' },
      { key: 'url', label: 'Merge request link' },
    ],
  },
  'logic.condition': {
    category: 'logic',
    needsTicket: true,
    title: 'Condition',
    description: 'Splits the flow based on the ticket.',
    fields: [
      {
        key: 'match',
        label: 'Match',
        kind: 'select',
        initial: 'all',
        options: [
          { value: 'all', label: 'All of these' },
          { value: 'any', label: 'Any of these' },
        ],
      },
      { key: 'rules', label: 'Rules', kind: 'rules', required: true, initial: [{ field: 'labels', operator: 'is', value: '' }] },
    ],
    outputs: [
      { id: 'true', label: 'Yes' },
      { id: 'false', label: 'No' },
    ],
  },
  'logic.wait': {
    category: 'logic',
    title: 'Wait',
    description: 'Pauses this branch for a while.',
    fields: [
      { key: 'amount', label: 'For', kind: 'number', required: true, initial: 1, min: 1, max: 1000 },
      {
        key: 'unit',
        label: 'Unit',
        kind: 'select',
        initial: 'hours',
        required: true,
        options: [
          { value: 'minutes', label: 'Minutes' },
          { value: 'hours', label: 'Hours' },
          { value: 'days', label: 'Days' },
        ],
      },
    ],
    outputs: [NEXT],
  },
  'logic.wait_for': {
    category: 'logic',
    needsTicket: true,
    title: 'Wait for event',
    description: 'Pauses this branch until something happens to the ticket.',
    fields: [
      {
        key: 'event',
        label: 'Event',
        kind: 'select',
        initial: 'merge_request.merged',
        required: true,
        options: [
          { value: 'merge_request.opened', label: 'Merge request opened' },
          { value: 'merge_request.merged', label: 'Merge request merged' },
          { value: 'merge_request.closed', label: 'Merge request closed' },
          { value: 'status.changed', label: 'Status changed' },
          { value: 'label.added', label: 'Label added' },
          { value: 'agent.finished', label: 'Agent finished' },
        ],
      },
      { key: 'to', label: 'New status', kind: 'status', hint: STATUS_FIELD_HINT, when: { key: 'event', in: ['status.changed'] } },
      { key: 'label', label: 'Label', kind: 'label', hint: 'Leave empty for any label.', when: { key: 'event', in: ['label.added'] } },
      { key: 'timeoutHours', label: 'Give up after (hours)', kind: 'number', required: true, initial: 72, min: 1, max: 2160 },
    ],
    outputs: [NEXT, { id: 'timeout', label: 'Timed out' }],
    provides: [
      {
        key: 'url',
        label: 'Merge request link',
        when: { key: 'event', in: ['merge_request.opened', 'merge_request.merged', 'merge_request.closed'] },
      },
      { key: 'from', label: 'Old status', when: { key: 'event', in: ['status.changed'] } },
      { key: 'to', label: 'New status', when: { key: 'event', in: ['status.changed'] } },
      { key: 'label', label: 'Label', when: { key: 'event', in: ['label.added'] } },
      { key: 'result', label: 'Result', when: { key: 'event', in: ['agent.finished'] } },
    ],
  },
  'agent.run': {
    category: 'agent',
    needsTicket: true,
    title: 'Run agent',
    description: 'Hands the ticket to an agent and continues when the work is done.',
    fields: [{ key: 'agentId', label: 'Agent', kind: 'agent', hint: "Leave empty for the project's default engineer." }],
    outputs: [{ id: 'next', label: 'Finished' }, FAILED],
    provides: [{ key: 'result', label: 'Result' }],
  },
  'agent.prompt': {
    category: 'agent',
    title: 'Ask agent',
    description: 'Gives an agent a prompt and continues with its answer. The agent reads the code and changes nothing.',
    fields: [
      { key: 'agentId', label: 'Agent', kind: 'agent', hint: "Leave empty for the ticket's agent, or the project's default engineer." },
      {
        key: 'projectId',
        label: 'Project',
        kind: 'project',
        hint: "Whose code the agent reads when the run has no ticket. Leave empty for the workflow's project, or for no code at all.",
      },
      {
        key: 'prompt',
        label: 'Prompt',
        kind: 'longTemplate',
        required: true,
        placeholder: 'Review the merge request of {{issue.identifier}} for security problems.',
      },
      { key: 'skillIds', label: 'Skills', kind: 'skills', hint: "Added to the agent's own for this run." },
      { key: 'model', label: 'Model', kind: 'model', hint: "Leave empty for the agent's own." },
      {
        key: 'post',
        label: 'Answer',
        kind: 'select',
        initial: 'comment',
        required: true,
        options: [
          { value: 'comment', label: 'Post it on the ticket', needsTicket: true },
          { value: 'none', label: 'Only pass it to later blocks' },
        ],
      },
    ],
    outputs: [{ id: 'next', label: 'Answered' }, FAILED],
    provides: [
      { key: 'text', label: 'Answer' },
      { key: 'url', label: 'Run link' },
      { key: 'runId', label: 'Run ID' },
    ],
  },
  'tracker.comment': {
    category: 'tracker',
    needsTicket: true,
    title: 'Comment on ticket',
    description: 'Posts a comment on the ticket in the tracker.',
    fields: [{ key: 'body', label: 'Comment', kind: 'longTemplate', required: true, placeholder: 'Picked up {{issue.identifier}}.' }],
    outputs: [NEXT, FAILED],
  },
  'tracker.set_status': {
    category: 'tracker',
    needsTicket: true,
    title: 'Set status',
    description: 'Moves the ticket to a status.',
    fields: [{ key: 'status', label: 'Status', kind: 'status', required: true }],
    outputs: [NEXT, FAILED],
  },
  'tracker.label': {
    category: 'tracker',
    needsTicket: true,
    title: 'Change labels',
    description: 'Adds or removes a label on the ticket.',
    fields: [
      {
        key: 'action',
        label: 'Action',
        kind: 'select',
        initial: 'add',
        required: true,
        options: [
          { value: 'add', label: 'Add' },
          { value: 'remove', label: 'Remove' },
        ],
      },
      { key: 'label', label: 'Label', kind: 'label', required: true },
    ],
    outputs: [NEXT, FAILED],
  },
  'tracker.create_issue': {
    category: 'tracker',
    title: 'Create ticket',
    description: 'Creates a new ticket in the tracker.',
    fields: [
      { key: 'title', label: 'Title', kind: 'template', required: true, placeholder: 'Follow up on {{issue.identifier}}' },
      { key: 'description', label: 'Description', kind: 'longTemplate', placeholder: 'Created from {{issue.url}}' },
      { key: 'projectId', label: 'Project', kind: 'project', hint: "Leave empty for the ticket's own project." },
      {
        key: 'priority',
        label: 'Priority',
        kind: 'select',
        initial: '0',
        options: [
          { value: '0', label: 'No priority' },
          { value: '1', label: 'Urgent' },
          { value: '2', label: 'High' },
          { value: '3', label: 'Medium' },
          { value: '4', label: 'Low' },
        ],
      },
      { key: 'agentId', label: 'Hand to agent', kind: 'agent', hint: 'Leave empty to only create the ticket.' },
    ],
    outputs: [NEXT, FAILED],
    provides: [
      { key: 'identifier', label: 'Ticket ID' },
      { key: 'url', label: 'Ticket link' },
    ],
  },
  'trigger.slack.message': {
    category: 'trigger',
    owner: SLACK,
    ticketless: true,
    title: 'Message posted',
    description:
      'Starts when someone posts in a Slack channel the app is in, or writes to it directly. The Slack connection needs its events set up.',
    fields: [
      { key: 'connectionId', label: 'Connection', kind: 'connection', required: true },
      {
        key: 'channel',
        label: 'Where',
        kind: 'channel',
        required: true,
        hint: SLACK_PLACE_HINT,
        options: [
          { value: SLACK_DIRECT, label: 'Direct messages to the app' },
          { value: SLACK_ANYWHERE, label: 'Anywhere the app is' },
        ],
      },
      SLACK_FROM,
      { key: 'contains', label: 'Containing', kind: 'text', placeholder: 'deploy', hint: 'Leave empty for any message.' },
    ],
    outputs: [NEXT],
    provides: SLACK_MESSAGE,
  },
  'trigger.slack.mention': {
    category: 'trigger',
    owner: SLACK,
    ticketless: true,
    title: 'App mentioned',
    description:
      'Starts when someone mentions the Slack app in a channel. A direct message to the app is no mention: Message posted starts on those. The Slack connection needs its events set up.',
    fields: [
      { key: 'connectionId', label: 'Connection', kind: 'connection', required: true },
      {
        key: 'channel',
        label: 'Where',
        kind: 'channel',
        required: true,
        hint: SLACK_PLACE_HINT,
        options: [{ value: SLACK_ANYWHERE, label: 'Any channel the app is in' }],
      },
      SLACK_FROM,
    ],
    outputs: [NEXT],
    provides: SLACK_MESSAGE,
  },
  'slack.send_message': {
    category: 'integration',
    owner: SLACK,
    title: 'Send message',
    description: 'Posts a message to a Slack channel, or answers the Slack message that started the run.',
    fields: [
      { key: 'connectionId', label: 'Connection', kind: 'connection', required: true },
      {
        key: 'channel',
        label: 'Channel',
        kind: 'channel',
        required: true,
        options: [{ value: SLACK_REPLY, label: 'Reply to the message that started the run' }],
        hint: 'A reply goes in the thread of a channel message, and straight below a direct message.',
      },
      {
        key: 'message',
        label: 'Message',
        kind: 'longTemplate',
        required: true,
        placeholder: '**{{issue.identifier}}** {{issue.title}}\n{{issue.url}}',
      },
      {
        key: 'thread',
        label: 'Reply in thread',
        kind: 'template',
        hint: 'Leave empty to post a new message, or a reply in its own thread. A Slack trigger provides its thread.',
      },
    ],
    outputs: [NEXT, FAILED],
    provides: [
      { key: 'url', label: 'Message link' },
      { key: 'thread', label: 'Thread to reply in' },
    ],
  },
} as const satisfies Record<string, BlockSpec>

export type BlockType = keyof typeof WORKFLOW_BLOCKS

export const BLOCK_TYPES = Object.keys(WORKFLOW_BLOCKS) as BlockType[]

export const BLOCK_CATEGORIES: { id: BlockCategory; label: string }[] = [
  { id: 'trigger', label: 'Start when' },
  { id: 'logic', label: 'Logic' },
  { id: 'agent', label: 'Agents' },
  { id: 'tracker', label: 'Tickets' },
]

/** The blocks of the integrations an organization has connected, by connection kind. */
export function integrationBlocks(kinds: readonly string[]): BlockCatalog {
  return Object.fromEntries(
    Object.entries(WORKFLOW_BLOCKS as Record<string, BlockSpec>).filter(
      ([, spec]) => spec.owner?.kind === 'integration' && kinds.includes(spec.owner.id),
    ),
  )
}

export function blockSpec(type: string, extra: BlockCatalog = {}): BlockSpec | undefined {
  if (Object.hasOwn(WORKFLOW_BLOCKS, type)) return (WORKFLOW_BLOCKS as Record<string, BlockSpec>)[type]
  return Object.hasOwn(extra, type) ? extra[type] : undefined
}

export function isTriggerBlock(type: string): boolean {
  return blockSpec(type)?.category === 'trigger' || PLUGIN_TRIGGER_TYPE.test(type)
}

export function initialBlockConfig(type: string, extra: BlockCatalog = {}): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const field of blockSpec(type, extra)?.fields ?? []) if (field.initial !== undefined) config[field.key] = field.initial
  return config
}

export const CONDITION_FIELDS = [
  { value: 'status', label: 'Status', kind: 'status' },
  { value: 'labels', label: 'Labels', kind: 'label' },
  { value: 'priority', label: 'Priority', kind: 'text' },
  { value: 'title', label: 'Title', kind: 'text' },
  { value: 'description', label: 'Description', kind: 'text' },
  { value: 'author', label: 'Author', kind: 'text' },
  { value: 'assignee', label: 'Assignee', kind: 'text' },
  { value: 'project', label: 'Project', kind: 'text' },
  { value: 'agent', label: 'Agent', kind: 'text' },
] as const

export const CONDITION_OPERATORS = [
  { value: 'is', label: 'is', takesValue: true },
  { value: 'is_not', label: 'is not', takesValue: true },
  { value: 'contains', label: 'contains', takesValue: true },
  { value: 'not_contains', label: 'does not contain', takesValue: true },
  { value: 'is_empty', label: 'is empty', takesValue: false },
  { value: 'not_empty', label: 'is not empty', takesValue: false },
] as const

export const NOTIFICATION_KINDS = ['slack'] as const

export const WORKFLOW_VARIABLES = [
  { path: 'issue.identifier', label: 'Ticket ID' },
  { path: 'issue.title', label: 'Ticket title' },
  { path: 'issue.description', label: 'Ticket description' },
  { path: 'issue.url', label: 'Ticket link' },
  { path: 'issue.status', label: 'Status' },
  { path: 'issue.state', label: 'State in Factorix' },
  { path: 'issue.agent', label: 'Agent on the ticket' },
  { path: 'issue.branch', label: 'Branch' },
  { path: 'issue.priority', label: 'Priority' },
  { path: 'issue.labels', label: 'Labels' },
  { path: 'issue.author', label: 'Author' },
  { path: 'issue.assignee', label: 'Assignee' },
  { path: 'issue.mergeRequests', label: 'Merge requests' },
  { path: 'project.name', label: 'Project' },
  { path: 'workflow.name', label: 'Workflow' },
  { path: 'run.url', label: 'Run link' },
  { path: 'trigger.kind', label: 'What started the run' },
] as const

/** The `{{` being typed just before the caret, if there is one, with what follows it so far. */
export function openPlaceholder(text: string, caret: number): { start: number; query: string } | null {
  const match = /\{\{\s*([\w.-]*)$/.exec(text.slice(0, caret))
  return match ? { start: match.index, query: match[1] ?? '' } : null
}

/** Puts a variable where the open `{{` is, and says where the caret goes after it. */
export function completePlaceholder(text: string, caret: number, path: string): { text: string; caret: number } {
  const open = openPlaceholder(text, caret)
  const start = open?.start ?? caret
  const token = `{{${path}}}`
  const rest = text.slice(caret).replace(/^[\w.-]*(\s*\}\})?/, '')
  return { text: `${text.slice(0, start)}${token}${rest}`, caret: start + token.length }
}

const NODE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export const workflowDefinition = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string().regex(NODE_ID),
        type: z.union([
          z.enum(BLOCK_TYPES as [BlockType, ...BlockType[]]),
          z.string().regex(PLUGIN_BLOCK_TYPE),
          z.string().regex(PLUGIN_TRIGGER_TYPE),
        ]),
        position: z.object({ x: z.number(), y: z.number() }),
        config: z.record(z.string(), z.unknown()),
      }),
    )
    .max(100),
  edges: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        source: z.string(),
        sourceHandle: z.string(),
        target: z.string(),
      }),
    )
    .max(400),
})

export type WorkflowDefinition = z.infer<typeof workflowDefinition>
export type WorkflowNode = WorkflowDefinition['nodes'][number]
export type WorkflowEdge = WorkflowDefinition['edges'][number]

export interface WorkflowIssue {
  nodeId: string | null
  message: string
}

export const MAX_TEMPLATE_LENGTH = 4000
const MAX_PEOPLE = 100

function fieldApplies(field: BlockField, config: Record<string, unknown>): boolean {
  return !field.when || field.when.in.includes(String(config[field.when.key] ?? ''))
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0)
}

function fieldIssue(field: BlockField, config: Record<string, unknown>): string | null {
  if (!fieldApplies(field, config)) return null
  const value = config[field.key]
  if (field.required && isBlank(value)) return `${field.label} is required`
  if (isBlank(value)) return null
  if (field.kind === 'number') {
    const number = Number(value)
    if (!Number.isFinite(number)) return `${field.label} must be a number`
    if (field.min !== undefined && number < field.min) return `${field.label} must be at least ${field.min}`
    if (field.max !== undefined && number > field.max) return `${field.label} must be at most ${field.max}`
  }
  if (field.options && !field.dynamic && field.kind !== 'channel' && !field.options.some((option) => option.value === String(value)))
    return `${field.label} has an unknown value`
  if (typeof value === 'string' && value.length > MAX_TEMPLATE_LENGTH) return `${field.label} is too long`
  if (field.kind === 'people' && (!Array.isArray(value) || value.length > MAX_PEOPLE || value.some((item) => typeof item !== 'string')))
    return `${field.label} has an unknown value`
  if (field.kind === 'rules') {
    const rules = value as { field?: string; operator?: string; value?: string }[]
    for (const rule of rules) {
      const operator = CONDITION_OPERATORS.find((item) => item.value === rule.operator)
      if (!operator || !CONDITION_FIELDS.some((item) => item.value === rule.field)) return 'A rule is incomplete'
      if (operator.takesValue && isBlank(rule.value)) return 'A rule has no value'
    }
  }
  return null
}

function hasCycle(definition: WorkflowDefinition): boolean {
  const next = new Map<string, string[]>()
  for (const edge of definition.edges) next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target])
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): boolean => {
    const seen = state.get(id)
    if (seen) return seen === 'visiting'
    state.set(id, 'visiting')
    const found = (next.get(id) ?? []).some(visit)
    state.set(id, 'done')
    return found
  }
  return definition.nodes.some((node) => visit(node.id))
}

/** A run started by a ticketless trigger has no ticket, so nothing it can reach may need one. */
function ticketIssues(definition: WorkflowDefinition, extra: BlockCatalog): WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  const flagged = new Set<string>()
  for (const trigger of definition.nodes) {
    const spec = blockSpec(trigger.type, extra)
    if (!spec?.ticketless) continue
    const reached = new Set<string>()
    const queue = [trigger.id]
    while (queue.length > 0) {
      const id = queue.shift() as string
      for (const edge of definition.edges) {
        if (edge.source !== id || reached.has(edge.target)) continue
        reached.add(edge.target)
        queue.push(edge.target)
      }
    }
    for (const node of definition.nodes) {
      const needs = blockSpec(node.type, extra)
      if (!reached.has(node.id) || !needs || flagged.has(node.id)) continue
      const choice = needs.fields
        .filter((field) => fieldApplies(field, node.config))
        .flatMap((field) => field.options?.filter((option) => option.needsTicket && option.value === String(node.config[field.key])) ?? [])[0]
      if (!needs.needsTicket && !choice) continue
      flagged.add(node.id)
      const what = choice ? `${choice.label} needs a ticket` : `${needs.title} works on a ticket`
      issues.push({ nodeId: node.id, message: `${what}, and ${spec.title} starts without one` })
    }
  }
  return issues
}

const DAY_MS = 86_400_000

function zoneOffsetMs(timezone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at)
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value)
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - Math.floor(at / 1000) * 1000
}

/**
 * The first time after `after` that an "On a schedule" block fires, or null when its settings make no sense.
 * A time that a clock change skips fires an hour later that day, and one that happens twice fires once.
 */
export function nextScheduleTime(config: Record<string, unknown>, after: Date): Date | null {
  const time = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(config.time ?? '').trim())
  const timezone = String(config.timezone ?? '').trim()
  const days = String(config.days ?? '')
  if (!time || !timezone || !(days === 'daily' || days === 'weekdays' || /^[0-6]$/.test(days))) return null
  try {
    for (let ahead = -1; ahead <= 8; ahead++) {
      const probe = after.getTime() + ahead * DAY_MS
      const local = new Date(probe + zoneOffsetMs(timezone, probe))
      const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Number(time[1]), Number(time[2]))
      const weekday = new Date(wall).getUTCDay()
      if (days === 'weekdays' ? weekday === 0 || weekday === 6 : days !== 'daily' && Number(days) !== weekday) continue
      const guess = wall - zoneOffsetMs(timezone, wall)
      const at = wall - zoneOffsetMs(timezone, guess)
      if (at > after.getTime()) return new Date(at)
    }
  } catch {
    return null
  }
  return null
}

/** Saving a draft is always allowed. This is what has to hold before a workflow can be published. */
export function validateWorkflow(definition: WorkflowDefinition, extra: BlockCatalog = {}): WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]))
  if (nodes.size !== definition.nodes.length) issues.push({ nodeId: null, message: 'Two blocks share an id' })
  if (!definition.nodes.some((node) => isTriggerBlock(node.type))) issues.push({ nodeId: null, message: 'Add a block that starts the workflow' })

  const seen = new Set<string>()
  for (const edge of definition.edges) {
    const key = `${edge.source}/${edge.sourceHandle}/${edge.target}`
    const source = nodes.get(edge.source)
    const target = nodes.get(edge.target)
    if (!source || !target || seen.has(key)) {
      issues.push({ nodeId: edge.source, message: 'A connection points nowhere' })
      continue
    }
    seen.add(key)
    if (!blockSpec(source.type, extra)?.outputs.some((output) => output.id === edge.sourceHandle))
      issues.push({ nodeId: source.id, message: 'A connection leaves through an unknown output' })
    if (isTriggerBlock(target.type)) issues.push({ nodeId: target.id, message: 'Nothing can lead into a starting block' })
  }
  if (hasCycle(definition)) issues.push({ nodeId: null, message: 'Connections cannot loop back on themselves' })
  issues.push(...ticketIssues(definition, extra))

  for (const node of definition.nodes) {
    const spec = blockSpec(node.type, extra)
    if (!spec) {
      issues.push({ nodeId: node.id, message: 'The plugin behind this block is off, or no longer offers it' })
      continue
    }
    const trigger = spec.category === 'trigger'
    if (trigger && !definition.edges.some((edge) => edge.source === node.id))
      issues.push({ nodeId: node.id, message: 'Nothing happens after this block' })
    if (!trigger && !definition.edges.some((edge) => edge.target === node.id))
      issues.push({ nodeId: node.id, message: 'Nothing leads to this block' })
    for (const field of spec.fields) {
      const message = fieldIssue(field, node.config)
      if (message) issues.push({ nodeId: node.id, message })
    }
    if (
      node.type === 'trigger.schedule' &&
      !isBlank(node.config.time) &&
      !isBlank(node.config.timezone) &&
      !nextScheduleTime(node.config, new Date())
    )
      issues.push({ nodeId: node.id, message: 'Give the time as HH:MM and a time zone like Europe/Warsaw' })
  }
  return issues
}

export const workflowInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  projectId: z.string().uuid().nullable().default(null),
  definition: workflowDefinition,
})

export const workflowRunInput = z.object({
  issueIds: z.array(z.string().uuid()).min(1).max(50),
})

export const workflowEnabledInput = z.object({ enabled: z.boolean() })

export type WorkflowRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'
export type WorkflowStepStatus = 'pending' | 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'

export interface WorkflowDto {
  id: string
  name: string
  description: string
  projectId: string | null
  projectName: string | null
  enabled: boolean
  definition: WorkflowDefinition
  publishedVersion: number
  publishedAt: string | null
  hasUnpublishedChanges: boolean
  triggers: string[]
  runCount: number
  lastRunAt: string | null
  lastRunStatus: WorkflowRunStatus | null
  createdAt: string
  updatedAt: string
}

export interface WorkflowStepDto {
  nodeId: string
  block: string
  status: WorkflowStepStatus
  handle: string | null
  output: Record<string, unknown> | null
  error: string | null
  wakeAt: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface WorkflowRunDto {
  id: string
  workflowId: string
  workflowName: string
  workflowVersion: number
  /** Null when a ticketless trigger started the run. */
  issueId: string | null
  issueIdentifier: string | null
  issueTitle: string | null
  status: WorkflowRunStatus
  trigger: { nodeId: string; event: { kind: string } & Record<string, unknown> }
  startedByName: string | null
  error: string | null
  createdAt: string
  finishedAt: string | null
}

export interface WorkflowRunDetailDto extends WorkflowRunDto {
  definition: WorkflowDefinition
  steps: WorkflowStepDto[]
}

export interface NotificationChannelDto {
  id: string
  name: string
  private: boolean
}

export interface NotificationPersonDto {
  id: string
  name: string
}
