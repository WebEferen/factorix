import type { IssueRow, ProjectRow } from '@factorix/db'
import type { AppDeps } from '../deps'
import { isTrackerClosed } from '../dto'
import { writeAudit } from '../lib/audit'
import { conflict, notFound } from '../lib/errors'
import { emit } from '../lib/outbox'
import { agentRole } from './agents'
import { getConnection, trackerFor } from './connections'
import { advanceIssue } from './pipeline'

export const STARTABLE = ['untracked', 'done', 'failed', 'cancelled']
export const CLOSED_MESSAGE = 'This issue is closed in the tracker. Reopen it there to hand it to an agent.'

export async function assignIssue(
  deps: Pick<AppDeps, 'db' | 'secrets' | 'connectors'>,
  issue: IssueRow,
  agentId: string | null,
  actor: { accountId: string | null; via: string },
): Promise<void> {
  const { db } = deps
  if (agentId && isTrackerClosed(issue) && STARTABLE.includes(issue.factoryState)) throw conflict(CLOSED_MESSAGE)
  const project = (await db<ProjectRow>('projects').where({ id: issue.projectId }).first()) as ProjectRow
  const tracker = trackerFor(deps, await getConnection(db, issue.orgId, project.trackerConnectionId))

  const handleById = async (id: string | null) =>
    id ? ((await db('accounts').where({ id, orgId: issue.orgId, kind: 'agent' }).first())?.handle as string | undefined) : undefined
  const nextHandle = await handleById(agentId)
  if (agentId && !nextHandle) throw notFound('Agent')
  // Pipeline work and a one-off task cannot share a ticket. Accepting this would change the assignment and start nothing.
  if (agentId && agentId !== issue.assignedAgentId && !STARTABLE.includes(issue.factoryState)) {
    const involved = [agentId, issue.assignedAgentId].filter((id): id is string => id !== null)
    const roles = await Promise.all(involved.map((id) => agentRole(db, id)))
    if (roles.includes('other')) throw conflict('This ticket is being worked on. Let it finish, or remove its agent first.')
  }
  const previousHandle = await handleById(issue.assignedAgentId)
  const add = nextHandle && project.agentLabels[nextHandle] ? [project.agentLabels[nextHandle] as string] : undefined
  const remove =
    previousHandle && previousHandle !== nextHandle && project.agentLabels[previousHandle]
      ? [project.agentLabels[previousHandle] as string]
      : undefined
  if (add || remove) await tracker.updateIssueLabels(issue.trackerIssueId, { add, remove })

  await db('issues').where({ id: issue.id }).update({ assignedAgentId: agentId, updatedAt: db.fn.now() })
  await writeAudit(db, {
    orgId: issue.orgId,
    actorAccountId: actor.accountId,
    actorKind: actor.accountId ? 'human' : 'system',
    action: agentId ? 'issue.assigned_to_agent' : 'issue.unassigned',
    targetType: 'issue',
    targetId: issue.id,
    metadata: { handle: nextHandle, identifier: issue.identifier, via: actor.via },
  })

  if (agentId && STARTABLE.includes(issue.factoryState)) await advanceIssue(db, issue.id, { type: 'start' })
  else if (!agentId && !STARTABLE.includes(issue.factoryState)) await advanceIssue(db, issue.id, { type: 'cancel' })
  await emit(db, issue.orgId, { type: 'notify', kind: 'issue', id: issue.id, projectId: issue.projectId })
}
