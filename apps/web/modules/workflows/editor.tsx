'use client'

import {
  BLOCK_CATEGORIES,
  BLOCK_TYPES,
  type BlockType,
  blockSpec,
  initialBlockConfig,
  isTriggerBlock,
  validateWorkflow,
  type WorkflowDefinition,
  type WorkflowDto,
} from '@factorix/schemas'
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type BuiltInEdge,
  type Connection,
  Controls,
  type EdgeChange,
  MiniMap,
  type NodeChange,
  Panel,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { History, Play, Redo2, Trash2, Undo2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useSWRConfig } from 'swr'
import { type ApiError, api } from '../lib/api'
import { useAgents, useProjects } from '../lib/data'
import { cn } from '../lib/format'
import { useIsDesktop } from '../lib/use-media'
import { PageHeader } from '../shell/page-header'
import { Button, Chip, Dialog, DialogFooter, Toggle, Tooltip } from '../ui'
import { BLOCK_ICONS, type BlockFlowNode, CATEGORY_TONES, isFailureEdge, toDefinition, toFlowEdge, toFlowNode } from './blocks'
import { CanvasContext, type CanvasInfo, FlowCanvas } from './canvas'
import { BlockInspector, WorkflowPanel } from './inspector'
import { RunWorkflowDialog } from './run-dialog'

const BLOCK_MIME = 'application/x-factorix-block'
const SAVE_DELAY_MS = 700
const NODE_WIDTH = 240
const ROW_HEIGHT = 140
const COLUMN_WIDTH = 280
const GRID = 20
const snap = (value: number) => Math.round(value / GRID) * GRID

function newNodeId(type: BlockType, nodes: { id: string }[]): string {
  const base = (type.split('.')[1] ?? type).replaceAll('_', '-')
  const taken = new Set(nodes.map((node) => node.id))
  let index = 1
  while (taken.has(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}

function reaches(from: string, to: string, edges: { source: string; target: string }[], seen = new Set<string>()): boolean {
  if (from === to) return true
  if (seen.has(from)) return false
  seen.add(from)
  return edges.some((edge) => edge.source === from && reaches(edge.target, to, edges, seen))
}

function canConnect(connection: Pick<Connection, 'source' | 'target' | 'sourceHandle'>, nodes: BlockFlowNode[], edges: BuiltInEdge[]): boolean {
  const { source, target, sourceHandle } = connection
  const targetNode = nodes.find((node) => node.id === target)
  if (!targetNode || isTriggerBlock(targetNode.data.type)) return false
  if (edges.some((edge) => edge.source === source && edge.target === target && edge.sourceHandle === sourceHandle)) return false
  return !reaches(target, source, edges)
}

interface Meta {
  name: string
  description: string
  projectId: string | null
}

type SaveState = 'saved' | 'saving' | 'failed'

function useAutosave(id: string, body: Meta & { definition: WorkflowDefinition }, enabled: boolean, onSaved: (workflow: WorkflowDto) => void) {
  const text = JSON.stringify(body)
  const latest = useRef(text)
  latest.current = text
  const saved = useRef(text)
  const inFlight = useRef<Promise<void> | null>(null)
  const [state, setState] = useState<SaveState>('saved')
  const [problem, setProblem] = useState<string | null>(null)
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved

  const flush = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current.then(flush)
    const sending = latest.current
    if (sending === saved.current) return Promise.resolve()
    setState('saving')
    inFlight.current = api
      .put<{ workflow: WorkflowDto }>(`/api/workflows/${id}`, JSON.parse(sending))
      .then(({ workflow }) => {
        saved.current = sending
        inFlight.current = null
        setProblem(null)
        setState(latest.current === sending ? 'saved' : 'saving')
        onSavedRef.current(workflow)
        if (latest.current !== sending) return flush()
      })
      .catch((error: unknown) => {
        inFlight.current = null
        setProblem((error as Error).message)
        setState('failed')
        throw error
      })
    return inFlight.current
  }, [id])

  useEffect(() => {
    if (!enabled || text === saved.current) return
    setState('saving')
    const timer = setTimeout(() => void flush().catch(() => {}), SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text, enabled, flush])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (latest.current !== saved.current) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
      if (latest.current !== saved.current) void flush().catch(() => {})
    }
  }, [flush])

  return { state, problem, flush }
}

