export type RunState = 'queued' | 'preparing' | 'running' | 'waiting_approval' | 'suspended' | 'finalizing' | 'succeeded' | 'failed' | 'cancelled'

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ['preparing', 'cancelled', 'failed'],
  preparing: ['running', 'finalizing', 'failed', 'cancelled'],
  running: ['waiting_approval', 'finalizing', 'failed', 'cancelled'],
  waiting_approval: ['running', 'suspended', 'finalizing', 'failed', 'cancelled'],
  suspended: ['preparing', 'failed', 'cancelled'],
  finalizing: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
}

export const TERMINAL_RUN_STATES: readonly RunState[] = ['succeeded', 'failed', 'cancelled']

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to)
}

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state)
}
