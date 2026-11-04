'use client'

import '@xyflow/react/dist/style.css'
import './canvas.css'
import { blockSpec, isTriggerBlock, type WorkflowStepDto } from '@factorix/schemas'
import {
  Background,
  BackgroundVariant,
  type BuiltInEdge,
  ConnectionLineType,
  Handle,
  type NodeProps,
  Position,
  ReactFlow,
  type ReactFlowProps,
} from '@xyflow/react'
import { CircleAlert } from 'lucide-react'
import { createContext, memo, useContext } from 'react'
import { cn } from '../lib/format'
import { Tooltip } from '../ui'
import { BLOCK_ICONS, type BlockFlowNode, type BlockNames, CATEGORY_TONES, STEP_STATUS, summarizeBlock } from './blocks'

export interface CanvasInfo {
  names: BlockNames
  problems: Map<string, string[]>
  /** Only set when showing a run. */
  steps: Map<string, WorkflowStepDto> | null
  /** `source/handle` pairs in use. An unused failure output stays quiet until it is needed. */
  connected: Set<string>
}

export const CanvasContext = createContext<CanvasInfo>({
  names: { agents: new Map(), projects: new Map() },
  problems: new Map(),
  steps: null,
  connected: new Set(),
})

const STEP_BORDERS: Record<string, string> = {
  running: 'border-signal',
  waiting: 'border-signal',
  queued: 'border-signal',
  succeeded: 'border-success',
  failed: 'border-danger',
}

const BlockNode = memo(function BlockNode({ id, data, selected }: NodeProps<BlockFlowNode>) {
  const { names, problems, steps, connected } = useContext(CanvasContext)
  const spec = blockSpec(data.type)
  if (!spec) return null
  const nodeProblems = problems.get(id)
  const step = steps?.get(id)
  const status = step ? STEP_STATUS[step.status] : null
  const dimmed = step && ['pending', 'skipped', 'cancelled'].includes(step.status)
  const outputs = spec.outputs
  return (
    <div
      data-testid={`block-${id}`}
      data-status={step?.status}
      className={cn(
        'w-60 rounded-lg border bg-surface shadow-control transition-[border-color,opacity] duration-100',
        step ? (STEP_BORDERS[step.status] ?? 'border-divider') : nodeProblems ? 'border-danger' : 'border-divider hover:border-field',
        selected && 'border-signal ring-1 ring-signal',
        dimmed && 'opacity-60',
      )}
    >
      {isTriggerBlock(data.type) ? null : <Handle type="target" position={Position.Top} />}
      <div className="flex items-center gap-2 px-2.5 pt-2.5">
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5', CATEGORY_TONES[spec.category])}>
          {BLOCK_ICONS[data.type]}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{spec.title}</span>
        {nodeProblems && !step ? (
          <Tooltip label={nodeProblems.join('. ')}>
            <CircleAlert aria-label={nodeProblems.join('. ')} className="size-4 shrink-0 text-danger-ink" />
          </Tooltip>
        ) : null}
        {status ? (
          <Tooltip label={status.label}>
            <span role="img" aria-label={status.label} className={cn('shrink-0 [&_svg]:size-4', status.className)}>
              {status.icon}
            </span>
          </Tooltip>
        ) : null}
      </div>
      <div className="truncate px-2.5 pt-1 pb-2.5 text-xs text-ink-2">{summarizeBlock(data.type, data.config, names) || ' '}</div>
      {outputs.length > 1 ? (
        <div className="flex border-t border-divider">
          {outputs.map((output) => (
            <span
              key={output.id}
              className={cn(
                'min-w-0 flex-1 truncate px-1 pt-1 pb-1.5 text-center text-xs',
                output.failure && connected.has(`${id}/${output.id}`) ? 'text-danger-ink' : 'text-ink-3',
              )}
            >
              {output.label}
            </span>
          ))}
        </div>
      ) : null}
      {outputs.map((output, index) => (
        <Handle
          key={output.id}
          id={output.id}
          type="source"
          position={Position.Bottom}
          aria-label={`${spec.title}: ${output.label}`}
          className={output.failure && connected.has(`${id}/${output.id}`) ? 'fx-handle-failed' : undefined}
          style={{ left: `${((index + 0.5) / outputs.length) * 100}%` }}
        />
      ))}
    </div>
  )
})

const NODE_TYPES = { block: BlockNode }

export function FlowCanvas({ children, ...props }: ReactFlowProps<BlockFlowNode, BuiltInEdge>) {
  return (
    <ReactFlow<BlockFlowNode, BuiltInEdge>
      className="fx-flow"
      nodeTypes={NODE_TYPES}
      connectionLineType={ConnectionLineType.SmoothStep}
      snapToGrid
      snapGrid={[20, 20]}
      fitView
      fitViewOptions={{ maxZoom: 1, padding: 0.12 }}
      minZoom={0.25}
      maxZoom={1.5}
      attributionPosition="top-right"
      {...props}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
      {children}
    </ReactFlow>
  )
}
