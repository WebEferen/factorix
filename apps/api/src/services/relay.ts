import type { DomainEventRow } from '@factorix/db'
import type { AppDeps } from '../deps'
import { orgChannel, runCommandChannel } from '../lib/channels'

const BATCH = 100

/** The only path from the database to a queue. A crash between enqueue and mark just re-adds jobs with the same ids. */
export async function relayDomainEvents(deps: Pick<AppDeps, 'db' | 'queues' | 'redis'>): Promise<number> {
  const { db, queues, redis } = deps
  return db.transaction(async (trx) => {
    const rows = await trx<DomainEventRow>('domain_events').whereNull('processedAt').orderBy('id').limit(BATCH).forUpdate().skipLocked()
    for (const row of rows) {
      // biome-ignore lint/suspicious/noExplicitAny: payloads are validated by the DomainEvent type when they are written
      const payload = row.payload as Record<string, any>
      const jobId = `de-${row.id}`
      switch (row.type) {
        case 'run.enqueue':
          await queues.runsExecute.add('execute', { runId: payload.runId }, { jobId })
          break
        case 'pipeline.advance':
          await queues.pipelineAdvance.add('advance', { issueId: payload.issueId, event: payload.event }, { jobId })
          break
        case 'tracker.setState':
          await queues.trackerOutbound.add('set-state', payload, { jobId })
          break
        case 'tracker.comment':
          await queues.trackerOutbound.add('comment', payload, { jobId })
          break
        case 'scm.ci_check':
          await queues.scmAction.add('ci-check', payload, { jobId })
          break
        case 'scm.merge':
          await queues.scmAction.add('merge', payload, { jobId })
          break
        case 'scm.revert':
          await queues.scmAction.add('revert', payload, { jobId })
          break
        case 'project.sync':
          await queues.projectSync.add('import', { projectId: payload.projectId }, { jobId })
          break
        case 'workflow.event':
          await queues.workflows.add('event', { issueId: payload.issueId, event: payload.event, eventId: jobId }, { jobId })
          break
        case 'workflow.advance':
          await queues.workflows.add('advance', { runId: payload.runId }, { jobId })
          break
        case 'workflow.step':
          await queues.workflows.add('step', { runId: payload.runId, nodeId: payload.nodeId }, { jobId })
          break
        case 'environment.action':
          await queues.environments.add(payload.action, { instanceId: payload.instanceId, action: payload.action }, { jobId })
          break
        case 'run.ping':
          await redis.publish(runCommandChannel(payload.runId), '1')
          break
        case 'notify':
          await redis.publish(orgChannel(row.orgId), JSON.stringify(payload))
          break
      }
    }
    if (rows.length > 0) {
      await trx('domain_events')
        .whereIn(
          'id',
          rows.map((row) => row.id),
        )
        .update({ processedAt: trx.fn.now() })
    }
    return rows.length
  })
}
