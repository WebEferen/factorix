'use client'

import {
  type BlockCategory,
  type BlockType,
  blockSpec,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowRunStatus,
  type WorkflowStepStatus,
} from '@factorix/schemas'
import { type BuiltInEdge, MarkerType, type Node } from '@xyflow/react'
import {
  ArrowRightLeft,
  Bot,
  Check,
  CircleDashed,
  CircleDot,
  CirclePlus,
  CircleSlash,
  CircleX,
  Clock,
  FilePlus,
  GitMerge,
  Hourglass,
  Loader2,
  MessageSquare,
  MessageSquareText,
  Play,
  Send,
  Split,
  Tag,
  Tags,
  Timer,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Chip } from '../ui'

export const BLOCK_ICONS: Record<BlockType, ReactNode> = {
  'trigger.manual': <Play />,
  'trigger.issue_created': <CirclePlus />,
  'trigger.status_changed': <ArrowRightLeft />,
  'trigger.label_added': <Tag />,
  'trigger.agent_finished': <Bot />,
  'trigger.merge_request': <GitMerge />,
  'logic.condition': <Split />,
  'logic.wait': <Timer />,
  'logic.wait_for': <Hourglass />,
  'agent.run': <Bot />,
  'agent.prompt': <MessageSquareText />,
  'tracker.comment': <MessageSquare />,
  'tracker.set_status': <CircleDot />,
  'tracker.label': <Tags />,
  'tracker.create_issue': <FilePlus />,
  'notify.send': <Send />,
}

export const CATEGORY_TONES: Record<BlockCategory, string> = {
  trigger: 'bg-selected text-signal',
  logic: 'bg-warning-soft text-warning-ink',
  agent: 'bg-soft text-ink',
  tracker: 'bg-soft text-ink-2',
  notify: 'bg-success-soft text-success',
}

export interface BlockNames {
  agents: Map<string, string>
  projects: Map<string, string>
}

const clip = (value: unknown) => String(value ?? '').trim()

/** One line under the block's title, so a flow can be read without opening each block. */
export function summarizeBlock(type: string, config: Record<string, unknown>, names: BlockNames): string {
  const fieldLabel = (key: string) =>
    blockSpec(type)
      ?.fields.find((field) => field.key === key)
      ?.options?.find((option) => option.value === String(config[key]))?.label ?? ''
  switch (type) {
    case 'trigger.manual':
      return 'When someone runs it on a ticket'
    case 'trigger.issue_created':
      return 'Any new ticket'
    case 'trigger.status_changed':
      return clip(config.to) ? `Moves to ${clip(config.to)}` : 'Moves to any status'
    case 'trigger.label_added':
      return clip(config.label) ? `Gets ${clip(config.label)}` : 'Gets any label'
    case 'trigger.agent_finished':
      return fieldLabel('result')
    case 'trigger.merge_request':
      return fieldLabel('event')
    case 'logic.condition': {
      const rules = (config.rules ?? []) as { field?: string; operator?: string; value?: string }[]
      const first = rules[0]
      if (!first) return 'No rules yet'
      const field = CONDITION_FIELDS.find((item) => item.value === first.field)?.label ?? ''
      const operator = CONDITION_OPERATORS.find((item) => item.value === first.operator)
      const text = `${field} ${operator?.label ?? ''} ${operator?.takesValue ? clip(first.value) : ''}`.trim()
      return rules.length > 1 ? `${text}, and ${rules.length - 1} more` : text
    }
    case 'logic.wait':
      return `${clip(config.amount) || '?'} ${clip(config.unit)}`
    case 'logic.wait_for':
      return fieldLabel('event')
    case 'agent.run':
      return names.agents.get(clip(config.agentId)) ?? "Project's default engineer"
    case 'agent.prompt':
      return clip(config.prompt) || 'No prompt yet'
    case 'tracker.comment':
      return clip(config.body) || 'No comment yet'
    case 'tracker.set_status':
      return clip(config.status) ? `To ${clip(config.status)}` : 'No status yet'
    case 'tracker.label':
      return clip(config.label) ? `${fieldLabel('action')} ${clip(config.label)}` : 'No label yet'
    case 'tracker.create_issue':
      return clip(config.title) || 'No title yet'
    case 'notify.send':
      return clip(config.channelName) ? `#${clip(config.channelName)}` : 'No channel yet'
    default:
      return ''
  }
}

export interface BlockData extends Record<string, unknown> {
  type: BlockType
  config: Record<string, unknown>
}

export type BlockFlowNode = Node<BlockData, 'block'>

export function toFlowNode(node: WorkflowNode): BlockFlowNode {
  return { id: node.id, type: 'block', position: node.position, data: { type: node.type, config: node.config } }
}

export function isFailureEdge(edge: Pick<WorkflowEdge, 'source' | 'sourceHandle'>, nodes: { id: string; type: string }[]): boolean {
  const source = nodes.find((node) => node.id === edge.source)
  return Boolean(source && blockSpec(source.type)?.outputs.find((output) => output.id === edge.sourceHandle)?.failure)
}

export function toFlowEdge(edge: WorkflowEdge, failure: boolean, tone?: 'taken' | 'idle'): BuiltInEdge {
  const color = tone === 'taken' ? 'var(--signal)' : failure ? 'var(--danger)' : 'var(--ink-3)'
  return {
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    type: 'smoothstep',
    pathOptions: { borderRadius: 10 },
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
    className: tone ? `fx-edge-${tone}` : failure ? 'fx-edge-failed' : undefined,
  }
}

export function toDefinition(nodes: BlockFlowNode[], edges: BuiltInEdge[]): WorkflowDefinition {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.type,
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      config: node.data.config,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? '',
      target: edge.target,
    })),
  }
}

export const STEP_STATUS: Record<WorkflowStepStatus, { label: string; icon: ReactNode; className: string }> = {
  pending: { label: 'Not reached', icon: <CircleDashed />, className: 'text-ink-3' },
  queued: { label: 'Queued', icon: <Clock />, className: 'text-ink-2' },
  running: { label: 'Running', icon: <Loader2 className="animate-spin" />, className: 'text-signal' },
  waiting: { label: 'Waiting', icon: <Hourglass />, className: 'text-signal' },
  succeeded: { label: 'Done', icon: <Check />, className: 'text-success' },
  failed: { label: 'Failed', icon: <CircleX />, className: 'text-danger-ink' },
  skipped: { label: 'Skipped', icon: <CircleSlash />, className: 'text-ink-3' },
  cancelled: { label: 'Cancelled', icon: <CircleSlash />, className: 'text-ink-3' },
}

const RUN_TONES: Record<WorkflowRunStatus, 'info' | 'success' | 'danger' | 'neutral'> = {
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
}

const RUN_LABELS: Record<WorkflowRunStatus, string> = { running: 'Running', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled' }

export function RunStatusChip({ status }: { status: WorkflowRunStatus }) {
  return <Chip tone={RUN_TONES[status]}>{RUN_LABELS[status]}</Chip>
}

export function triggerSummary(triggers: string[]): string {
  if (triggers.length === 0) return 'Not published yet'
  return triggers.map((type) => blockSpec(type)?.title ?? type).join(', ')
}
