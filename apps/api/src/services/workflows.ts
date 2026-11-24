import { parsePluginBlockAnswer, RetryLaterError } from '@factorix/connectors'
import { FAILED_HANDLE, planWorkflow, type StepState, triggerMatches, type WorkflowEvent, waitMatches } from '@factorix/core'
import {
  type Db,
  type IssueRow,
  json,
  type ProjectRow,
  type RunRow,
  type WorkflowRow,
  type WorkflowRunRow,
  type WorkflowScheduleRow,
  type WorkflowStepRow,
} from '@factorix/db'
import { isTriggerBlock, nextScheduleTime, type PluginStepInput, parsePluginBlockType } from '@factorix/schemas'
import type { Knex } from 'knex'
import type { AppDeps } from '../deps'
import { writeAudit } from '../lib/audit'
import { badRequest, conflict, notFound } from '../lib/errors'
import { emit } from '../lib/outbox'
import { requestRunCancel } from './pipeline'
import { pluginBlockOf, runPluginBlockStep } from './plugin-blocks'
import { BLOCK_HANDLERS, type BlockContext, templateValues } from './workflow-blocks'

/** Every limit here exists because a workflow can spend money and create tickets with no person watching. */
export const MAX_AUTOMATIC_RUNS_PER_HOUR = 100
export const MAX_RUNS_PER_TICKET_PER_HOUR = 10
const MAX_STEP_ATTEMPTS = 4
const STALE_QUEUED_MS = 2 * 60_000
const STALE_RUNNING_MS = 10 * 60_000
const AGENT_SETTLED = ['awaiting_merge', 'done', 'failed', 'cancelled']

type Deps = Pick<AppDeps, 'db' | 'secrets' | 'connectors' | 'env' | 'queues'>

function initialStep(node: { id: string; type: string }, firedNodeId: string, event: WorkflowEvent) {
  if (node.id === firedNodeId) {
    const output = event.kind === 'external' ? event.data : event
    return { status: 'succeeded', handle: 'next', output: json(output), startedAt: new Date(), finishedAt: new Date() }
  }
  return { status: isTriggerBlock(node.type) ? 'skipped' : 'pending' }
}

export async function startWorkflowRun(
  db: Db,
  input: {
    workflow: WorkflowRow
    issue: IssueRow | null
    nodeId: string
    event: WorkflowEvent
    startedBy: string | null
    causedBy?: string | null
    eventId?: string
  },
): Promise<WorkflowRunRow | null> {
  const { workflow, issue, nodeId, event, startedBy, eventId } = input
  const definition = workflow.publishedDefinition
  if (!definition) return null
  return db.transaction(async (trx) => {
    const [run] = (await trx('workflow_runs')
      .insert({
        orgId: workflow.orgId,
        workflowId: workflow.id,
        workflowVersion: workflow.publishedVersion,
        issueId: issue?.id ?? null,
        definition: json(definition),
        trigger: json({ nodeId, event }),
        triggerEventId: eventId ?? null,
        startedBy,
        causedBy: input.causedBy ?? startedBy,
      })
      .onConflict()
      .ignore()
      .returning('*')) as WorkflowRunRow[]
    if (!run) return null
    await trx('workflow_steps').insert(
      definition.nodes.map((node) => ({ runId: run.id, nodeId: node.id, block: node.type, ...initialStep(node, nodeId, event) })),
    )
    await writeAudit(trx, {
      orgId: workflow.orgId,
      actorAccountId: startedBy,
      actorKind: startedBy ? 'human' : 'system',
      action: 'workflow.run_started',
      ...(issue ? { targetType: 'issue', targetId: issue.id } : { targetType: 'workflow', targetId: workflow.id }),
      metadata: { workflowId: workflow.id, workflowRunId: run.id, name: workflow.name, version: workflow.publishedVersion, event: event.kind },
    })
    await emit(trx, workflow.orgId, { type: 'workflow.advance', runId: run.id })
    return run
  })
}

