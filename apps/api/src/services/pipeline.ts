import {
  type AdvanceResult,
  advance,
  agentResultOf,
  canTransitionIssue,
  type PipelineAction,
  type PipelineDefinition,
  type PipelineEvent,
} from '@factorix/core'
import { type AccountRow, type AgentRow, type Db, type IssueRow, json, type PipelineRow, type ProjectRow, type RunRow } from '@factorix/db'
import type { Knex } from 'knex'
import { writeAudit } from '../lib/audit'
import { emit } from '../lib/outbox'
import { agentRole, buildAgentSnapshot } from './agents'
import { mergeRequestsOf } from './repos'

type Trx = Knex.Transaction

/** Serialized per issue by the row lock, so concurrent webhooks and run completions apply in some order, never interleaved. */
export async function advanceIssue(db: Db, issueId: string, event: PipelineEvent): Promise<AdvanceResult | null> {
  return db.transaction(async (trx) => {
    const issue = await trx<IssueRow>('issues').where({ id: issueId }).forUpdate().first()
    if (!issue) return null
    const project = await trx<ProjectRow>('projects').where({ id: issue.projectId }).first()
    if (!project) return null
    const pipeline = await trx<PipelineRow>('pipelines').where({ id: project.pipelineId }).first()
    if (!pipeline) throw new Error(`Project ${project.id} has no pipeline`)

    const assignedRole = event.type === 'start' && issue.assignedAgentId ? await agentRole(trx, issue.assignedAgentId) : undefined
    const result = advance(
      pipeline.definition as PipelineDefinition,
      issue.cursor,
      { autonomy: project.autonomy, now: new Date().toISOString(), assignedRole },
      event,
    )
    if (!result.handled) return result

    const patch: Record<string, unknown> = { cursor: json(result.cursor), updatedAt: trx.fn.now() }
    if (result.factoryState && canTransitionIssue(issue.factoryState, result.factoryState)) {
      patch.factoryState = result.factoryState
      const agentResult = agentResultOf(issue.factoryState, result.factoryState)
      if (agentResult)
        await emit(trx, issue.orgId, { type: 'workflow.event', issueId: issue.id, event: { kind: 'agent.finished', result: agentResult } })
    }
    await trx('issues').where({ id: issue.id }).update(patch)

    await writeAudit(trx, {
      orgId: issue.orgId,
      actorKind: 'system',
      action: 'pipeline.advanced',
      targetType: 'issue',
      targetId: issue.id,
      metadata: {
        event: event.type === 'run.finished' ? `run.finished:${event.result}` : event.type,
        step: result.cursor?.step,
        state: result.factoryState,
      },
    })

    for (const action of result.actions) await applyAction(trx, issue, project, action)
    await emit(trx, issue.orgId, { type: 'notify', kind: 'issue', id: issue.id, projectId: issue.projectId })
    return result
  })
}

async function applyAction(trx: Trx, issue: IssueRow, project: ProjectRow, action: PipelineAction): Promise<void> {
  switch (action.type) {
    case 'enqueueRun':
      await enqueueRun(trx, issue, project, action)
      return
    case 'waitForCi':
      await emit(trx, issue.orgId, { type: 'scm.ci_check', issueId: issue.id })
      return
    case 'createApproval':
      await createGateApproval(trx, issue, action.kind, action.timeoutMinutes)
      return
    case 'closePendingApprovals':
      await trx('approvals')
        .where({ issueId: issue.id, status: 'pending' })
        .whereIn('kind', ['plan', 'merge'])
        .update({ status: 'expired', decidedAt: trx.fn.now() })
      return
    case 'cancelActiveRun':
      if (issue.lockedByRunId) await requestRunCancel(trx, issue.lockedByRunId, 'The issue moved on or was cancelled')
      return
    case 'setTrackerState':
      await emit(trx, issue.orgId, { type: 'tracker.setState', issueId: issue.id, key: action.key })
      return
    case 'postComment':
      await emit(trx, issue.orgId, { type: 'tracker.comment', issueId: issue.id, template: action.template, step: action.step })
      return
    case 'scmMerge':
      await emit(trx, issue.orgId, { type: 'scm.merge', issueId: issue.id })
      return
  }
}

async function resolveAgentForRole(trx: Trx, issue: IssueRow, project: ProjectRow, role: string): Promise<(AgentRow & AccountRow) | null> {
  const load = (where: Record<string, unknown>) =>
    trx('agents')
      .join('accounts', 'agents.account_id', 'accounts.id')
      .join('archetypes', 'agents.archetype_id', 'archetypes.id')
      .where({ 'agents.org_id': issue.orgId, 'accounts.status': 'active', 'archetypes.role': role, ...where })
      .select('agents.*', 'accounts.handle', 'accounts.display_name', 'accounts.status')
      .first()

  if (issue.assignedAgentId) {
    const assigned = await load({ 'agents.account_id': issue.assignedAgentId })
    if (assigned) return assigned
  }
  // These agents are asked for by name, so nobody stands in for one.
  if (role === 'other') return null
  const projectDefault = role === 'engineer' ? project.defaultEngineerAgentId : role === 'reviewer' ? project.defaultReviewerAgentId : null
  if (projectDefault) {
    const agent = await load({ 'agents.account_id': projectDefault })
    if (agent) return agent
  }
  return ((await load({}).orderBy('accounts.created_at')) as (AgentRow & AccountRow) | undefined) ?? null
}

