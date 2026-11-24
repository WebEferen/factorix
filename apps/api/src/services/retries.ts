import { json, type ProjectRow, type RunRow, type WorkflowStepRow } from '@factorix/db'
import type { ErrorCode } from '@factorix/runtime'
import type { Knex } from 'knex'
import { writeAudit } from '../lib/audit'
import { emit } from '../lib/outbox'

/** What breaks a run down, as opposed to the agent failing at its work. Only these go round a project's retry loop. */
export const BREAKDOWNS: readonly ErrorCode[] = ['rate_limit', 'runtime_crash', 'timeout']

/** A run whose workers died this many times while holding it is most likely what kills them, so it stops being resumed. */
export const MAX_LOST_WORKERS = 3

type RetryPolicy = Pick<ProjectRow, 'retryAttempts' | 'retryDelaySeconds'> | null | undefined

export const retryAttempts = (project: RetryPolicy): number => project?.retryAttempts ?? 2

/** Attempt 2 waits the project's delay, and every attempt after it twice as long as the one before. */
export function retryDelayMs(project: RetryPolicy, attempt: number): number {
  return (project?.retryDelaySeconds ?? 30) * 1000 * 2 ** Math.max(0, attempt - 2)
}

/**
 * The next attempt of an agent a workflow asked, which has no pipeline to retry it, once its project's delay is up. The workflow's
 * step then waits for the new run. Nothing happens when the step stopped waiting for this one, as when its workflow was cancelled.
 */
export async function retryAskedRun(trx: Knex.Transaction, run: RunRow, project: RetryPolicy): Promise<RunRow | null> {
  const asked = run.trigger as { workflowRunId?: string; nodeId?: string }
  if (!asked.workflowRunId || !asked.nodeId || run.attempt >= retryAttempts(project)) return null
  const step = await trx<WorkflowStepRow>('workflow_steps')
    .where({ runId: asked.workflowRunId, nodeId: asked.nodeId, status: 'waiting' })
    .forUpdate()
    .first()
  if (step?.output?.runId !== run.id) return null
  const attempt = run.attempt + 1
  const delayMs = retryDelayMs(project, attempt)
  const [retry] = await trx<RunRow>('runs')
    .insert({
      orgId: run.orgId,
      issueId: run.issueId,
      projectId: run.projectId,
      parentRunId: run.id,
      agentId: run.agentId,
      agentSnapshot: json(run.agentSnapshot) as never,
      phase: run.phase,
      attempt,
      trigger: json(run.trigger) as never,
      createdBy: run.createdBy,
      runtime: run.runtime,
      model: run.model,
      notBefore: new Date(Date.now() + delayMs),
    })
    .returning('*')
  if (!retry) throw new Error('Run insert returned nothing')
  const url = typeof step.output.url === 'string' ? step.output.url.replace(run.id, retry.id) : undefined
  await trx('workflow_steps')
    .where({ runId: asked.workflowRunId, nodeId: asked.nodeId })
    .update({ output: json({ ...step.output, runId: retry.id, url }) })
  const locked = run.issueId ? await trx('issues').where({ id: run.issueId }).whereNull('lockedByRunId').update({ lockedByRunId: retry.id }) : 1
  // Another run has the ticket's workspace. releaseIssueLock starts this one when it finishes.
  if (locked > 0) await emit(trx, run.orgId, { type: 'run.enqueue', runId: retry.id, delayMs })
  await writeAudit(trx, {
    orgId: run.orgId,
    actorAccountId: run.agentId,
    actorKind: 'agent',
    action: 'run.created',
    targetType: 'run',
    targetId: retry.id,
    metadata: { phase: run.phase, attempt, retryOf: run.id, via: 'workflow' },
  })
  await emit(trx, run.orgId, { type: 'notify', kind: 'run', id: retry.id, projectId: run.projectId })
  return retry
}