async function finishRun(
  trx: Knex.Transaction,
  run: WorkflowRunRow,
  status: 'succeeded' | 'failed' | 'cancelled',
  error: string | null,
  actorAccountId: string | null = null,
) {
  await trx('workflow_runs').where({ id: run.id }).update({ status, error, finishedAt: trx.fn.now() })
  await trx('workflow_steps')
    .where({ runId: run.id })
    .whereIn('status', ['pending', 'queued', 'waiting'])
    .update({ status: 'cancelled', wakeAt: null, finishedAt: trx.fn.now(), updatedAt: trx.fn.now() })
  await writeAudit(trx, {
    orgId: run.orgId,
    actorAccountId,
    actorKind: actorAccountId ? 'human' : 'system',
    action: 'workflow.run_finished',
    ...(run.issueId ? { targetType: 'issue', targetId: run.issueId } : { targetType: 'workflow', targetId: run.workflowId }),
    metadata: { workflowId: run.workflowId, workflowRunId: run.id, status, error },
  })
}

/** Serialized per run by the row lock, so two branches finishing together cannot start the block they join at twice. */
export async function advanceWorkflowRun(db: Db, runId: string): Promise<void> {
  await db.transaction(async (trx) => {
    const run = await trx<WorkflowRunRow>('workflow_runs').where({ id: runId, status: 'running' }).forUpdate().first()
    if (!run) return
    const rows = await trx<WorkflowStepRow>('workflow_steps').where({ runId })
    const steps: Record<string, StepState> = Object.fromEntries(rows.map((row) => [row.nodeId, { status: row.status, handle: row.handle }]))
    const plan = planWorkflow(run.definition, steps)
    if (plan.skip.length > 0) {
      await trx('workflow_steps')
        .where({ runId })
        .whereIn('nodeId', plan.skip)
        .update({ status: 'skipped', finishedAt: trx.fn.now(), updatedAt: trx.fn.now() })
    }
    if (plan.ready.length > 0) {
      await trx('workflow_steps').where({ runId }).whereIn('nodeId', plan.ready).update({ status: 'queued', updatedAt: trx.fn.now() })
      for (const nodeId of plan.ready) await emit(trx, run.orgId, { type: 'workflow.step', runId, nodeId })
    }
    if (plan.outcome === 'failed') {
      const failed = rows.find(
        (row) =>
          row.status === 'failed' &&
          row.handle === FAILED_HANDLE &&
          !run.definition.edges.some((edge) => edge.source === row.nodeId && edge.sourceHandle === FAILED_HANDLE),
      )
      await finishRun(trx, run, 'failed', failed?.error ?? 'A step failed')
    } else if (plan.outcome === 'succeeded') {
      await finishRun(trx, run, 'succeeded', null)
    }
  })
}

async function settleStep(
  db: Db,
  run: Pick<WorkflowRunRow, 'id' | 'orgId'>,
  nodeId: string,
  from: WorkflowStepRow['status'][],
  result: { status: 'succeeded' | 'failed'; handle: string; output?: Record<string, unknown>; error?: string },
): Promise<boolean> {
  return db.transaction(async (trx) => {
    const updated = await trx('workflow_steps')
      .where({ runId: run.id, nodeId })
      .whereIn('status', from)
      .update({
        status: result.status,
        handle: result.handle,
        output: result.output ? json(result.output) : null,
        error: result.error ?? null,
        wakeAt: null,
        finishedAt: trx.fn.now(),
        updatedAt: trx.fn.now(),
      })
    if (updated > 0) await emit(trx, run.orgId, { type: 'workflow.advance', runId: run.id })
    return updated > 0
  })
}

