export type FactoryState = 'untracked' | 'queued' | 'active' | 'waiting_human' | 'awaiting_merge' | 'done' | 'failed' | 'cancelled'

const TRANSITIONS: Record<FactoryState, readonly FactoryState[]> = {
  untracked: ['queued', 'active', 'waiting_human', 'cancelled'],
  queued: ['active', 'waiting_human', 'failed', 'cancelled'],
  active: ['active', 'waiting_human', 'awaiting_merge', 'done', 'failed', 'cancelled'],
  waiting_human: ['active', 'awaiting_merge', 'failed', 'cancelled'],
  awaiting_merge: ['active', 'awaiting_merge', 'done', 'failed', 'cancelled'],
  done: ['queued', 'active', 'waiting_human', 'cancelled'],
  failed: ['queued', 'active', 'waiting_human', 'cancelled'],
  cancelled: ['queued', 'active', 'waiting_human'],
}

export const TERMINAL_FACTORY_STATES: readonly FactoryState[] = ['done', 'failed', 'cancelled']

export function canTransitionIssue(from: FactoryState, to: FactoryState): boolean {
  return TRANSITIONS[from].includes(to)
}
