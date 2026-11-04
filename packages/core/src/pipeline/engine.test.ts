import { describe, expect, it } from 'vitest'
import { BUILTIN_PIPELINE } from './builtin'
import { advance, PipelineError, validatePipeline } from './engine'
import type { Autonomy, PipelineCursor, PipelineDefinition, PipelineEvent } from './types'

const now = '2026-11-03T00:00:00.000Z'

function drive(autonomy: Autonomy, events: PipelineEvent[]) {
  let cursor: PipelineCursor | null = null
  const trail: string[] = []
  let last = advance(BUILTIN_PIPELINE, null, { autonomy, now }, { type: 'start' })
  cursor = last.cursor
  trail.push(cursor?.step ?? '')
  for (const event of events) {
    last = advance(BUILTIN_PIPELINE, cursor, { autonomy, now }, event)
    cursor = last.cursor
    trail.push(cursor?.step ?? '')
  }
  return { trail, last, cursor }
}

const finished = (result: string, retryable = false): PipelineEvent => ({ type: 'run.finished', result, retryable })

describe('agents outside the pipeline', () => {
  const context = { autonomy: 'human_merge' as const, now, assignedRole: 'other' }
  const start = () => advance(BUILTIN_PIPELINE, null, context, { type: 'start' })
  const trackerMoves = (actions: { type: string }[]) => actions.filter((action) => action.type === 'setTrackerState')

  it('starts on their own step, even when the project plans first', () => {
    for (const autonomy of ['plan_first', 'human_merge', 'full_auto'] as const) {
      const { cursor, actions, factoryState } = advance(BUILTIN_PIPELINE, null, { ...context, autonomy }, { type: 'start' })
      expect(cursor?.step).toBe('task')
      expect(factoryState).toBe('active')
      expect(actions).toContainEqual({ type: 'enqueueRun', role: 'other', phase: 'task', step: 'task', attempt: 1 })
      expect(trackerMoves(actions)).toEqual([])
    }
  })

  it('finishes without moving the ticket in the tracker', () => {
    const { cursor, actions, factoryState } = advance(BUILTIN_PIPELINE, start().cursor, context, finished('completed'))
    expect(cursor?.step).toBe('task_done')
    expect(factoryState).toBe('done')
    expect(actions.filter((action) => action.type === 'enqueueRun')).toEqual([])
    expect(trackerMoves(actions)).toEqual([])
  })

  it('retries once, then fails without blocking the ticket in the tracker', () => {
    const retried = advance(BUILTIN_PIPELINE, start().cursor, context, finished('failed', true))
    expect(retried.actions).toContainEqual({ type: 'enqueueRun', role: 'other', phase: 'task', step: 'task', attempt: 2 })
    const failed = advance(BUILTIN_PIPELINE, retried.cursor, context, finished('failed', true))
    expect(failed.cursor?.step).toBe('task_failed')
    expect(failed.factoryState).toBe('failed')
    expect(failed.actions).toContainEqual({ type: 'postComment', template: 'run_failed', step: 'task' })
    expect(trackerMoves(failed.actions)).toEqual([])
  })

  it('leaves the other roles on the normal path', () => {
    for (const assignedRole of ['engineer', 'reviewer', undefined]) {
      expect(advance(BUILTIN_PIPELINE, null, { ...context, assignedRole }, { type: 'start' }).cursor?.step).toBe('implement')
    }
  })

  it('flags a role path that points nowhere', () => {
    expect(validatePipeline({ ...BUILTIN_PIPELINE, entryByRole: { other: 'nowhere' } })).toEqual(['entryByRole points at unknown step nowhere'])
  })
})