/** The claim makes side effects at-most-once: a crash mid-block fails the step instead of posting to Slack twice. */
export async function executeWorkflowStep(deps: Deps, runId: string, nodeId: string): Promise<void> {
  const { db } = deps
  const [step] = (await db('workflow_steps')
    .where({ runId, nodeId, status: 'queued' })
    .update({ status: 'running', attempts: db.raw('attempts + 1'), startedAt: db.raw('COALESCE(started_at, now())'), updatedAt: db.fn.now() })
    .returning('*')) as WorkflowStepRow[]
  if (!step) return
  const run = await db<WorkflowRunRow>('workflow_runs').where({ id: runId }).first()
  if (!run) return
  if (run.status !== 'running') {
    await db('workflow_steps').where({ runId, nodeId }).update({ status: 'cancelled', finishedAt: db.fn.now(), updatedAt: db.fn.now() })
    return
  }
  const fail = (error: string) => settleStep(db, run, nodeId, ['running'], { status: 'failed', handle: FAILED_HANDLE, error })
  const node = run.definition.nodes.find((item) => item.id === nodeId)
  const handler = node ? (BLOCK_HANDLERS as Record<string, (typeof BLOCK_HANDLERS)['agent.run']>)[node.type] : undefined
  const plugin = node ? parsePluginBlockType(node.type) : null
  if (!node || (!handler && !plugin)) {
    await fail('This block cannot run.')
    return
  }
  try {
    const issue = run.issueId ? await db<IssueRow>('issues').where({ id: run.issueId }).first() : null
    const workflow = await db<WorkflowRow>('workflows').where({ id: run.workflowId }).first()
    // A run with no ticket works in the workflow's project, when it is limited to one.
    const projectId = issue?.projectId ?? workflow?.projectId
    const project = projectId ? ((await db<ProjectRow>('projects').where({ id: projectId }).first()) ?? null) : null
    if ((run.issueId && (!issue || !project)) || !workflow) throw new Error('The ticket or workflow no longer exists.')
    const agent = issue?.assignedAgentId ? await db('accounts').where({ id: issue.assignedAgentId }).first() : null
    const context: BlockContext = {
      deps,
      run,
      nodeId,
      issue: issue ?? null,
      project,
      config: node.config,
      values: await templateValues(deps, run, workflow.name, issue ?? null, project),
    }
    const result = handler
      ? await handler(context, (agent?.handle as string | undefined) ?? null)
      : await runPluginBlockStep(context, node.type, workflow.name)
    if (result.status === 'wait') {
      await db('workflow_steps')
        .where({ runId, nodeId, status: 'running' })
        .update({ status: 'waiting', wakeAt: result.wakeAt ?? null, output: result.output ? json(result.output) : null, updatedAt: db.fn.now() })
      if (node.type === 'agent.run') await settleWaitingAgent(deps, run, nodeId)
      if (node.type === 'agent.prompt') await settlePromptStep(db, run, nodeId)
      return
    }
    await settleStep(db, run, nodeId, ['running'], { status: 'succeeded', handle: result.handle ?? 'next', output: result.output })
  } catch (error) {
    if (error instanceof RetryLaterError && step.attempts < MAX_STEP_ATTEMPTS) {
      await db('workflow_steps').where({ runId, nodeId, status: 'running' }).update({ status: 'queued', updatedAt: db.fn.now() })
      await deps.queues.workflows.add('step', { runId, nodeId }, { delay: error.retryAfterMs })
      return
    }
    await fail((error as Error).message)
  }
}

function agentHandle(factoryState: string): { handle: string; status: 'succeeded' | 'failed'; result: string } {
  return ['awaiting_merge', 'done'].includes(factoryState)
    ? { status: 'succeeded', handle: 'next', result: 'succeeded' }
    : { status: 'failed', handle: FAILED_HANDLE, result: factoryState }
}

/** An agent that fails to start at all can finish before the step is even marked as waiting, and that event would be missed. */
async function settleWaitingAgent(deps: Pick<AppDeps, 'db'>, run: Pick<WorkflowRunRow, 'id' | 'orgId' | 'issueId'>, nodeId: string): Promise<void> {
  if (!run.issueId) return
  const issue = await deps.db<IssueRow>('issues').where({ id: run.issueId }).first()
  if (!issue || !AGENT_SETTLED.includes(issue.factoryState)) return
  const { status, handle, result } = agentHandle(issue.factoryState)
  await settleStep(deps.db, run, nodeId, ['waiting'], {
    status,
    handle,
    output: { result },
    error: status === 'failed' ? `The agent ended as ${result}.` : undefined,
  })
}

/** Continues a prompt block once its run has ended. Safe to call at any time, from the run's end, right after the wait starts, and the sweep. */
export async function settlePromptStep(db: Db, run: Pick<WorkflowRunRow, 'id' | 'orgId'>, nodeId: string): Promise<void> {
  const step = await db<WorkflowStepRow>('workflow_steps').where({ runId: run.id, nodeId, status: 'waiting' }).first()
  const runId = step?.output?.runId
  if (typeof runId !== 'string') return
  const asked = await db<RunRow>('runs').where({ id: runId }).first()
  if (asked && !['succeeded', 'failed', 'cancelled'].includes(asked.state)) return
  const answered = asked?.state === 'succeeded'
  const text = (asked?.structuredOutput as { summary?: string } | null)?.summary ?? asked?.summary ?? ''
  await settleStep(db, run, nodeId, ['waiting'], {
    status: answered ? 'succeeded' : 'failed',
    handle: answered ? 'next' : FAILED_HANDLE,
    output: { ...step?.output, text },
    error: answered ? undefined : (asked?.error?.message ?? `The agent's run ended as ${asked?.state ?? 'missing'}.`),
  })
}

