import type { MergeRequest, ScmConnector, ScmWebhookEvent } from '@factorix/connectors'
import { isFactoryScmBody } from '@factorix/core'
import { type ConnectionRow, type Db, type IssueMergeRequestRow, type IssueRow, json, type ProjectRow } from '@factorix/db'
import type { Queue } from 'bullmq'
import type { AppDeps } from '../deps'
import { writeAudit } from '../lib/audit'
import { emit } from '../lib/outbox'
import { getConnection, scmFor } from './connections'
import { advanceIssue } from './pipeline'
import { isOpenMergeRequest, type LinkedMergeRequest, mergeRequestSnapshot, mergeRequestsOf } from './repos'
import { syncDiscussions, upsertDiscussionNote } from './scm-sync'
import { readSettings } from './settings'

type Deps = Pick<AppDeps, 'db' | 'env' | 'secrets' | 'connectors' | 'queues' | 'timings'>

export const NOTE_DEBOUNCE_MS = 3 * 60_000

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

async function mergeRequestByRevertIid(
  deps: Pick<AppDeps, 'db'>,
  connectionId: string,
  repoId: string,
  iid: number,
): Promise<IssueMergeRequestRow | undefined> {
  return (await deps
    .db('issue_merge_requests')
    .join('project_repos', 'issue_merge_requests.repo_id', 'project_repos.id')
    .join('projects', 'project_repos.project_id', 'projects.id')
    .where({ 'projects.scm_connection_id': connectionId, 'project_repos.scm_repo_id': repoId, 'issue_merge_requests.revert_mr_iid': iid })
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
  // A zero wait still needs a bucket, so comments in the same second share a job.
  const bucket = Math.floor(Date.now() / Math.max(debounceMs, 1000))
  await queue.add(
    'debounced-event',
    { issueId, event: { type: 'external', name: 'mr.note.human' } },
    { delay: debounceMs, jobId: `note-${issueId}-${bucket}` },
  )
}

async function noteDebounceOf(deps: Deps): Promise<number> {
  return deps.timings?.noteDebounceMs ?? (await readSettings(deps)).noteDebounceMinutes * 60_000
}

export async function settleCi(deps: Pick<AppDeps, 'db'>, issueId: string): Promise<void> {
  await advanceIssue(deps.db, issueId, { type: 'ci.settled' })
}

/** One closed merge request does not end an issue while others are still open. Once none are left, a mix of merged and closed is for a person to judge. */
async function advanceWhenAllFinished(db: Db, issueId: string): Promise<void> {
  const rows = (await db('issue_merge_requests').where({ issueId })) as IssueMergeRequestRow[]
  if (rows.length === 0 || rows.some(isOpenMergeRequest)) return
  const merged = rows.some((row) => row.mrState === 'merged')
  const closed = rows.some((row) => row.mrState === 'closed')
  await advanceIssue(db, issueId, { type: 'external', name: !merged ? 'mr.closed' : closed ? 'mr.partial' : 'mr.merged' })
}

export async function handleScmEvent(deps: Deps, connectionId: string, event: ScmWebhookEvent): Promise<'processed' | 'ignored'> {
  switch (event.kind) {
    case 'mr.merged':
    case 'mr.closed': {
      const mr = await mergeRequestByIid(deps, connectionId, event.repoId, event.iid)
      if (!mr) {
        const undoing = await mergeRequestByRevertIid(deps, connectionId, event.repoId, event.iid)
        if (!undoing) return 'ignored'
        await revertIssue(deps, undoing.issueId, { retryFailed: false })
        return 'processed'
      }
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
      await scheduleHumanNoteEvent(deps.queues.pipelineAdvance, issue.id, await noteDebounceOf(deps))
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
  const waitMs = (await readSettings(deps)).ciWaitMinutes * 60_000
  await deps.queues.scmAction.add('ci-timeout', { issueId }, { delay: waitMs, jobId: `ci-timeout-${issueId}-${Math.floor(Date.now() / waitMs)}` })
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
  const save = (mr: LinkedMergeRequest, patch: Partial<IssueMergeRequestRow>) =>
    db('issue_merge_requests')
      .where({ id: mr.id })
      .update({ ...patch, updatedAt: db.fn.now() })

  // A person may have merged, closed, or reopened one since the last look, and a retry has to see that.
  const current = new Map<string, MergeRequest>()
  for (const mr of mergeRequests) {
    if (mr.mrState === 'merged') continue
    const fresh = await scm.getMergeRequest(mr.repo.scmRepoId, mr.mrIid)
    current.set(mr.id, fresh)
    mr.mrState = fresh.state
    await save(mr, { mrState: fresh.state, mergeError: null })
  }
  const stopped = async (mr: LinkedMergeRequest, reason: string, metadata: Record<string, unknown>) => {
    await save(mr, { mergeError: reason })
    await writeAudit(db, {
      orgId: issue.orgId,
      actorKind: 'system',
      action: 'scm.merge_blocked',
      targetType: 'issue',
      targetId: issue.id,
      metadata: { ...metadata, mr: mr.mrIid, repo: mr.repoPath },
    })
    await advanceIssue(db, issueId, { type: 'action.result', result: mergeRequests.some((row) => row.mrState === 'merged') ? 'partial' : 'failed' })
  }

  const open = mergeRequests.filter(isOpenMergeRequest)
  // Merges in different repositories cannot land together. Checking everything first means nothing lands unless all of it could.
  for (const mr of open) {
    const ci = await scm.getCiStatus(mr.repo.scmRepoId, mr.mrIid)
    if (ci.status !== 'success' && ci.status !== 'none' && ci.status !== 'skipped')
      return stopped(mr, `its pipeline is ${ci.status}`, { ci: ci.status })
    const blocker = current.get(mr.id)?.mergeBlocker
    if (blocker) return stopped(mr, blocker, { blocker })
  }
  for (const mr of open) {
    const merged = await scm.merge(mr.repo.scmRepoId, mr.mrIid, { sha: current.get(mr.id)?.sha, squash: true })
    if (!merged.merged) return stopped(mr, merged.reason ?? 'the server refused it', { reason: merged.reason })
    mr.mrState = 'merged'
    await save(mr, { mrState: 'merged' })
    await writeAudit(db, {
      orgId: issue.orgId,
      actorKind: 'system',
      action: 'scm.merged',
      targetType: 'issue',
      targetId: issue.id,
      metadata: { mr: mr.mrIid, repo: mr.repoPath },
    })
  }
  const anyMerged = mergeRequests.some((mr) => mr.mrState === 'merged')
  const anyClosed = mergeRequests.some((mr) => mr.mrState === 'closed')
  await advanceIssue(db, issueId, { type: 'action.result', result: !anyMerged ? 'failed' : anyClosed ? 'partial' : 'merged' })
}

async function landRevert(deps: Deps, scm: ScmConnector, issue: IssueRow, mr: LinkedMergeRequest, retryFailed: boolean): Promise<boolean> {
  const { db } = deps
  if (mr.revertState === 'merged') return true
  if (mr.revertState === 'failed' && !retryFailed) return false
  const save = (patch: Partial<IssueMergeRequestRow>) =>
    db('issue_merge_requests')
      .where({ id: mr.id })
      .update({ ...patch, updatedAt: db.fn.now() })
  let iid = mr.revertMrIid
  try {
    if (!iid) {
      const opened = await scm.revertMergeRequest(mr.repo.scmRepoId, mr.mrIid, {
        // Unique per attempt, so a branch left by a failed attempt can never block the next one.
        branch: `factorix/revert-${mr.mrIid}-${Date.now().toString(36)}`,
        title: `${issue.identifier}: revert !${mr.mrIid}`,
        description: `Reverts !${mr.mrIid}. Only part of ${issue.identifier} merged across its repositories, and a person chose to undo it in Factorix.`,
      })
      if (!opened.reverted) {
        await save({ revertState: 'failed', revertError: opened.reason })
        return false
      }
      iid = opened.mergeRequest.iid
      await save({ revertMrIid: iid, revertMrUrl: opened.mergeRequest.url, revertState: 'open', revertError: null })
    }
    const current = await scm.getMergeRequest(mr.repo.scmRepoId, iid)
    if (current.state === 'closed') {
      await save({ revertMrIid: null, revertMrUrl: null, revertState: 'failed', revertError: 'Someone closed the revert merge request.' })
      return false
    }
    const landed = current.state === 'merged' ? { merged: true, reason: undefined } : await scm.merge(mr.repo.scmRepoId, iid, { sha: current.sha })
    if (!landed.merged) {
      await save({ revertState: 'open', revertError: landed.reason ?? 'the server refused it' })
      return false
    }
    await save({ revertState: 'merged', revertError: null })
    await writeAudit(db, {
      orgId: issue.orgId,
      actorKind: 'system',
      action: 'scm.reverted',
      targetType: 'issue',
      targetId: issue.id,
      metadata: { mr: mr.mrIid, revert: iid, repo: mr.repoPath },
    })
    return true
  } catch (error) {
    await save({ revertState: iid ? 'open' : 'failed', revertError: (error as Error).message })
    return false
  }
}

/**
 * Undoes a chain that only partly merged. Newest first, and it stops at the first revert that cannot land yet, because what
 * merged later can rely on what merged earlier. It picks up where the last pass stopped, so the poll and webhooks can call it again.
 */
export async function revertIssue(deps: Deps, issueId: string, options: { retryFailed: boolean } = { retryFailed: true }): Promise<void> {
  const { db } = deps
  const issue = await db<IssueRow>('issues').where({ id: issueId }).first()
  if (!issue?.cursor || !['revert', 'revert_blocked'].includes(issue.cursor.step)) return
  const project = await db<ProjectRow>('projects').where({ id: issue.projectId }).first()
  if (!project) return
  const scm = scmFor(deps, await getConnection(db, issue.orgId, project.scmConnectionId))
  const chain = await mergeRequestsOf(db, issueId)
  let stillOpen = false
  // Nothing else may land once someone chose to undo the change.
  for (const mr of chain.filter(isOpenMergeRequest)) {
    try {
      await scm.closeMergeRequest(mr.repo.scmRepoId, mr.mrIid)
      await db('issue_merge_requests').where({ id: mr.id }).update({ mrState: 'closed', mergeError: null, updatedAt: db.fn.now() })
    } catch (error) {
      stillOpen = true
      await db('issue_merge_requests')
        .where({ id: mr.id })
        .update({ mergeError: `Could not close it: ${(error as Error).message}`, updatedAt: db.fn.now() })
    }
  }
  for (const mr of chain.filter((row) => row.mrState === 'merged').reverse()) {
    if (!(await landRevert(deps, scm, issue, mr, options.retryFailed))) break
  }
  const after = await mergeRequestsOf(db, issueId)
  await db('approvals')
    .where({ issueId, kind: 'revert_blocked', status: 'pending' })
    .update({ payload: json({ mergeRequests: after.map(mergeRequestSnapshot) }) })
  await emit(db, issue.orgId, { type: 'notify', kind: 'issue', id: issue.id, projectId: issue.projectId })
  const unfinished = stillOpen || after.some((mr) => mr.mrState === 'merged' && mr.revertState !== 'merged')
  // At the gate a still unfinished revert is no news, and the engine ignores this result there.
  await advanceIssue(db, issueId, unfinished ? { type: 'action.result', result: 'blocked' } : { type: 'external', name: 'mr.reverted' })
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
    if (issue.cursor?.step === 'revert_blocked') {
      await revertIssue(deps, issue.id, { retryFailed: false })
      continue
    }
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
    if (newHumanNotes > 0) await scheduleHumanNoteEvent(deps.queues.pipelineAdvance, issue.id, await noteDebounceOf(deps))
    if (issue.cursor?.waitingFor === 'ci') {
      const statuses = await Promise.all(open.map((mr) => scm.getCiStatus(mr.repo.scmRepoId, mr.mrIid)))
      if (!statuses.some((ci) => ['pending', 'running'].includes(ci.status))) await settleCi(deps, issue.id)
    }
  }
}
