import { z } from 'zod'

export type BlockCategory = 'trigger' | 'logic' | 'agent' | 'tracker' | 'notify'

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
  | 'project'
  | 'status'
  | 'label'
  | 'connection'
  | 'channel'
  | 'rules'

export interface BlockField {
  key: string
  label: string
  kind: BlockFieldKind
  required?: boolean
  placeholder?: string
  hint?: string
  options?: { value: string; label: string }[]
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
  /** What the block hands to later blocks, listed as variables. */
  provides?: { key: string; label: string }[]
}

const NEXT: BlockOutput = { id: 'next', label: 'Next' }
const FAILED: BlockOutput = { id: 'failed', label: 'Failed', failure: true }

const STATUS_FIELD_HINT = 'Leave empty for any status.'

export const WORKFLOW_BLOCKS = {
  'trigger.manual': {
    category: 'trigger',
    title: 'Run by hand',
    description: 'Starts when someone runs this workflow on a ticket.',
    fields: [],
    outputs: [NEXT],
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
  },
  'trigger.label_added': {
    category: 'trigger',
    title: 'Label added',
    description: 'Starts when a ticket gets a label.',
    fields: [{ key: 'label', label: 'Label', kind: 'label', hint: 'Leave empty for any label.' }],
    outputs: [NEXT],
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
  },
  'logic.condition': {
    category: 'logic',
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
  },
  'agent.run': {
    category: 'agent',
    title: 'Run agent',
    description: 'Hands the ticket to an agent and continues when the work is done.',
    fields: [{ key: 'agentId', label: 'Agent', kind: 'agent', hint: "Leave empty for the project's default engineer." }],
    outputs: [{ id: 'next', label: 'Finished' }, FAILED],
    provides: [{ key: 'result', label: 'Result' }],
  },
  'tracker.comment': {
    category: 'tracker',
    title: 'Comment on ticket',
    description: 'Posts a comment on the ticket in the tracker.',
    fields: [{ key: 'body', label: 'Comment', kind: 'longTemplate', required: true, placeholder: 'Picked up {{issue.identifier}}.' }],
    outputs: [NEXT, FAILED],
  },
  'tracker.set_status': {
    category: 'tracker',
    title: 'Set status',
    description: 'Moves the ticket to a status.',
    fields: [{ key: 'status', label: 'Status', kind: 'status', required: true }],
    outputs: [NEXT, FAILED],
  },
  'tracker.label': {
    category: 'tracker',
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
  'notify.send': {
    category: 'notify',
    title: 'Send notification',
    description: 'Sends a message to a channel, like Slack.',
    fields: [
      { key: 'connectionId', label: 'Connection', kind: 'connection', required: true },
      { key: 'channel', label: 'Channel', kind: 'channel', required: true },
      {
        key: 'message',
        label: 'Message',
        kind: 'longTemplate',
        required: true,
        placeholder: '**{{issue.identifier}}** {{issue.title}}\n{{issue.url}}',
      },
    ],
    outputs: [NEXT, FAILED],
    provides: [{ key: 'url', label: 'Message link' }],
  },
} as const satisfies Record<string, BlockSpec>

export type BlockType = keyof typeof WORKFLOW_BLOCKS

export const BLOCK_TYPES = Object.keys(WORKFLOW_BLOCKS) as BlockType[]

export const BLOCK_CATEGORIES: { id: BlockCategory; label: string }[] = [
  { id: 'trigger', label: 'Start when' },
  { id: 'logic', label: 'Logic' },
  { id: 'agent', label: 'Agents' },
  { id: 'tracker', label: 'Tickets' },
  { id: 'notify', label: 'Notifications' },
]

export function blockSpec(type: string): BlockSpec | undefined {
  return Object.hasOwn(WORKFLOW_BLOCKS, type) ? (WORKFLOW_BLOCKS as Record<string, BlockSpec>)[type] : undefined
}

export function isTriggerBlock(type: string): boolean {
  return blockSpec(type)?.category === 'trigger'
}

export function initialBlockConfig(type: string): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const field of blockSpec(type)?.fields ?? []) if (field.initial !== undefined) config[field.key] = field.initial
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
  { path: 'issue.url', label: 'Ticket link' },
  { path: 'issue.status', label: 'Status' },
  { path: 'issue.priority', label: 'Priority' },
  { path: 'issue.labels', label: 'Labels' },
  { path: 'issue.author', label: 'Author' },
  { path: 'issue.assignee', label: 'Assignee' },
  { path: 'issue.mergeRequests', label: 'Merge requests' },
  { path: 'project.name', label: 'Project' },
  { path: 'workflow.name', label: 'Workflow' },
  { path: 'run.url', label: 'Run link' },
] as const

const NODE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export const workflowDefinition = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string().regex(NODE_ID),
        type: z.enum(BLOCK_TYPES as [BlockType, ...BlockType[]]),
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
  if (field.options && !field.options.some((option) => option.value === String(value))) return `${field.label} has an unknown value`
  if (typeof value === 'string' && value.length > MAX_TEMPLATE_LENGTH) return `${field.label} is too long`
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

/** Saving a draft is always allowed. This is what has to hold before a workflow can be published. */
export function validateWorkflow(definition: WorkflowDefinition): WorkflowIssue[] {
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
    if (!blockSpec(source.type)?.outputs.some((output) => output.id === edge.sourceHandle))
      issues.push({ nodeId: source.id, message: 'A connection leaves through an unknown output' })
    if (isTriggerBlock(target.type)) issues.push({ nodeId: target.id, message: 'Nothing can lead into a starting block' })
  }
  if (hasCycle(definition)) issues.push({ nodeId: null, message: 'Connections cannot loop back on themselves' })

  for (const node of definition.nodes) {
    const spec = blockSpec(node.type)
    if (!spec) continue
    const trigger = spec.category === 'trigger'
    if (trigger && !definition.edges.some((edge) => edge.source === node.id))
      issues.push({ nodeId: node.id, message: 'Nothing happens after this block' })
    if (!trigger && !definition.edges.some((edge) => edge.target === node.id))
      issues.push({ nodeId: node.id, message: 'Nothing leads to this block' })
    for (const field of spec.fields) {
      const message = fieldIssue(field, node.config)
      if (message) issues.push({ nodeId: node.id, message })
    }
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
  triggers: BlockType[]
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
  issueId: string
  issueIdentifier: string
  issueTitle: string
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
