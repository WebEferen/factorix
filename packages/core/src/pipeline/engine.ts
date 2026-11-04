import type { FactoryState } from '../state/issue'
import type { AdvanceContext, AdvanceResult, PipelineAction, PipelineCursor, PipelineDefinition, PipelineEvent, PipelineStep } from './types'

const MAX_HOPS = 16

export class PipelineError extends Error {}

export function validatePipeline(definition: PipelineDefinition): string[] {
  const problems: string[] = []
  const steps = definition.steps
  const check = (from: string, target: string | undefined) => {
    if (target !== undefined && !steps[target]) problems.push(`${from} points at unknown step ${target}`)
  }
  if (!steps[definition.entry]) problems.push(`entry step ${definition.entry} does not exist`)
  for (const target of Object.values(definition.entryByRole ?? {})) check('entryByRole', target)
  if (!Object.values(steps).some((step) => step.kind === 'terminal' && step.state === 'cancelled')) {
    problems.push('a terminal step with state cancelled is required')
  }
  for (const [name, step] of Object.entries(steps)) {
    if (step.kind === 'terminal') continue
    check(name, step.else)
    if (step.if && !step.else) problems.push(`${name} has a condition without an else target`)
    for (const target of Object.values(step.on ?? {})) check(name, target)
    if (step.kind === 'run') {
      for (const target of Object.values(step.onDone)) check(name, target)
      check(name, step.onLoopsExceeded)
      if (step.maxLoops !== undefined && !step.onLoopsExceeded) problems.push(`${name} has maxLoops without onLoopsExceeded`)
    }
  }
  return problems
}

function factoryStateFor(step: PipelineStep): FactoryState {
  if (step.kind === 'terminal') return step.state
  if (step.kind === 'gate') return step.approval === 'plan' ? 'waiting_human' : 'awaiting_merge'
  return 'active'
}

export function advance(
  definition: PipelineDefinition,
  cursorIn: PipelineCursor | null,
  context: AdvanceContext,
  event: PipelineEvent,
): AdvanceResult {
  const actions: PipelineAction[] = []
  let cursor: PipelineCursor | null = cursorIn ? { ...cursorIn, loops: { ...cursorIn.loops }, attempts: { ...cursorIn.attempts } } : null
  let factoryState: FactoryState | null = null

  const enter = (name: string, hops = 0): void => {
    if (hops > MAX_HOPS) throw new PipelineError(`pipeline did not settle after ${MAX_HOPS} hops, last step ${name}`)
    const step = definition.steps[name]
    if (!step) throw new PipelineError(`unknown pipeline step ${name}`)
    if (step.kind !== 'terminal' && step.if && !step.if.autonomy.includes(context.autonomy)) {
      if (!step.else) throw new PipelineError(`step ${name} has no else target`)
      enter(step.else, hops + 1)
      return
    }
    if (!cursor) throw new PipelineError('cursor missing while entering a step')

    if (step.kind === 'run') {
      const loops = (cursor.loops[name] ?? 0) + 1
      cursor.loops[name] = loops
      if (step.maxLoops !== undefined && loops > step.maxLoops) {
        actions.push({ type: 'postComment', template: 'loops_exceeded', step: name })
        enter(step.onLoopsExceeded ?? 'fail', hops + 1)
        return
      }
    }

    cursor.step = name
    cursor.enteredAt = context.now
    cursor.waitingFor = null
    if (step.tracker?.onEnter) actions.push({ type: 'setTrackerState', key: step.tracker.onEnter })
    factoryState = factoryStateFor(step)

    switch (step.kind) {
      case 'run':
        cursor.attempts[name] = 1
        if (step.waitFor?.includes('ci')) {
          cursor.waitingFor = 'ci'
          actions.push({ type: 'waitForCi' })
        } else {
          actions.push({ type: 'enqueueRun', role: step.role, phase: step.phase, step: name, attempt: 1 })
        }
        return
      case 'gate':
        actions.push({ type: 'createApproval', kind: step.approval, timeoutMinutes: step.timeoutMinutes })
        return
      case 'action':
        actions.push({ type: 'scmMerge' })
        return
      case 'terminal':
        return
    }
  }

  const leaveTo = (target: string): void => {
    actions.push({ type: 'closePendingApprovals' })
    enter(target)
  }

  const noop = (): AdvanceResult => ({ cursor: cursorIn, actions: [], factoryState: null, handled: false })

  if (event.type === 'start') {
    const entry = definition.entryByRole?.[context.assignedRole ?? ''] ?? definition.entry
    cursor = { step: entry, enteredAt: context.now, loops: {}, attempts: {}, waitingFor: null }
    actions.push({ type: 'closePendingApprovals' })
    enter(entry)
    return { cursor, actions, factoryState, handled: true }
  }

  if (!cursor) return noop()
  const current = definition.steps[cursor.step]
  if (!current) throw new PipelineError(`cursor points at unknown step ${cursor.step}`)

  if (event.type === 'cancel') {
    if (current.kind === 'terminal') return noop()
    const cancel = Object.entries(definition.steps).find(([, step]) => step.kind === 'terminal' && step.state === 'cancelled')
    if (!cancel) throw new PipelineError('pipeline has no cancelled terminal step')
    actions.push({ type: 'cancelActiveRun' })
    leaveTo(cancel[0])
    return { cursor, actions, factoryState, handled: true }
  }

  if (current.kind === 'terminal') return noop()

  switch (event.type) {
    case 'run.finished': {
      if (current.kind !== 'run' || cursor.waitingFor !== null) return noop()
      const attempts = cursor.attempts[cursor.step] ?? 1
      if (event.result === 'failed' && event.retryable && attempts < (current.maxAttempts ?? 1)) {
        cursor.attempts[cursor.step] = attempts + 1
        actions.push({ type: 'enqueueRun', role: current.role, phase: current.phase, step: cursor.step, attempt: attempts + 1 })
        return { cursor, actions, factoryState: 'active', handled: true }
      }
      const target = current.onDone[event.result] ?? current.onDone.failed
      if (!target) throw new PipelineError(`step ${cursor.step} has no route for result ${event.result}`)
      if (event.result === 'failed') actions.push({ type: 'postComment', template: 'run_failed', step: cursor.step })
      leaveTo(target)
      return { cursor, actions, factoryState, handled: true }
    }
    case 'ci.settled': {
      if (current.kind !== 'run' || cursor.waitingFor !== 'ci') return noop()
      cursor.waitingFor = null
      actions.push({
        type: 'enqueueRun',
        role: current.role,
        phase: current.phase,
        step: cursor.step,
        attempt: cursor.attempts[cursor.step] ?? 1,
      })
      return { cursor, actions, factoryState: 'active', handled: true }
    }
    case 'approval.decided': {
      if (current.kind !== 'gate') return noop()
      const target = current.on[event.decision]
      if (!target) return noop()
      leaveTo(target)
      return { cursor, actions, factoryState, handled: true }
    }
    case 'external': {
      const target = current.on?.[event.name]
      if (!target) return noop()
      if (current.kind === 'run' && cursor.waitingFor === null) actions.push({ type: 'cancelActiveRun' })
      leaveTo(target)
      return { cursor, actions, factoryState, handled: true }
    }
    case 'action.result': {
      if (current.kind !== 'action') return noop()
      const target = current.on[event.result]
      if (!target) return noop()
      if (event.result === 'failed') actions.push({ type: 'postComment', template: 'merge_blocked', step: cursor.step })
      leaveTo(target)
      return { cursor, actions, factoryState, handled: true }
    }
  }
}