async function enqueueRun(trx: Trx, issue: IssueRow, project: ProjectRow, action: Extract<PipelineAction, { type: 'enqueueRun' }>): Promise<void> {
  const agent = await resolveAgentForRole(trx, issue, project, action.role)
  if (!agent) {
    await emit(trx, issue.orgId, {
      type: 'tracker.comment',
      issueId: issue.id,
      template: 'no_agent',
      body: action.role === 'other' ? 'assigned' : action.role,
    })
    await emit(trx, issue.orgId, { type: 'pipeline.advance', issueId: issue.id, event: { type: 'run.finished', result: 'failed', retryable: false } })
    return
  }
  const snapshot = await buildAgentSnapshot(trx, agent)
  const parent =
    action.attempt > 1
      ? await trx<RunRow>('runs').where({ issueId: issue.id, pipelineStep: action.step }).orderBy('created_at', 'desc').first('id')
      : undefined
  const [run] = await trx<RunRow>('runs')
    .insert({
      orgId: issue.orgId,
      issueId: issue.id,
      projectId: project.id,
      parentRunId: parent?.id ?? null,
      agentId: agent.accountId,
      agentSnapshot: json(snapshot) as never,
      phase: action.phase,
      pipelineStep: action.step,
      attempt: action.attempt,
      runtime: agent.runtime,
      model: agent.model,
    })
    .returning('*')
  if (!run) throw new Error('Run insert returned nothing')

  const locked = await trx('issues').where({ id: issue.id }).whereNull('lockedByRunId').update({ lockedByRunId: run.id })
  // A cancelled predecessor is still wrapping up. releaseIssueLock starts this run when it finishes.
  if (locked > 0) await emit(trx, issue.orgId, { type: 'run.enqueue', runId: run.id })
  await writeAudit(trx, {
    orgId: issue.orgId,
    actorAccountId: agent.accountId,
    actorKind: 'agent',
    action: 'run.created',
    targetType: 'run',
    targetId: run.id,
    metadata: { phase: action.phase, issue: issue.identifier, attempt: action.attempt },
  })
  await emit(trx, issue.orgId, { type: 'notify', kind: 'run', id: run.id, projectId: project.id })
}

export async function releaseIssueLock(trx: Trx, issueId: string, runId: string): Promise<void> {
  const cleared = await trx('issues').where({ id: issueId, lockedByRunId: runId }).update({ lockedByRunId: null })
  if (cleared === 0) return
  const next = await trx<RunRow>('runs').where({ issueId, state: 'queued' }).orderBy('created_at').first()
  if (!next) return
  await trx('issues').where({ id: issueId }).update({ lockedByRunId: next.id })
  await emit(trx, next.orgId, { type: 'run.enqueue', runId: next.id })
}

async function createGateApproval(trx: Trx, issue: IssueRow, kind: 'plan' | 'merge', timeoutMinutes: number | undefined): Promise<void> {
  const payload: Record<string, unknown> = {}
  let runId: string | null = null
  if (kind === 'plan') {
    const planRun = await trx<RunRow>('runs').where({ issueId: issue.id, phase: 'plan', state: 'succeeded' }).orderBy('created_at', 'desc').first()
    payload.plan = planRun?.structuredOutput ?? null
    runId = planRun?.id ?? null
  } else {
    payload.mergeRequests = (await mergeRequestsOf(trx, issue.id)).map((mr) => ({
      repoPath: mr.repoPath,
      iid: mr.mrIid,
      url: mr.mrUrl,
      state: mr.mrState,
    }))
  }
  const expiresAt = timeoutMinutes ? new Date(Date.now() + timeoutMinutes * 60_000) : null
  const [approval] = await trx('approvals')
    .insert({ orgId: issue.orgId, issueId: issue.id, runId, kind, payload: json(payload), expiresAt })
    .onConflict()
    .ignore()
    .returning('id')
  if (approval) await emit(trx, issue.orgId, { type: 'notify', kind: 'approval', id: approval.id, projectId: issue.projectId })
  if (kind === 'plan') await emit(trx, issue.orgId, { type: 'tracker.comment', issueId: issue.id, template: 'plan_ready', runId: runId ?? undefined })
}

/** Works for both a live container (a command row the worker delivers) and one that never started (cancelled here). */
export async function requestRunCancel(
  trx: Trx,
  runId: string,
  reason: string,
  options: { discard?: boolean; by?: string | null } = {},
): Promise<void> {
  const run = await trx<RunRow>('runs').where({ id: runId }).forUpdate().first()
  if (!run || ['succeeded', 'failed', 'cancelled'].includes(run.state)) return
  if (run.state === 'queued' || run.state === 'suspended') {
    await trx('runs')
      .where({ id: runId })
      .update({ state: 'cancelled', outcome: 'cancelled', finishedAt: trx.fn.now(), cancelRequestedAt: trx.fn.now(), updatedAt: trx.fn.now() })
    await trx('approvals')
      .where({ runId, status: 'pending' })
      .whereIn('kind', ['tool', 'question'])
      .update({ status: 'expired', decidedAt: trx.fn.now() })
    if (run.issueId) await releaseIssueLock(trx, run.issueId, runId)
    await emit(trx, run.orgId, { type: 'notify', kind: 'run', id: runId, projectId: run.projectId })
    return
  }
  await trx('runs')
    .where({ id: runId })
    .update({ cancelRequestedAt: trx.fn.now(), discardOnCancel: options.discard ?? false, updatedAt: trx.fn.now() })
  await trx('run_commands').insert({ runId, payload: json({ type: 'cancel', reason, graceSeconds: 30 }), createdBy: options.by ?? null })
  await emit(trx, run.orgId, { type: 'run.ping', runId })
}