export async function handleWorkflowEvent(
  deps: Pick<AppDeps, 'db'>,
  input: { issueId: string; event: WorkflowEvent; eventId?: string; by?: string | null },
): Promise<void> {
  const { db } = deps
  const { event, eventId } = input
  const issue = await db<IssueRow>('issues').where({ id: input.issueId }).first()
  if (!issue) return

  // Starting comes first. A run waiting on this very event is still active here, so the unique index stops it from re-triggering itself.
  const workflows = await db<WorkflowRow>('workflows')
    .where({ orgId: issue.orgId, enabled: true })
    .whereNull('archivedAt')
    .where((query) => query.whereNull('projectId').orWhere({ projectId: issue.projectId }))
  for (const workflow of workflows) {
    const fired = workflow.publishedDefinition?.nodes.find((node) => isTriggerBlock(node.type) && triggerMatches(node, event))
    if (!fired || !(await withinRunLimits(db, workflow, issue))) continue
    await startWorkflowRun(db, { workflow, issue, nodeId: fired.id, event, startedBy: null, causedBy: input.by, eventId })
  }

  const waiting = (await db('workflow_steps')
    .join('workflow_runs', 'workflow_steps.run_id', 'workflow_runs.id')
    .where({ 'workflow_runs.issue_id': issue.id, 'workflow_runs.status': 'running', 'workflow_steps.status': 'waiting' })
    .select('workflow_steps.node_id', 'workflow_steps.block', 'workflow_runs.id', 'workflow_runs.org_id', 'workflow_runs.definition')) as (Pick<
    WorkflowRunRow,
    'id' | 'orgId' | 'definition'
  > & { nodeId: string; block: string })[]
  for (const step of waiting) {
    if (step.block === 'agent.run' && event.kind === 'agent.finished') {
      const failed = event.result !== 'succeeded'
      await settleStep(db, step, step.nodeId, ['waiting'], {
        status: failed ? 'failed' : 'succeeded',
        handle: failed ? FAILED_HANDLE : 'next',
        output: { result: event.result },
        error: failed ? `The agent ended as ${event.result}.` : undefined,
      })
    } else if (step.block === 'logic.wait_for') {
      const config = step.definition.nodes.find((node) => node.id === step.nodeId)?.config ?? {}
      if (waitMatches(config, event))
        await settleStep(db, step, step.nodeId, ['waiting'], { status: 'succeeded', handle: 'next', output: { ...event } })
    }
  }
}

async function withinRunLimits(db: Db, workflow: WorkflowRow, issue: IssueRow | null): Promise<boolean> {
  const recent = db('workflow_runs')
    .where({ workflowId: workflow.id })
    .whereNull('startedBy')
    .andWhere('created_at', '>', db.raw(`now() - interval '1 hour'`))
  const [{ total, onTicket }] = (await recent.select(
    db.raw('COUNT(*)::int AS total'),
    db.raw('COUNT(*) FILTER (WHERE issue_id = ?)::int AS on_ticket', [issue?.id ?? null]),
  )) as { total: number; onTicket: number }[] as [{ total: number; onTicket: number }]
  if (total < MAX_AUTOMATIC_RUNS_PER_HOUR && onTicket < MAX_RUNS_PER_TICKET_PER_HOUR) return true
  await writeAudit(db, {
    orgId: workflow.orgId,
    actorKind: 'system',
    action: 'workflow.throttled',
    ...(issue ? { targetType: 'issue', targetId: issue.id } : { targetType: 'workflow', targetId: workflow.id }),
    metadata: { workflowId: workflow.id, name: workflow.name, runsThisHour: total, runsOnTicket: onTicket },
  })
  return false
}

/**
 * Starts the workflows that a trigger from outside the tracker fires, with no ticket. The event id makes a repeated
 * delivery start each workflow once.
 */
export async function fireTrigger(
  deps: Pick<AppDeps, 'db'>,
  input: { orgId: string; type: string; data: Record<string, string>; eventId: string; filters?: string[] },
): Promise<number> {
  const { db } = deps
  const event: WorkflowEvent = { kind: 'external', type: input.type, data: input.data, ...(input.filters ? { filters: input.filters } : {}) }
  const workflows = await db<WorkflowRow>('workflows')
    .where({ orgId: input.orgId, enabled: true })
    .whereNull('archivedAt')
    .whereRaw('published_definition::text LIKE ?', [`%"${input.type}"%`])
  let started = 0
  for (const workflow of workflows) {
    const fired = workflow.publishedDefinition?.nodes.find((node) => triggerMatches(node, event))
    if (!fired || !(await withinRunLimits(db, workflow, null))) continue
    if (await startWorkflowRun(db, { workflow, issue: null, nodeId: fired.id, event, startedBy: null, eventId: input.eventId })) started++
  }
  return started
}

