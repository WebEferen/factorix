import { RetryLaterError } from '@factorix/connectors'
import { FAILED_HANDLE, planWorkflow, type StepState, triggerMatches, type WorkflowEvent, waitMatches } from '@factorix/core'
import { type Db, type IssueRow, json, type ProjectRow, type WorkflowRow, type WorkflowRunRow, type WorkflowStepRow } from '@factorix/db'
import { isTriggerBlock } from '@factorix/schemas'
import type { Knex } from 'knex'
import type { AppDeps } from '../deps'
import { writeAudit } from '../lib/audit'
import { emit } from '../lib/outbox'
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
    return { status: 'succeeded', handle: 'next', output: json(event), startedAt: new Date(), finishedAt: new Date() }
  }
  return { status: isTriggerBlock(node.type) ? 'skipped' : 'pending' }
}

export async function startWorkflowRun(
  db: Db,
  input: { workflow: WorkflowRow; issue: IssueRow; nodeId: string; event: WorkflowEvent; startedBy: string | null; eventId?: string },
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
        issueId: issue.id,
        definition: json(definition),
        trigger: json({ nodeId, event }),
        triggerEventId: eventId ?? null,
        startedBy,
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
      targetType: 'issue',
      targetId: issue.id,
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
    targetType: 'issue',
    targetId: run.issueId,
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
  if (!node || !handler) {
    await fail('This block cannot run.')
    return
  }
  try {
    const issue = await db<IssueRow>('issues').where({ id: run.issueId }).first()
    const project = issue ? await db<ProjectRow>('projects').where({ id: issue.projectId }).first() : undefined
    const workflow = await db<WorkflowRow>('workflows').where({ id: run.workflowId }).first()
    if (!issue || !project || !workflow) throw new Error('The ticket or workflow no longer exists.')
    const agent = issue.assignedAgentId ? await db('accounts').where({ id: issue.assignedAgentId }).first() : null
    const context: BlockContext = {
      deps,
      run,
      issue,
      project,
      config: node.config,
      values: await templateValues(deps, run, workflow.name, issue, project),
    }
    const result = await handler(context, (agent?.handle as string | undefined) ?? null)
    if (result.status === 'wait') {
      await db('workflow_steps')
        .where({ runId, nodeId, status: 'running' })
        .update({ status: 'waiting', wakeAt: result.wakeAt ?? null, updatedAt: db.fn.now() })
      if (node.type === 'agent.run') await settleWaitingAgent(deps, run, nodeId)
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

export async function handleWorkflowEvent(
  deps: Pick<AppDeps, 'db'>,
  input: { issueId: string; event: WorkflowEvent; eventId?: string },
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
    await startWorkflowRun(db, { workflow, issue, nodeId: fired.id, event, startedBy: null, eventId })
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

async function withinRunLimits(db: Db, workflow: WorkflowRow, issue: IssueRow): Promise<boolean> {
  const recent = db('workflow_runs')
    .where({ workflowId: workflow.id })
    .whereNull('startedBy')
    .andWhere('created_at', '>', db.raw(`now() - interval '1 hour'`))
  const [{ total, onTicket }] = (await recent.select(
    db.raw('COUNT(*)::int AS total'),
    db.raw('COUNT(*) FILTER (WHERE issue_id = ?)::int AS on_ticket', [issue.id]),
  )) as { total: number; onTicket: number }[] as [{ total: number; onTicket: number }]
  if (total < MAX_AUTOMATIC_RUNS_PER_HOUR && onTicket < MAX_RUNS_PER_TICKET_PER_HOUR) return true
  await writeAudit(db, {
    orgId: workflow.orgId,
    actorKind: 'system',
    action: 'workflow.throttled',
    targetType: 'issue',
    targetId: issue.id,
    metadata: { workflowId: workflow.id, name: workflow.name, runsThisHour: total, runsOnTicket: onTicket },
  })
  return false
}

/** Timers live in the database and this sweep reads them, so a Redis flush or a worker restart cannot lose a wait. */
export async function sweepWorkflows(deps: Pick<AppDeps, 'db' | 'queues'>): Promise<void> {
  const { db } = deps
  const active = () =>
    db('workflow_steps').join('workflow_runs', 'workflow_steps.run_id', 'workflow_runs.id').where({ 'workflow_runs.status': 'running' })
  const columns = ['workflow_steps.node_id', 'workflow_steps.block', 'workflow_runs.id', 'workflow_runs.org_id', 'workflow_runs.issue_id'] as const

  const due = (await active()
    .where({ 'workflow_steps.status': 'waiting' })
    .where('workflow_steps.wake_at', '<=', db.fn.now())
    .select(...columns)) as StepOfRun[]
  for (const step of due)
    await settleStep(db, step, step.nodeId, ['waiting'], { status: 'succeeded', handle: step.block === 'logic.wait_for' ? 'timeout' : 'next' })

  const agents = (await active()
    .where({ 'workflow_steps.status': 'waiting', 'workflow_steps.block': 'agent.run' })
    .select(...columns)) as StepOfRun[]
  for (const step of agents) await settleWaitingAgent(deps, { id: step.id, orgId: step.orgId, issueId: step.issueId }, step.nodeId)

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

type StepOfRun = { id: string; orgId: string; issueId: string; nodeId: string; block: string }

export async function cancelWorkflowRun(db: Db, run: WorkflowRunRow, accountId: string): Promise<void> {
  await db.transaction(async (trx) => {
    const locked = await trx<WorkflowRunRow>('workflow_runs').where({ id: run.id, status: 'running' }).forUpdate().first()
    if (locked) await finishRun(trx, locked, 'cancelled', null, accountId)
  })
}