/** Delete sits one key away from losing work, so the canvas needs undo. Edits within a moment of each other count as one step. */
function useHistory(definition: WorkflowDefinition, restore: (definition: WorkflowDefinition) => void, enabled: boolean) {
  const key = JSON.stringify(definition)
  const stable = useRef(key)
  const past = useRef<string[]>([])
  const future = useRef<string[]>([])
  const [, redraw] = useState(0)

  useEffect(() => {
    if (key === stable.current) return
    const timer = setTimeout(() => {
      past.current = [...past.current.slice(-99), stable.current]
      future.current = []
      stable.current = key
      redraw((value) => value + 1)
    }, 400)
    return () => clearTimeout(timer)
  }, [key])

  const step = useCallback(
    (from: { current: string[] }, to: { current: string[] }) => {
      const current = key
      const unsettled = current !== stable.current
      const target = unsettled ? stable.current : from.current.at(-1)
      if (!target) return
      if (!unsettled) from.current = from.current.slice(0, -1)
      to.current = [...to.current, current]
      stable.current = target
      restore(JSON.parse(target))
      redraw((value) => value + 1)
    },
    [key, restore],
  )
  const undo = useCallback(() => step(past, future), [step])
  const redo = useCallback(() => step(future, past), [step])

  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, undo, redo])

  return { undo, redo, canUndo: past.current.length > 0 || key !== stable.current, canRedo: future.current.length > 0 }
}

function Palette({ onAdd }: { onAdd: (type: BlockType) => void }) {
  return (
    <aside aria-label="Blocks" className="scroll-thin flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-divider bg-surface p-3">
      {BLOCK_CATEGORIES.map((category) => (
        <section key={category.id} className="flex flex-col gap-0.5">
          <h2 className="px-1.5 pb-1 text-xs text-ink-3">{category.label}</h2>
          {BLOCK_TYPES.filter((type) => blockSpec(type)?.category === category.id).map((type) => {
            const spec = blockSpec(type)
            return (
              <Tooltip key={type} label={spec?.description ?? ''} side="right">
                <button
                  type="button"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(BLOCK_MIME, type)
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  onClick={() => onAdd(type)}
                  className="flex h-8 w-full cursor-grab items-center gap-2 rounded-md px-1.5 text-left text-sm transition-colors duration-75 select-none hover:bg-soft active:cursor-grabbing"
                >
                  <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-sm [&_svg]:size-3', CATEGORY_TONES[category.id])}>
                    {BLOCK_ICONS[type]}
                  </span>
                  <span className="min-w-0 truncate">{spec?.title}</span>
                </button>
              </Tooltip>
            )
          })}
        </section>
      ))}
    </aside>
  )
}

function SaveLabel({ state, problem }: { state: SaveState; problem: string | null }) {
  if (state === 'failed')
    return (
      <Tooltip label={problem ?? 'The last change is not saved'}>
        <span className="hidden text-xs text-danger-ink sm:inline">Not saved</span>
      </Tooltip>
    )
  return <span className="hidden text-xs text-ink-3 sm:inline">{state === 'saving' ? 'Saving' : 'Saved'}</span>
}

