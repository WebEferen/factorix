import type { ScmWebhookEvent } from '@factorix/connectors'
import { isFactoryScmBody } from '@factorix/core'
import type { ConnectionRow, Db, IssueMergeRequestRow, IssueRow, ProjectRow } from '@factorix/db'
import type { Queue } from 'bullmq'
import type { AppDeps } from '../deps'
import { writeAudit } from '../lib/audit'
import { emit } from '../lib/outbox'
import { getConnection, scmFor } from './connections'
import { advanceIssue } from './pipeline'
import { isOpenMergeRequest, type LinkedMergeRequest, mergeRequestsOf } from './repos'
import { syncDiscussions, upsertDiscussionNote } from './scm-sync'

type Deps = Pick<AppDeps, 'db' | 'secrets' | 'connectors' | 'queues' | 'timings'>

export const NOTE_DEBOUNCE_MS = 3 * 60_000
export const CI_WAIT_TIMEOUT_MS = 30 * 60_000

/** iid is only unique inside one repository, so the lookup needs both. */
async function mergeRequestByIid(
  deps: Pick<AppDeps, 'db'>,
  connectionId: string,
  repoId: string,
  iid: number,
): Promise<IssueMergeRequestRow | undefined> {
  return (await deps
    .db('issue_merge_requests')
    .join('project_repos', 'issue_merge_requests.repo_id', 'project_repos.id')
    .join('projects', 'project_repos.project_id', 'projects.id')
    .where({ 'projects.scm_connection_id': connectionId, 'project_repos.scm_repo_id': repoId, 'issue_merge_requests.mr_iid': iid })
    .select('issue_merge_requests.*')
    .first()) as IssueMergeRequestRow | undefined
}

async function issueById(deps: Pick<AppDeps, 'db'>, id: string): Promise<IssueRow | undefined> {
  return deps.db<IssueRow>('issues').where({ id }).first()
}

async function issueByBranch(deps: Pick<AppDeps, 'db'>, connectionId: string, repoId: string, branch: string): Promise<IssueRow | undefined> {
  return (await deps
    .db('issues')
    .join('project_repos', 'issues.project_id', 'project_repos.project_id')
    .join('projects', 'issues.project_id', 'projects.id')
    .where({ 'projects.scm_connection_id': connectionId, 'project_repos.scm_repo_id': repoId, 'issues.branch_name': branch })
    .select('issues.*')
    .first()) as IssueRow | undefined
}

/** Five comments in a row should become one address-review run, so the job id is the issue and the first note starts the clock. */
export async function scheduleHumanNoteEvent(queue: Queue, issueId: string, debounceMs = NOTE_DEBOUNCE_MS): Promise<void> {
  const bucket = Math.floor(Date.now() / debounceMs)
  await queue.add(
    'debounced-event',
    { issueId, event: { type: 'external', name: 'mr.note.human' } },
    { delay: debounceMs, jobId: `note-${issueId}-${bucket}` },
  )
}

export async function settleCi(deps: Pick<AppDeps, 'db'>, issueId: string): Promise<void> {
  await advanceIssue(deps.db, issueId, { type: 'ci.settled' })
}

/** One closed merge request does not end an issue while others are still open. It ends when none are left, and counts as merged if any merged. */
async function advanceWhenAllFinished(db: Db, issueId: string): Promise<void> {
  const rows = (await db('issue_merge_requests').where({ issueId })) as IssueMergeRequestRow[]
  if (rows.length === 0 || rows.some(isOpenMergeRequest)) return
  await advanceIssue(db, issueId, { type: 'external', name: rows.some((row) => row.mrState === 'merged') ? 'mr.merged' : 'mr.closed' })
}

