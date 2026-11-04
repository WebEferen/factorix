'use client'

import { blockSpec, type WorkflowRunDetailDto, type WorkflowStepDto } from '@factorix/schemas'
import { type BuiltInEdge, ReactFlowProvider } from '@xyflow/react'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useAgents, useProjects } from '../lib/data'
import { cn, duration, fullDate, timeAgo } from '../lib/format'
import {
  BLOCK_ICONS,
  type BlockFlowNode,
  CATEGORY_TONES,
  isFailureEdge,
  RunStatusChip,
  STEP_STATUS,
  summarizeBlock,
  toFlowEdge,
  toFlowNode,
} from './blocks'
import { CanvasContext, type CanvasInfo, FlowCanvas } from './canvas'

const FINISHED = new Set(['succeeded', 'failed'])

function OutputValue({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text.startsWith('https://'))
    return (
      <a href={text} target="_blank" rel="noreferrer" className="break-all text-link hover:underline">
        {text}
      </a>
    )
  return <span className="break-words">{text}</span>
}

function StepDetail({ step }: { step: WorkflowStepDto }) {
  const output = Object.entries(step.output ?? {}).filter(([key]) => key !== 'kind')
  if (!step.error && !step.wakeAt && output.length === 0) return null
  return (
    <div className="flex flex-col gap-1 px-3 pb-2.5 pl-10 text-xs text-ink-2">
      {step.error ? <p className="break-words text-danger-ink">{step.error}</p> : null}
      {step.wakeAt && step.status === 'waiting' ? <p>Gives up or continues {fullDate(step.wakeAt)}</p> : null}
      {output.map(([key, value]) => (
        <p key={key}>
          <span className="text-ink-3">{key}: </span>
          <OutputValue value={value} />
        </p>
      ))}
    </div>
  )
}

function stepOrder(run: WorkflowRunDetailDto): WorkflowStepDto[] {
  const position = new Map(run.definition.nodes.map((node, index) => [node.id, index]))
  return [...run.steps].sort((a, b) => {
    if (a.startedAt && b.startedAt) return a.startedAt.localeCompare(b.startedAt)
    if (a.startedAt || b.startedAt) return a.startedAt ? -1 : 1
    return (position.get(a.nodeId) ?? 0) - (position.get(b.nodeId) ?? 0)
  })
}

export function RunView({ run }: { run: WorkflowRunDetailDto }) {
  const [selected, setSelected] = useState<string | null>(null)
  const { data: agents } = useAgents()
  const { data: projects } = useProjects()
  const stepsKey = JSON.stringify(run.steps.map((step) => [step.nodeId, step.status, step.handle]))

  // biome-ignore lint/correctness/useExhaustiveDependencies: only redraw the canvas when a step changes
  const edges = useMemo<BuiltInEdge[]>(() => {
    const steps = new Map(run.steps.map((step) => [step.nodeId, step]))
    return run.definition.edges.map((edge) => {
      const source = steps.get(edge.source)
      const taken = Boolean(source && FINISHED.has(source.status) && source.handle === edge.sourceHandle)
      return { ...toFlowEdge(edge, isFailureEdge(edge, run.definition.nodes), taken ? 'taken' : 'idle'), selectable: false, focusable: false }
    })
  }, [stepsKey, run.definition])

  const nodes = useMemo<BlockFlowNode[]>(
    () => run.definition.nodes.map((node) => ({ ...toFlowNode(node), selected: node.id === selected, draggable: false })),
    [run.definition, selected],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: only redraw the canvas when a step changes
  const info = useMemo<CanvasInfo>(
    () => ({
      problems: new Map(),
      steps: new Map(run.steps.map((step) => [step.nodeId, step])),
      connected: new Set(run.definition.edges.map((edge) => `${edge.source}/${edge.sourceHandle}`)),
      names: {
        agents: new Map((agents?.agents ?? []).map((agent) => [agent.id, agent.displayName])),
        projects: new Map((projects?.projects ?? []).map((project) => [project.id, project.name])),
      },
    }),
    [stepsKey, run.definition, agents, projects],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="relative h-[40vh] shrink-0 border-b border-divider md:h-auto md:min-w-0 md:flex-1 md:border-b-0">
        <ReactFlowProvider>
          <CanvasContext.Provider value={info}>
            <FlowCanvas
              nodes={nodes}
              edges={edges}
              nodesDraggable={false}
              nodesConnectable={false}
              deleteKeyCode={null}
              onNodeClick={(_, node) => setSelected(node.id)}
              onPaneClick={() => setSelected(null)}
            />
          </CanvasContext.Provider>
        </ReactFlowProvider>
      </div>
      <aside aria-label="Steps" className="scroll-thin min-h-0 flex-1 overflow-y-auto border-divider bg-surface md:w-96 md:flex-none md:border-l">
        <div className="flex flex-col gap-1.5 border-b border-divider p-4">
          <div className="flex items-center gap-2">
            <RunStatusChip status={run.status} />
            <span className="text-xs text-ink-2">Version {run.workflowVersion}</span>
          </div>
          <Link href={`/issues/${run.issueId}`} className="text-sm hover:underline">
            <span className="text-ink-2">{run.issueIdentifier}</span> {run.issueTitle}
          </Link>
          <p className="text-xs text-ink-2">
            {run.startedByName ? `Started by ${run.startedByName}` : 'Started by itself'} {timeAgo(run.createdAt)}
            {run.finishedAt ? `, took ${duration(run.createdAt, run.finishedAt)}` : ''}
          </p>
          {run.error ? <p className="rounded-md bg-danger-soft px-2.5 py-2 text-xs break-words text-danger-ink">{run.error}</p> : null}
        </div>
        <ol>
          {stepOrder(run).map((step) => {
            const node = run.definition.nodes.find((item) => item.id === step.nodeId)
            const spec = blockSpec(step.block)
            const status = STEP_STATUS[step.status]
            return (
              <li
                key={step.nodeId}
                data-testid={`step-${step.nodeId}`}
                className={cn('border-b border-divider', selected === step.nodeId && 'bg-softer')}
              >
                <button
                  type="button"
                  onClick={() => setSelected(step.nodeId)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-75 hover:bg-softer"
                >
                  <span
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-sm [&_svg]:size-3',
                      spec ? CATEGORY_TONES[spec.category] : 'bg-soft',
                    )}
                  >
                    {node ? BLOCK_ICONS[node.type] : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{spec?.title ?? step.block}</span>
                    {node ? <span className="block truncate text-xs text-ink-2">{summarizeBlock(node.type, node.config, info.names)}</span> : null}
                  </span>
                  <span className={cn('flex shrink-0 items-center gap-1 text-xs [&_svg]:size-3.5', status.className)}>
                    {status.icon}
                    {status.label}
                  </span>
                </button>
                <StepDetail step={step} />
              </li>
            )
          })}
        </ol>
      </aside>
    </div>
  )
}
