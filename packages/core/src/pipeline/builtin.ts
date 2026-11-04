import type { PipelineDefinition } from './types'

export const BUILTIN_PIPELINE_NAME = 'engineer-reviewer'

export const BUILTIN_PIPELINE: PipelineDefinition = {
  version: 1,
  entry: 'plan',
  entryByRole: { other: 'task' },
  steps: {
    plan: {
      kind: 'run',
      role: 'engineer',
      phase: 'plan',
      if: { autonomy: ['plan_first'] },
      else: 'implement',
      tracker: { onEnter: 'in_progress' },
      maxAttempts: 2,
      onDone: { completed: 'approve_plan', failed: 'fail' },
    },
    approve_plan: {
      kind: 'gate',
      approval: 'plan',
      timeoutMinutes: 2880,
      tracker: { onEnter: 'waiting_human' },
      on: { approved: 'implement', rejected: 'cancel', expired: 'cancel' },
    },
    implement: {
      kind: 'run',
      role: 'engineer',
      phase: 'implement',
      tracker: { onEnter: 'in_progress' },
      maxAttempts: 2,
      onDone: { completed: 'review', no_changes: 'fail', failed: 'fail' },
    },
    review: {
      kind: 'run',
      role: 'reviewer',
      phase: 'review',
      waitFor: ['ci'],
      maxLoops: 3,
      onLoopsExceeded: 'await_merge',
      maxAttempts: 2,
      tracker: { onEnter: 'in_review' },
      on: { 'mr.merged': 'done', 'mr.closed': 'cancel' },
      onDone: { 'verdict:approve': 'await_merge', 'verdict:request_changes': 'address', failed: 'await_merge' },
    },
    address: {
      kind: 'run',
      role: 'engineer',
      phase: 'address_review',
      maxAttempts: 2,
      tracker: { onEnter: 'in_progress' },
      on: { 'mr.merged': 'done', 'mr.closed': 'cancel' },
      onDone: { completed: 'review', no_changes: 'await_merge', failed: 'fail' },
    },
    await_merge: {
      kind: 'gate',
      approval: 'merge',
      if: { autonomy: ['plan_first', 'human_merge'] },
      else: 'auto_merge',
      tracker: { onEnter: 'in_review' },
      on: { approved: 'auto_merge', 'mr.note.human': 'address', 'mr.merged': 'done', 'mr.closed': 'cancel' },
    },
    auto_merge: {
      kind: 'action',
      action: 'scm.merge',
      on: { merged: 'done', failed: 'merge_blocked', 'mr.merged': 'done', 'mr.closed': 'cancel' },
    },
    merge_blocked: {
      kind: 'gate',
      approval: 'merge',
      tracker: { onEnter: 'in_review' },
      on: { approved: 'auto_merge', 'mr.note.human': 'address', 'mr.merged': 'done', 'mr.closed': 'cancel' },
    },
    task: {
      kind: 'run',
      role: 'other',
      phase: 'task',
      maxAttempts: 2,
      onDone: { completed: 'task_done', failed: 'task_failed' },
    },
    // A report does not finish the ticket, so these leave its tracker status alone.
    task_done: { kind: 'terminal', state: 'done' },
    task_failed: { kind: 'terminal', state: 'failed' },
    done: { kind: 'terminal', state: 'done', tracker: { onEnter: 'done' } },
    fail: { kind: 'terminal', state: 'failed', tracker: { onEnter: 'blocked' } },
    cancel: { kind: 'terminal', state: 'cancelled' },
  },
}