function Editor({ initial, canEdit }: { initial: WorkflowDto; canEdit: boolean }) {
  const router = useRouter()
  const flow = useReactFlow<BlockFlowNode, BuiltInEdge>()
  const desktop = useIsDesktop()
  const editable = canEdit && desktop
  const { mutate: mutateCache } = useSWRConfig()
  const [workflow, setLocalWorkflow] = useState(initial)
  const setWorkflow = useCallback(
    (next: WorkflowDto) => {
      setLocalWorkflow(next)
      void mutateCache(`/api/workflows/${next.id}`, { workflow: next }, { revalidate: false })
    },
    [mutateCache],
  )
  const [meta, setMeta] = useState<Meta>({ name: initial.name, description: initial.description, projectId: initial.projectId })
  const toEdge = useCallback(
    (edge: WorkflowDefinition['edges'][number], nodes: WorkflowDefinition['nodes']) => toFlowEdge(edge, isFailureEdge(edge, nodes)),
    [],
  )
  const [nodes, setNodes] = useState<BlockFlowNode[]>(() => initial.definition.nodes.map(toFlowNode))
  const [edges, setEdges] = useState<BuiltInEdge[]>(() => initial.definition.edges.map((edge) => toEdge(edge, initial.definition.nodes)))
  const [runOpen, setRunOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)

  const definition = useMemo(() => toDefinition(nodes, edges), [nodes, edges])
  const definitionKey = JSON.stringify(definition)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key changes exactly when the definition's content does
  const issues = useMemo(() => validateWorkflow(definition), [definitionKey])

  const nameMissing = !meta.name.trim()
  const autosave = useAutosave(workflow.id, { ...meta, definition }, canEdit && !nameMissing, setWorkflow)
  const { flush } = autosave
  const saveState: SaveState = nameMissing ? 'failed' : autosave.state
  const saveProblem = nameMissing ? 'A workflow needs a name' : autosave.problem

  const restore = useCallback(
    (next: WorkflowDefinition) => {
      setNodes((current) =>
        next.nodes.map((node) => {
          const existing = current.find((item) => item.id === node.id)
          return { ...toFlowNode(node), measured: existing?.measured, selected: existing?.selected }
        }),
      )
      setEdges(next.edges.map((edge) => toEdge(edge, next.nodes)))
    },
    [toEdge],
  )
  const { undo, redo, canUndo, canRedo } = useHistory(definition, restore, editable)

  const issuesKey = JSON.stringify(issues)
  const edgesKey = edges.map((edge) => `${edge.source}/${edge.sourceHandle}`).join(',')
  const { data: agents } = useAgents()
  const { data: projects } = useProjects()
  // biome-ignore lint/correctness/useExhaustiveDependencies: every block re-renders when this changes, so it only follows the content
  const info = useMemo<CanvasInfo>(() => {
    const problems = new Map<string, string[]>()
    for (const issue of issues) if (issue.nodeId) problems.set(issue.nodeId, [...(problems.get(issue.nodeId) ?? []), issue.message])
    return {
      problems,
      steps: null,
      connected: new Set(edges.map((edge) => `${edge.source}/${edge.sourceHandle}`)),
      names: {
        agents: new Map((agents?.agents ?? []).map((agent) => [agent.id, agent.displayName])),
        projects: new Map((projects?.projects ?? []).map((project) => [project.id, project.name])),
      },
    }
  }, [issuesKey, edgesKey, agents, projects])

  const onNodesChange = useCallback((changes: NodeChange<BlockFlowNode>[]) => setNodes((current) => applyNodeChanges(changes, current)), [])
  const onEdgesChange = useCallback((changes: EdgeChange<BuiltInEdge>[]) => setEdges((current) => applyEdgeChanges(changes, current)), [])

  const connect = useCallback(
    (connection: Connection) => {
      setEdges((current) => {
        if (!canConnect(connection, flow.getNodes(), current)) return current
        const graphNodes = flow.getNodes().map((node) => ({ id: node.id, type: node.data.type }))
        const sourceHandle = connection.sourceHandle ?? 'next'
        const edge = {
          id: `${connection.source}-${sourceHandle}-${connection.target}`,
          source: connection.source,
          sourceHandle,
          target: connection.target,
        }
        return addEdge(toFlowEdge(edge, isFailureEdge(edge, graphNodes)), current)
      })
    },
    [flow],
  )

  const isValidConnection = useCallback(
    (connection: BuiltInEdge | Connection) =>
      canConnect(
        { source: connection.source, target: connection.target, sourceHandle: connection.sourceHandle ?? null },
        flow.getNodes(),
        flow.getEdges(),
      ),
    [flow],
  )

  const addBlock = useCallback(
    (type: BlockType, at?: { x: number; y: number }) => {
      const current = flow.getNodes()
      const anchor = at ? undefined : current.find((node) => node.selected)
      const id = newNodeId(type, current)
      let position = at
      if (!position) {
        const bounds = document.querySelector('.fx-flow')?.getBoundingClientRect()
        const center = bounds ? flow.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 3 }) : { x: 0, y: 0 }
        position = anchor ? { x: anchor.position.x, y: anchor.position.y + ROW_HEIGHT } : { x: snap(center.x - NODE_WIDTH / 2), y: snap(center.y) }
        const taken = (x: number, y: number) =>
          current.some((node) => Math.abs(node.position.x - x) < NODE_WIDTH && Math.abs(node.position.y - y) < ROW_HEIGHT / 2)
        while (taken(position.x, position.y)) position = { x: position.x + COLUMN_WIDTH, y: position.y }
      }
      const node: BlockFlowNode = { id, type: 'block', position, data: { type, config: initialBlockConfig(type) }, selected: true }
      setNodes((items) => [...items.map((item) => ({ ...item, selected: false })), node])
      if (anchor && !isTriggerBlock(type)) {
        const outputs = blockSpec(anchor.data.type)?.outputs ?? []
        const free = outputs.find(
          (output) => !output.failure && !flow.getEdges().some((edge) => edge.source === anchor.id && edge.sourceHandle === output.id),
        )
        const output = free ?? outputs[0]
        if (output) {
          const edge = { id: `${anchor.id}-${output.id}-${id}`, source: anchor.id, sourceHandle: output.id, target: id }
          setEdges((items) => [...items, toFlowEdge(edge, Boolean(output.failure))])
        }
      }
    },
    [flow],
  )

  const onDrop = (event: DragEvent) => {
    const type = event.dataTransfer.getData(BLOCK_MIME)
    if (!editable || !blockSpec(type)) return
    event.preventDefault()
    const point = flow.screenToFlowPosition({ x: event.clientX - NODE_WIDTH / 2, y: event.clientY - 30 })
    addBlock(type as BlockType, { x: snap(point.x), y: snap(point.y) })
  }

  const selectNode = useCallback(
    (id: string) => {
      setNodes((current) => current.map((node) => ({ ...node, selected: node.id === id })))
      void flow.fitView({ nodes: [{ id }], maxZoom: 1, duration: 200 })
    },
    [flow],
  )

  const selected = nodes.filter((node) => node.selected)
  const inspected = selected.length === 1 ? definition.nodes.find((node) => node.id === selected[0]?.id) : undefined
  const setConfig = useCallback((id: string, patch: Record<string, unknown>) => {
    setNodes((current) =>
      current.map((node) => (node.id === id ? { ...node, data: { ...node.data, config: { ...node.data.config, ...patch } } } : node)),
    )
  }, [])

  const publish = async () => {
    if (issues.length > 0) {
      toast.error(`Fix ${issues.length === 1 ? 'the problem' : `${issues.length} problems`} first`)
      const first = issues.find((issue) => issue.nodeId)?.nodeId
      if (first) selectNode(first)
      return
    }
    setPublishing(true)
    try {
      await flush()
      const { workflow: next } = await api.post<{ workflow: WorkflowDto }>(`/api/workflows/${workflow.id}/publish`)
      setWorkflow(next)
      toast.success(`Published version ${next.publishedVersion}`)
    } catch (error) {
      toast.error((error as ApiError).message)
    } finally {
      setPublishing(false)
    }
  }

  const setEnabled = async (enabled: boolean) => {
    setLocalWorkflow((current) => ({ ...current, enabled }))
    try {
      const { workflow: next } = await api.post<{ workflow: WorkflowDto }>(`/api/workflows/${workflow.id}/enabled`, { enabled })
      setWorkflow(next)
      toast.success(enabled ? 'It will now start by itself' : 'It will no longer start by itself')
    } catch (error) {
      setLocalWorkflow((current) => ({ ...current, enabled: !enabled }))
      toast.error((error as ApiError).message)
    }
  }

  const remove = async () => {
    try {
      await api.delete(`/api/workflows/${workflow.id}`)
      toast.success('Workflow deleted')
      router.push('/workflows')
    } catch (error) {
      toast.error((error as ApiError).message)
    }
  }

  const published = workflow.publishedVersion > 0
  const dirty = !published || workflow.hasUnpublishedChanges || saveState !== 'saved'
  const startsByItself = definition.nodes.some((node) => isTriggerBlock(node.type) && node.type !== 'trigger.manual')

  return (
    <>
      <PageHeader crumbs={[{ label: 'Workflows', href: '/workflows' }, { label: meta.name.trim() || 'Untitled' }]}>
        {canEdit ? <SaveLabel state={saveState} problem={saveProblem} /> : null}
        {published ? (
          <Chip tone={dirty ? 'warning' : 'neutral'} className="hidden lg:inline-flex">
            {dirty ? 'Unpublished changes' : `Version ${workflow.publishedVersion}`}
          </Chip>
        ) : (
          <Chip className="hidden lg:inline-flex">Draft</Chip>
        )}
        {canEdit && desktop && startsByItself ? (
          <Tooltip label={published ? 'Lets the blocks that start by themselves react to tickets' : 'Publish first'}>
            <span className="px-1">
              <Toggle checked={workflow.enabled} disabled={!published} label="On" onChange={(next) => void setEnabled(next)} />
            </span>
          </Tooltip>
        ) : null}
        <Link href={`/workflows/${workflow.id}/runs`}>
          <Button size="sm" variant="ghost">
            <History />
            <span className="hidden sm:inline">Runs</span>
          </Button>
        </Link>
        <Tooltip label={published ? `Runs version ${workflow.publishedVersion}` : 'Publish first'}>
          <span>
            <Button size="sm" disabled={!published} onClick={() => setRunOpen(true)}>
              <Play />
              <span className="hidden sm:inline">Run on tickets</span>
            </Button>
          </span>
        </Tooltip>
        {editable ? (
          <Button size="sm" variant="primary" disabled={publishing || (published && !dirty)} onClick={() => void publish()}>
            Publish
          </Button>
        ) : null}
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        {editable ? <Palette onAdd={addBlock} /> : null}
        <div className="relative min-w-0 flex-1" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
          <CanvasContext.Provider value={info}>
            <FlowCanvas
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={connect}
              isValidConnection={isValidConnection}
              nodesDraggable={editable}
              nodesConnectable={editable}
              edgesFocusable={editable}
              deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
            >
              {desktop ? <Controls position="bottom-left" showInteractive={false} /> : null}
              {desktop ? <MiniMap position="bottom-right" pannable zoomable style={{ width: 150, height: 100 }} /> : null}
              {editable ? (
                <Panel position="top-left" className="flex gap-1 rounded-lg border border-divider bg-surface p-0.5 shadow-control">
                  <Tooltip label="Undo">
                    <Button size="icon" variant="ghost" aria-label="Undo" disabled={!canUndo} onClick={undo}>
                      <Undo2 />
                    </Button>
                  </Tooltip>
                  <Tooltip label="Redo">
                    <Button size="icon" variant="ghost" aria-label="Redo" disabled={!canRedo} onClick={redo}>
                      <Redo2 />
                    </Button>
                  </Tooltip>
                </Panel>
              ) : (
                <Panel
                  position="top-left"
                  className="max-w-[calc(100vw-32px)] rounded-md border border-divider bg-surface px-2.5 py-1.5 text-xs text-ink-2 shadow-control"
                >
                  {canEdit ? 'Editing needs a bigger screen.' : 'Only admins can change workflows.'}
                </Panel>
              )}
            </FlowCanvas>
          </CanvasContext.Provider>
          {nodes.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-ink-3">Drag a block here to start</div>
          ) : null}
        </div>
        {desktop ? (
          <aside aria-label="Details" className="scroll-thin w-80 shrink-0 overflow-y-auto border-l border-divider bg-surface">
            {inspected ? (
              <BlockInspector
                key={inspected.id}
                node={inspected}
                definition={definition}
                projectId={meta.projectId}
                problems={info.problems.get(inspected.id) ?? []}
                readOnly={!editable}
                onConfig={(patch) => setConfig(inspected.id, patch)}
                onDelete={() => void flow.deleteElements({ nodes: [{ id: inspected.id }] })}
              />
            ) : (
              <WorkflowPanel
                name={meta.name}
                description={meta.description}
                projectId={meta.projectId}
                issues={issues}
                readOnly={!editable}
                onChange={(patch) => setMeta((current) => ({ ...current, ...patch }))}
                onShowProblem={selectNode}
                footer={
                  editable ? (
                    <Button size="sm" variant="ghost" className="self-start" onClick={() => setDeleteOpen(true)}>
                      <Trash2 />
                      Delete workflow
                    </Button>
                  ) : null
                }
              />
            )}
          </aside>
        ) : null}
      </div>
      <RunWorkflowDialog workflow={workflow} open={runOpen} onOpenChange={setRunOpen} />
      <Dialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this workflow?"
        description="It stops starting right away. Runs in progress finish, and past runs stay in the audit trail."
      >
        <DialogFooter>
          <Button size="sm" onClick={() => setDeleteOpen(false)}>
            Keep it
          </Button>
          <Button size="sm" variant="danger" onClick={() => void remove()}>
            Delete workflow
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  )
}

export function WorkflowEditor({ workflow, canEdit }: { workflow: WorkflowDto; canEdit: boolean }) {
  return (
    <ReactFlowProvider>
      <Editor initial={workflow} canEdit={canEdit} />
    </ReactFlowProvider>
  )
}