async function scheduleSkipped(db: Db, workflow: WorkflowRow, reason: string): Promise<void> {
  await writeAudit(db, {
    orgId: workflow.orgId,
    actorKind: 'system',
    action: 'workflow.schedule_skipped',
    targetType: 'workflow',
    targetId: workflow.id,
    metadata: { name: workflow.name, reason },
  })
}

/**
 * Fires every "On a schedule" block that is due. A time missed while no worker ran fires once, late, and a workflow
 * turned off and on again starts from its next time, because turning it off drops its rows here.
 */
export async function fireSchedules(deps: Pick<AppDeps, 'db'>, now = new Date()): Promise<void> {
  const { db } = deps
  const workflows = await db<WorkflowRow>('workflows')
    .where({ enabled: true })
    .whereNull('archivedAt')
    .whereRaw(`published_definition::text LIKE '%"trigger.schedule"%'`)
  await db('workflow_schedules')
    .whereNotIn(
      'workflowId',
      workflows.map((workflow) => workflow.id),
    )
    .delete()
  for (const workflow of workflows) {
    const nodes = (workflow.publishedDefinition?.nodes ?? []).filter((node) => node.type === 'trigger.schedule')
    const rows = await db<WorkflowScheduleRow>('workflow_schedules').where({ workflowId: workflow.id })
    for (const row of rows) {
      const node = nodes.find((item) => item.id === row.nodeId)
      const next = node ? nextScheduleTime(node.config, now) : null
      if (!node || !next) {
        await db('workflow_schedules').where({ workflowId: workflow.id, nodeId: row.nodeId }).delete()
        continue
      }
      const due = row.workflowVersion === workflow.publishedVersion && row.nextAt.getTime() <= now.getTime()
      if (!due && row.workflowVersion === workflow.publishedVersion) continue
      const claimed = await db('workflow_schedules')
        .where({ workflowId: workflow.id, nodeId: row.nodeId, nextAt: row.nextAt, workflowVersion: row.workflowVersion })
        .update({ nextAt: next, workflowVersion: workflow.publishedVersion })
      if (!due || claimed === 0) continue
      const issue = await db<IssueRow>('issues')
        .where({ orgId: workflow.orgId })
        .where((query) => (workflow.projectId ? query.where({ projectId: workflow.projectId }) : query))
        .whereRaw('lower(identifier) = lower(?)', [String(node.config.issue ?? '').trim()])
        .first()
      if (!issue) {
        await scheduleSkipped(db, workflow, `There is no ticket ${String(node.config.issue ?? '')}`)
        continue
      }
      if (!(await withinRunLimits(db, workflow, issue))) continue
      const scheduledFor = row.nextAt.toISOString()
      const run = await startWorkflowRun(db, {
        workflow,
        issue,
        nodeId: node.id,
        event: { kind: 'schedule', scheduledFor },
        startedBy: null,
        eventId: `schedule:${node.id}:${scheduledFor}`,
      })
      if (!run) await scheduleSkipped(db, workflow, 'The run before it is still going')
    }
    for (const node of nodes) {
      const next = rows.some((row) => row.nodeId === node.id) ? null : nextScheduleTime(node.config, now)
      if (!next) continue
      await db('workflow_schedules')
        .insert({ workflowId: workflow.id, nodeId: node.id, orgId: workflow.orgId, workflowVersion: workflow.publishedVersion, nextAt: next })
        .onConflict()
        .ignore()
    }
  }
}