export async function handleScmEvent(deps: Deps, connectionId: string, event: ScmWebhookEvent): Promise<'processed' | 'ignored'> {
  switch (event.kind) {
    case 'mr.merged':
    case 'mr.closed': {
      const mr = await mergeRequestByIid(deps, connectionId, event.repoId, event.iid)
      if (!mr) return 'ignored'
      await deps
        .db('issue_merge_requests')
        .where({ id: mr.id })
        .update({ mrState: event.kind === 'mr.merged' ? 'merged' : 'closed', updatedAt: deps.db.fn.now() })
      await deps.db('issues').where({ id: mr.issueId }).update({ updatedAt: deps.db.fn.now() })
      await emit(deps.db, mr.orgId, {
        type: 'workflow.event',
        issueId: mr.issueId,
        event: { kind: 'merge_request', event: event.kind === 'mr.merged' ? 'merged' : 'closed', url: mr.mrUrl },
      })
      await emit(deps.db, mr.orgId, { type: 'notify', kind: 'issue', id: mr.issueId, projectId: (await issueById(deps, mr.issueId))?.projectId })
      await advanceWhenAllFinished(deps.db, mr.issueId)
      return 'processed'
    }
    case 'mr.note': {
      const mr = await mergeRequestByIid(deps, connectionId, event.repoId, event.iid)
      const issue = mr ? await issueById(deps, mr.issueId) : undefined
      if (!mr || !issue) return 'ignored'
      await upsertDiscussionNote(deps.db, issue, mr, event.discussionId, event.note)
      await emit(deps.db, issue.orgId, { type: 'notify', kind: 'issue', id: issue.id, projectId: issue.projectId })
      if (event.note.system || isFactoryScmBody(event.note.body)) return 'ignored'
      await scheduleHumanNoteEvent(deps.queues.pipelineAdvance, issue.id, deps.timings?.noteDebounceMs)
      return 'processed'
    }
    case 'pipeline': {
      if (['pending', 'running', 'none'].includes(event.status)) return 'ignored'
      const mr = event.iid ? await mergeRequestByIid(deps, connectionId, event.repoId, event.iid) : undefined
      const issue = mr ? await issueById(deps, mr.issueId) : event.ref ? await issueByBranch(deps, connectionId, event.repoId, event.ref) : undefined
      if (issue?.cursor?.waitingFor !== 'ci') return 'ignored'
      // This repository finished. The others may not have, and a review must see all of them.
      if ((await mergeRequestsOf(deps.db, issue.id)).length > 1) await checkCi(deps, issue.id)
      else await settleCi(deps, issue.id)
      return 'processed'
    }
    case 'ignored':
      return 'ignored'
    default:
      return 'ignored'
  }
}

export async function checkCi(deps: Deps, issueId: string): Promise<void> {
  const { db } = deps
  const issue = await db<IssueRow>('issues').where({ id: issueId }).first()
  if (issue?.cursor?.waitingFor !== 'ci') return
  const project = await db<ProjectRow>('projects').where({ id: issue.projectId }).first()
  const open = (await mergeRequestsOf(db, issueId)).filter(isOpenMergeRequest)
  if (!project || open.length === 0) return settleCi(deps, issueId)
  const scm = scmFor(deps, await getConnection(db, issue.orgId, project.scmConnectionId))
  const statuses = await Promise.all(open.map((mr) => scm.getCiStatus(mr.repo.scmRepoId, mr.mrIid)))
  if (!statuses.some((ci) => ['pending', 'running'].includes(ci.status))) return settleCi(deps, issueId)
  await deps.queues.scmAction.add(
    'ci-timeout',
    { issueId },
    { delay: CI_WAIT_TIMEOUT_MS, jobId: `ci-timeout-${issueId}-${Math.floor(Date.now() / CI_WAIT_TIMEOUT_MS)}` },
  )
}