describe('builtin pipeline', () => {
  it('is structurally valid', () => {
    expect(validatePipeline(BUILTIN_PIPELINE)).toEqual([])
  })

  it('skips planning unless the project is plan_first', () => {
    const { last, cursor } = drive('human_merge', [])
    expect(cursor?.step).toBe('implement')
    expect(last.factoryState).toBe('active')
    expect(last.actions).toContainEqual({ type: 'enqueueRun', role: 'engineer', phase: 'implement', step: 'implement', attempt: 1 })
  })

  it('runs the full plan_first loop down to a human merge', () => {
    const { trail, last } = drive('plan_first', [
      finished('completed'),
      { type: 'approval.decided', decision: 'approved' },
      finished('completed'),
      { type: 'ci.settled' },
      finished('verdict:request_changes'),
      finished('completed'),
      { type: 'ci.settled' },
      finished('verdict:approve'),
      { type: 'external', name: 'mr.merged' },
    ])
    expect(trail).toEqual(['plan', 'approve_plan', 'implement', 'review', 'review', 'address', 'review', 'review', 'await_merge', 'done'])
    expect(last.factoryState).toBe('done')
  })

  it('holds the review run until CI settles', () => {
    const { last, cursor } = drive('human_merge', [finished('completed')])
    expect(cursor?.waitingFor).toBe('ci')
    expect(last.actions).toContainEqual({ type: 'waitForCi' })
    expect(last.actions.some((a) => a.type === 'enqueueRun')).toBe(false)
    const after = advance(BUILTIN_PIPELINE, cursor, { autonomy: 'human_merge', now }, { type: 'ci.settled' })
    expect(after.actions).toContainEqual({ type: 'enqueueRun', role: 'reviewer', phase: 'review', step: 'review', attempt: 1 })
    expect(after.cursor?.waitingFor).toBeNull()
  })

  it('auto-merges under full_auto without creating a merge gate', () => {
    const { trail, last } = drive('full_auto', [finished('completed'), { type: 'ci.settled' }, finished('verdict:approve')])
    expect(trail.at(-1)).toBe('auto_merge')
    expect(last.actions).toContainEqual({ type: 'scmMerge' })
    expect(last.actions.some((a) => a.type === 'createApproval')).toBe(false)
  })

  it('parks a failed auto-merge at a gate instead of looping', () => {
    const { last, cursor } = drive('full_auto', [
      finished('completed'),
      { type: 'ci.settled' },
      finished('verdict:approve'),
      { type: 'action.result', result: 'failed' },
    ])
    expect(cursor?.step).toBe('merge_blocked')
    expect(last.factoryState).toBe('awaiting_merge')
    expect(last.actions).toContainEqual({ type: 'postComment', template: 'merge_blocked', step: 'auto_merge' })
  })

  it('stops the review ping-pong after maxLoops and hands over to a human', () => {
    const round: PipelineEvent[] = [{ type: 'ci.settled' }, finished('verdict:request_changes'), finished('completed')]
    const { cursor, last } = drive('human_merge', [finished('completed'), ...round, ...round, ...round])
    expect(cursor?.step).toBe('await_merge')
    expect(last.actions).toContainEqual({ type: 'postComment', template: 'loops_exceeded', step: 'review' })
  })

  it('retries a retryable failure before routing to fail', () => {
    const first = drive('human_merge', [finished('failed', true)])
    expect(first.cursor?.step).toBe('implement')
    expect(first.last.actions).toContainEqual({ type: 'enqueueRun', role: 'engineer', phase: 'implement', step: 'implement', attempt: 2 })
    const second = drive('human_merge', [finished('failed', true), finished('failed', true)])
    expect(second.cursor?.step).toBe('fail')
    expect(second.last.factoryState).toBe('failed')
    expect(second.last.actions).toContainEqual({ type: 'setTrackerState', key: 'blocked' })
  })

  it('does not retry a non-retryable failure', () => {
    expect(drive('human_merge', [finished('failed', false)]).cursor?.step).toBe('fail')
  })

  it('routes an implement run without changes to fail', () => {
    expect(drive('human_merge', [finished('no_changes')]).cursor?.step).toBe('fail')
  })

  it('sends a human MR note at the merge gate back to the engineer', () => {
    const { cursor, last } = drive('human_merge', [
      finished('completed'),
      { type: 'ci.settled' },
      finished('verdict:approve'),
      { type: 'external', name: 'mr.note.human' },
    ])
    expect(cursor?.step).toBe('address')
    expect(last.actions).toContainEqual({ type: 'enqueueRun', role: 'engineer', phase: 'address_review', step: 'address', attempt: 1 })
  })

  it('cancels the active run when the MR is merged during a review', () => {
    const { last, cursor } = drive('human_merge', [finished('completed'), { type: 'ci.settled' }, { type: 'external', name: 'mr.merged' }])
    expect(cursor?.step).toBe('done')
    expect(last.actions).toContainEqual({ type: 'cancelActiveRun' })
  })

  it('does not cancel anything when the MR merges while only waiting for CI', () => {
    const { last } = drive('human_merge', [finished('completed'), { type: 'external', name: 'mr.merged' }])
    expect(last.actions.some((a) => a.type === 'cancelActiveRun')).toBe(false)
  })

  it('cancels from any live step and ignores cancel once terminal', () => {
    const live = drive('plan_first', [{ type: 'cancel' }])
    expect(live.cursor?.step).toBe('cancel')
    expect(live.last.factoryState).toBe('cancelled')
    expect(live.last.actions).toContainEqual({ type: 'cancelActiveRun' })
    const again = advance(BUILTIN_PIPELINE, live.cursor, { autonomy: 'plan_first', now }, { type: 'cancel' })
    expect(again.handled).toBe(false)
  })

  it('ignores events the current step does not handle', () => {
    const { cursor } = drive('human_merge', [])
    const result = advance(BUILTIN_PIPELINE, cursor, { autonomy: 'human_merge', now }, { type: 'approval.decided', decision: 'approved' })
    expect(result.handled).toBe(false)
    expect(result.actions).toEqual([])
    expect(result.cursor).toBe(cursor)
  })

  it('can restart from a terminal step', () => {
    const { cursor } = drive('human_merge', [finished('failed')])
    const restarted = advance(BUILTIN_PIPELINE, cursor, { autonomy: 'human_merge', now }, { type: 'start' })
    expect(restarted.cursor?.step).toBe('implement')
    expect(restarted.cursor?.loops).toEqual({ implement: 1 })
  })

  it('does not mutate the cursor it was given', () => {
    const { cursor } = drive('human_merge', [])
    const snapshot = structuredClone(cursor)
    advance(BUILTIN_PIPELINE, cursor, { autonomy: 'human_merge', now }, finished('failed', true))
    expect(cursor).toEqual(snapshot)
  })
})

describe('validatePipeline and cycles', () => {
  it('reports dangling targets and missing cancel terminal', () => {
    const broken: PipelineDefinition = {
      version: 1,
      entry: 'a',
      steps: { a: { kind: 'gate', approval: 'plan', on: { approved: 'nope' } } },
    }
    const problems = validatePipeline(broken)
    expect(problems).toContain('a points at unknown step nope')
    expect(problems).toContain('a terminal step with state cancelled is required')
  })

  it('throws instead of hanging on a conditional cycle', () => {
    const cyclic: PipelineDefinition = {
      version: 1,
      entry: 'a',
      steps: {
        a: { kind: 'gate', approval: 'merge', if: { autonomy: ['plan_first'] }, else: 'b', on: {} },
        b: { kind: 'gate', approval: 'merge', if: { autonomy: ['plan_first'] }, else: 'a', on: {} },
        cancel: { kind: 'terminal', state: 'cancelled' },
      },
    }
    expect(() => advance(cyclic, null, { autonomy: 'full_auto', now }, { type: 'start' })).toThrow(PipelineError)
  })
})