/** Timers live in the database and this sweep reads them, so a Redis flush or a worker restart cannot lose a wait. */
export async function sweepWorkflows(deps: Pick<AppDeps, 'db' | 'queues'>): Promise<void> {
  const { db } = deps
  await fireSchedules(deps)
  const active = () =>
    db('workflow_steps').join('workflow_runs', 'workflow_steps.run_id', 'workflow_runs.id').where({ 'workflow_runs.status': 'running' })
  const columns = ['workflow_steps.node_id', 'workflow_steps.block', 'workflow_runs.id', 'workflow_runs.org_id', 'workflow_runs.issue_id'] as const

  const due = (await active()
    .where({ 'workflow_steps.status': 'waiting' })
    .where('workflow_steps.wake_at', '<=', db.fn.now())
    .select(...columns)) as StepOfRun[]
  for (const step of due) {
    if (parsePluginBlockType(step.block)) {
      await settleStep(db, step, step.nodeId, ['waiting'], {
        status: 'failed',
        handle: FAILED_HANDLE,
        error: 'The plugin never said how this step ended.',
      })
    } else {
      await settleStep(db, step, step.nodeId, ['waiting'], { status: 'succeeded', handle: step.block === 'logic.wait_for' ? 'timeout' : 'next' })
    }
  }

  const agents = (await active()
    .where({ 'workflow_steps.status': 'waiting', 'workflow_steps.block': 'agent.run' })
    .select(...columns)) as StepOfRun[]
  for (const step of agents) await settleWaitingAgent(deps, { id: step.id, orgId: step.orgId, issueId: step.issueId }, step.nodeId)

  const prompts = (await active()
    .where({ 'workflow_steps.status': 'waiting', 'workflow_steps.block': 'agent.prompt' })
    .select(...columns)) as StepOfRun[]
  for (const step of prompts) await settlePromptStep(db, step, step.nodeId)

  const lost = (await active()
    .where({ 'workflow_steps.status': 'queued' })
    .where('workflow_steps.updated_at', '<', new Date(Date.now() - STALE_QUEUED_MS))
    .select(...columns)) as StepOfRun[]
  for (const step of lost) await deps.queues.workflows.add('step', { runId: step.id, nodeId: step.nodeId })

  const interrupted = (await active()
    .where({ 'workflow_steps.status': 'running' })
    .where('workflow_steps.updated_at', '<', new Date(Date.now() - STALE_RUNNING_MS))
    .select(...columns)) as StepOfRun[]
  for (const step of interrupted) {
    await settleStep(db, step, step.nodeId, ['running'], {
      status: 'failed',
      handle: FAILED_HANDLE,
      error: 'The worker stopped during this step. It was not retried, in case it had already taken effect.',
    })
  }
}

type StepOfRun = { id: string; orgId: string; issueId: string | null; nodeId: string; block: string }

/**
 * A plugin reporting a step of its own block that it held. It reaches only steps of its blocks, in organizations that
 * turned it on. A step still `running` counts too, since the plugin may report before its answer to the call is stored.
 */
export async function finishPluginStep(db: Db, pluginId: string, orgId: string, input: PluginStepInput): Promise<void> {
  const run = await db<WorkflowRunRow>('workflow_runs').where({ id: input.runId, orgId }).first()
  const step = run ? await db<WorkflowStepRow>('workflow_steps').where({ runId: run.id, nodeId: input.nodeId }).first() : undefined
  if (!run || !step || parsePluginBlockType(step.block)?.pluginId !== pluginId) throw notFound('Workflow step')
  let result: Parameters<typeof settleStep>[4]
  if (input.error) {
    result = { status: 'failed', handle: FAILED_HANDLE, output: step.output ?? undefined, error: input.error }
  } else {
    const block = await pluginBlockOf(db, orgId, step.block)
    if (!block) throw notFound('Block')
    let answer: ReturnType<typeof parsePluginBlockAnswer>
    try {
      answer = parsePluginBlockAnswer(block, { handle: input.handle, output: input.output })
    } catch (error) {
      throw badRequest((error as Error).message)
    }
    result = { status: 'succeeded', handle: answer.handle ?? 'next', output: { ...step.output, ...answer.output } }
  }
  if (!(await settleStep(db, run, step.nodeId, ['running', 'waiting'], result))) throw conflict('That step is not waiting for the plugin')
}

export async function cancelWorkflowRun(db: Db, run: WorkflowRunRow, accountId: string): Promise<void> {
  await db.transaction(async (trx) => {
    const locked = await trx<WorkflowRunRow>('workflow_runs').where({ id: run.id, status: 'running' }).forUpdate().first()
    if (!locked) return
    const asking = await trx<WorkflowStepRow>('workflow_steps').where({ runId: run.id, block: 'agent.prompt', status: 'waiting' })
    for (const step of asking) {
      const runId = step.output?.runId
      if (typeof runId === 'string') await requestRunCancel(trx, runId, 'The workflow run was cancelled', { by: accountId })
    }
    await finishRun(trx, locked, 'cancelled', null, accountId)
  })
}