export async function mergeIssue(deps: Deps, issueId: string): Promise<void> {
  const { db } = deps
  const issue = await db<IssueRow>('issues').where({ id: issueId }).first()
  if (!issue) return
  const project = await db<ProjectRow>('projects').where({ id: issue.projectId }).first()
  const mergeRequests = await mergeRequestsOf(db, issueId)
  if (!project || mergeRequests.length === 0) return void (await advanceIssue(db, issueId, { type: 'action.result', result: 'failed' }))
  const connection: ConnectionRow = await getConnection(db, issue.orgId, project.scmConnectionId)
  const scm = scmFor(deps, connection)
  const open = mergeRequests.filter(isOpenMergeRequest)
  const blocked = async (metadata: Record<string, unknown>) => {
    await writeAudit(db, { orgId: issue.orgId, actorKind: 'system', action: 'scm.merge_blocked', targetType: 'issue', targetId: issue.id, metadata })
    await advanceIssue(db, issueId, { type: 'action.result', result: 'failed' })
  }
  // Check everything before merging anything, so one red repository does not leave the issue half merged.
  for (const mr of open) {
    const ci = await scm.getCiStatus(mr.repo.scmRepoId, mr.mrIid)
    if (ci.status !== 'success' && ci.status !== 'none' && ci.status !== 'skipped') return blocked({ ci: ci.status, mr: mr.mrIid, repo: mr.repoPath })
  }
  const setState = (mr: LinkedMergeRequest, mrState: string) =>
    db('issue_merge_requests').where({ id: mr.id }).update({ mrState, updatedAt: db.fn.now() })
  for (const mr of open) {
    const current = await scm.getMergeRequest(mr.repo.scmRepoId, mr.mrIid)
    if (current.state === 'merged') {
      await setState(mr, 'merged')
      continue
    }
    const merged = await scm.merge(mr.repo.scmRepoId, mr.mrIid, { sha: current.sha, squash: true })
    if (!merged.merged) return blocked({ reason: merged.reason, mr: mr.mrIid, repo: mr.repoPath })
    await setState(mr, 'merged')
    await writeAudit(db, {
      orgId: issue.orgId,
      actorKind: 'system',
      action: 'scm.merged',
      targetType: 'issue',
      targetId: issue.id,
      metadata: { mr: mr.mrIid, repo: mr.repoPath },
    })
  }
  await advanceIssue(db, issueId, { type: 'action.result', result: mergeRequests.some((mr) => mr.mrState !== 'closed') ? 'merged' : 'failed' })
}

/** Makes the system usable with no public webhook URL at all, and repairs anything a dropped webhook missed. */
export async function pollOpenMergeRequests(deps: Deps, project: ProjectRow): Promise<void> {
  const { db } = deps
  const issues = await db<IssueRow>('issues')
    .where({ projectId: project.id })
    .whereIn('id', db('issue_merge_requests').select('issue_id'))
    .whereNotIn('factoryState', ['done', 'cancelled', 'untracked'])
  if (issues.length === 0) return
  const connection = await getConnection(db, project.orgId, project.scmConnectionId)
  const scm = scmFor(deps, connection)
  for (const issue of issues) {
    let newHumanNotes = 0
    const open: LinkedMergeRequest[] = []
    for (const mr of await mergeRequestsOf(db, issue.id)) {
      if (!isOpenMergeRequest(mr)) continue
      const current = await scm.getMergeRequest(mr.repo.scmRepoId, mr.mrIid)
      if (current.state !== mr.mrState)
        await db('issue_merge_requests').where({ id: mr.id }).update({ mrState: current.state, updatedAt: db.fn.now() })
      if (!isOpenMergeRequest({ mrState: current.state })) continue
      open.push(mr)
      newHumanNotes += (await syncDiscussions(db, scm, issue, mr)).newHumanNotes
    }
    if (open.length === 0) {
      await advanceWhenAllFinished(db, issue.id)
      continue
    }
    if (newHumanNotes > 0) await scheduleHumanNoteEvent(deps.queues.pipelineAdvance, issue.id, deps.timings?.noteDebounceMs)
    if (issue.cursor?.waitingFor === 'ci') {
      const statuses = await Promise.all(open.map((mr) => scm.getCiStatus(mr.repo.scmRepoId, mr.mrIid)))
      if (!statuses.some((ci) => ['pending', 'running'].includes(ci.status))) await settleCi(deps, issue.id)
    }
  }
}
