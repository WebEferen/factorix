import type { Phase } from '@factorix/runtime'
import type { FactoryState } from '../state/issue'

export type Autonomy = 'plan_first' | 'human_merge' | 'full_auto'
export type TrackerStateKey = 'queued' | 'in_progress' | 'waiting_human' | 'in_review' | 'blocked' | 'done' | 'cancelled'
export type GateKind = 'plan' | 'merge' | 'partial_merge' | 'revert_blocked'
export type ExternalEventName = 'mr.merged' | 'mr.closed' | 'mr.note.human' | 'mr.partial' | 'mr.reverted'

export interface StepCondition {
  autonomy: Autonomy[]
}

interface BaseStep {
  if?: StepCondition
  else?: string
  tracker?: { onEnter?: TrackerStateKey }
  on?: Record<string, string>
}

export interface RunStep extends BaseStep {
  kind: 'run'
  role: string
  phase: Phase
  waitFor?: 'ci'[]
  maxLoops?: number
  onLoopsExceeded?: string
  maxAttempts?: number
  onDone: Record<string, string>
}

export interface GateStep extends BaseStep {
  kind: 'gate'
  approval: GateKind
  timeoutMinutes?: number
  on: Record<string, string>
}

export interface ActionStep extends BaseStep {
  kind: 'action'
  action: 'scm.merge' | 'scm.revert'
  on: Record<string, string>
}

export interface TerminalStep {
  kind: 'terminal'
  state: Extract<FactoryState, 'done' | 'failed' | 'cancelled'>
  tracker?: { onEnter?: TrackerStateKey }
}

export type PipelineStep = RunStep | GateStep | ActionStep | TerminalStep

export interface PipelineDefinition {
  version: 1
  entry: string
  /** Where work starts when the assigned agent's role has its own path. */
  entryByRole?: Record<string, string>
  steps: Record<string, PipelineStep>
}

export interface PipelineCursor {
  step: string
  enteredAt: string
  loops: Record<string, number>
  attempts: Record<string, number>
  waitingFor: 'ci' | null
}

export type CommentTemplate = 'merge_blocked' | 'merge_partial' | 'merge_reverted' | 'revert_blocked'

export type PipelineEvent =
  | { type: 'start' }
  | { type: 'run.finished'; result: string; retryable?: boolean }
  | { type: 'approval.decided'; decision: 'approved' | 'rejected' | 'expired'; choice?: string }
  | { type: 'ci.settled' }
  | { type: 'external'; name: ExternalEventName }
  | { type: 'action.result'; result: 'merged' | 'failed' | 'partial' | 'blocked' }
  | { type: 'cancel' }

export type PipelineAction =
  | { type: 'enqueueRun'; role: string; phase: Phase; step: string; attempt: number }
  | { type: 'waitForCi' }
  | { type: 'createApproval'; kind: GateKind; timeoutMinutes?: number }
  | { type: 'closePendingApprovals' }
  | { type: 'cancelActiveRun' }
  | { type: 'setTrackerState'; key: TrackerStateKey }
  | { type: 'postComment'; template: 'loops_exceeded' | 'run_failed' | CommentTemplate; step: string }
  | { type: 'scmMerge' }
  | { type: 'scmRevert' }

export interface AdvanceContext {
  autonomy: Autonomy
  now: string
  assignedRole?: string
}

export interface AdvanceResult {
  cursor: PipelineCursor | null
  actions: PipelineAction[]
  factoryState: FactoryState | null
  handled: boolean
}
