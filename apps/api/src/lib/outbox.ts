import type { Autonomy, PipelineEvent, TrackerStateKey, WorkflowEvent } from '@factorix/core'
import { type Db, json } from '@factorix/db'
import type { Knex } from 'knex'

export type DomainEvent =
  | { type: 'run.enqueue'; runId: string }
  | { type: 'pipeline.advance'; issueId: string; event: PipelineEvent }
  | { type: 'tracker.setState'; issueId: string; key: TrackerStateKey }
  | { type: 'tracker.comment'; issueId: string; template: string; agentHandle?: string; runId?: string; body?: string; step?: string }
  | { type: 'scm.ci_check'; issueId: string }
  | { type: 'scm.merge'; issueId: string; autonomy?: Autonomy; decidedBy?: string | null }
  | { type: 'scm.revert'; issueId: string }
  | { type: 'run.ping'; runId: string }
  | { type: 'project.sync'; projectId: string }
  | { type: 'workflow.event'; issueId: string; event: WorkflowEvent }
  | { type: 'workflow.advance'; runId: string }
  | { type: 'workflow.step'; runId: string; nodeId: string }
  | { type: 'notify'; kind: 'issue' | 'run' | 'approval' | 'project' | 'agent' | 'network' | 'settings'; id: string; projectId?: string | null }

export type DomainEventType = DomainEvent['type']

/** Everything that must reach a queue goes through here, in the same transaction as the state it describes. */
export async function emit(db: Db | Knex.Transaction, orgId: string, event: DomainEvent): Promise<void> {
  const { type, ...payload } = event
  await db('domain_events').insert({ orgId, type, payload: json(payload) })
}
