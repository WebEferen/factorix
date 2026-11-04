export interface GraphNode {
  id: string
  type: string
}

export interface GraphEdge {
  source: string
  sourceHandle: string
  target: string
}

export interface WorkflowGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export type StepStatus = 'pending' | 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'

export interface StepState {
  status: StepStatus
  /** The output the step left through. Only edges from this output are taken. */
  handle: string | null
}

export interface WorkflowPlan {
  ready: string[]
  skip: string[]
  outcome: 'running' | 'succeeded' | 'failed'
}

export const FAILED_HANDLE = 'failed'

const RESOLVED: readonly StepStatus[] = ['succeeded', 'failed', 'skipped']

function isTaken(edge: GraphEdge, steps: Record<string, StepState>): boolean {
  const source = steps[edge.source]
  return (source?.status === 'succeeded' || source?.status === 'failed') && source.handle === edge.sourceHandle
}

/**
 * Decides what can happen next. A step waits for every incoming edge to be settled and runs if at least one was
 * taken, so parallel branches join and the untaken side of a condition skips everything only it leads to.
 */
export function planWorkflow(graph: WorkflowGraph, steps: Record<string, StepState>): WorkflowPlan {
  const unhandled = graph.nodes.some(
    (node) =>
      steps[node.id]?.status === 'failed' &&
      steps[node.id]?.handle === FAILED_HANDLE &&
      !graph.edges.some((edge) => edge.source === node.id && edge.sourceHandle === FAILED_HANDLE),
  )
  if (unhandled) return { ready: [], skip: [], outcome: 'failed' }

  const incoming = new Map<string, GraphEdge[]>()
  for (const edge of graph.edges) incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge])

  const state = { ...steps }
  const ready: string[] = []
  const skip: string[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const node of graph.nodes) {
      if (state[node.id]?.status !== 'pending' || ready.includes(node.id)) continue
      const edges = incoming.get(node.id) ?? []
      if (!edges.every((edge) => RESOLVED.includes(state[edge.source]?.status as StepStatus))) continue
      if (edges.some((edge) => isTaken(edge, state))) {
        ready.push(node.id)
      } else {
        state[node.id] = { status: 'skipped', handle: null }
        skip.push(node.id)
        changed = true
      }
    }
  }

  const finished = graph.nodes.every((node) => RESOLVED.includes(state[node.id]?.status as StepStatus))
  return { ready, skip, outcome: finished ? 'succeeded' : 'running' }
}
