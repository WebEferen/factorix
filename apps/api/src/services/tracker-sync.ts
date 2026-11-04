import type { TrackerComment, TrackerConnector, TrackerIssue, TrackerLabel, TrackerWebhookEvent } from '@factorix/connectors'
import { formatTrackerComment, isFactoryTrackerComment, type TrackerStateKey, type WorkflowEvent } from '@factorix/core'
import { type ApprovalRow, type ConnectionRow, type Db, type IssueRow, json, type ProjectRow, type RunRow } from '@factorix/db'
import type { Knex } from 'knex'
import type { AppDeps } from '../deps'
import { writeAudit } from '../lib/audit'
import { emit } from '../lib/outbox'
import { getConnection, trackerConnectionFor, trackerFor } from './connections'
import { isEcho, recordEcho } from './echo'
import { advanceIssue } from './pipeline'
import { isOpenMergeRequest, mergeRequestsOf } from './repos'
import { readSettings } from './settings'

type Deps = Pick<AppDeps, 'db' | 'env' | 'secrets' | 'connectors'>

const TERMINAL_FACTORY_STATES = ['untracked', 'done', 'failed', 'cancelled']

async function projectsFor(deps: Deps, connectionId: string, issue: Pick<TrackerIssue, 'teamId' | 'projectId'>): Promise<ProjectRow[]> {
  const rows = await deps.db<ProjectRow>('projects').where({ trackerConnectionId: connectionId, trackerTeamId: issue.teamId })
  return rows.filter((project) => !project.trackerProjectId || project.trackerProjectId === issue.projectId)
}

export function agentHandleFromLabels(project: Pick<ProjectRow, 'agentLabels'>, labels: { id: string; name: string }[]): string | null {
  for (const [handle, labelId] of Object.entries(project.agentLabels ?? {})) {
    if (labels.some((label) => label.id === labelId)) return handle
  }
  return null
}

export async function upsertIssueMirror(
  deps: Pick<AppDeps, 'db'>,
  project: ProjectRow,
  issue: TrackerIssue,
  options: { announce?: boolean } = {},
): Promise<{ row: IssueRow; previous: IssueRow | null }> {
  const previous = (await deps.db<IssueRow>('issues').where({ projectId: project.id, trackerIssueId: issue.id }).first()) ?? null
  const values = {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    trackerStateId: issue.stateId,
    trackerStateName: issue.stateName,
    trackerStateType: issue.stateType,
    labels: json(issue.labels.map((label) => ({ id: label.id, name: label.name }))),
    assigneeTrackerId: issue.assigneeId,
    assigneeName: issue.assigneeName,
    // Webhooks often leave the creator out, and a missing value there must not erase the one an import read.
    ...(issue.creatorName ? { authorTrackerId: issue.creatorId, authorName: issue.creatorName } : {}),
    // Same as the creator: a webhook that leaves this out must not erase what an import read.
    ...(issue.createdAt ? { trackerCreatedAt: issue.createdAt } : {}),
    trackerUpdatedAt: issue.updatedAt,
    trackerUrl: issue.url,
    syncedAt: deps.db.fn.now(),
    updatedAt: issue.updatedAt,
  }
  const [row] = await deps
    .db('issues')
    .insert({
      orgId: project.orgId,
      projectId: project.id,
      trackerIssueId: issue.id,
      announcedAt: options.announce ? deps.db.fn.now() : null,
      ...values,
    })
    .onConflict(['project_id', 'tracker_issue_id'])
    .merge({ ...values, updatedAt: deps.db.raw('GREATEST(issues.updated_at, EXCLUDED.updated_at)') as never })
    .returning('*')
  return { row: row as IssueRow, previous }
}

async function agentIdForHandle(deps: Pick<AppDeps, 'db'>, orgId: string, handle: string): Promise<string | null> {
  const row = await deps
    .db('accounts')
    .join('agents', 'accounts.id', 'agents.account_id')
    .where({ 'accounts.org_id': orgId, 'accounts.handle': handle, 'accounts.status': 'active' })
    .select('accounts.id')
    .first()
  return row?.id ?? null
}

/** Changes a workflow made itself leave an echo marker, so they do not start more workflows. An import announces nothing. */
async function emitWorkflowEvents(
  deps: Pick<AppDeps, 'db'>,
  project: ProjectRow,
  issue: TrackerIssue,
  row: IssueRow,
  previous: IssueRow | null,
): Promise<void> {
  const { db } = deps
  const events: WorkflowEvent[] = []
  if (!previous) {
    const closed = issue.stateType === 'completed' || issue.stateType === 'canceled'
    if (!closed && !(await isEcho(db, 'linear', 'issue', 'create', 'title', issue.title))) events.push({ kind: 'issue.created' })
  } else {
    if (previous.trackerStateId !== issue.stateId && !(await isEcho(db, 'linear', 'issue', issue.id, 'state', issue.stateId))) {
      events.push({ kind: 'status.changed', from: previous.trackerStateName, to: issue.stateName })
    }
    const before = new Set(previous.labels.map((label) => label.id))
    const agentLabels = new Set(Object.values(project.agentLabels))
    for (const label of issue.labels) {
      if (before.has(label.id) || agentLabels.has(label.id)) continue
      if (!(await isEcho(db, 'linear', 'issue', issue.id, 'label', label.name))) events.push({ kind: 'label.added', label: label.name })
    }
  }
  for (const event of events) await emit(db, project.orgId, { type: 'workflow.event', issueId: row.id, event })
}

/** The webhook path and the polling sweep both end here, comparing against the mirror instead of trusting event metadata. */
export async function applyTrackerIssue(
  deps: Deps,
  project: ProjectRow,
  issue: TrackerIssue,
  options: { announce?: boolean } = { announce: true },
): Promise<void> {
  const existing = await deps.db<IssueRow>('issues').where({ projectId: project.id, trackerIssueId: issue.id }).first()
  if (existing?.trackerUpdatedAt && new Date(issue.updatedAt) < existing.trackerUpdatedAt) return

  const { row, previous } = await upsertIssueMirror(deps, project, issue, options)
  await emit(deps.db, project.orgId, { type: 'notify', kind: 'issue', id: row.id, projectId: project.id })
  if (options.announce) await emitWorkflowEvents(deps, project, issue, row, previous)

  const handle = agentHandleFromLabels(project, issue.labels)
  const previousHandle = previous ? agentHandleFromLabels(project, previous.labels) : null
  const labelJustAdded = handle !== null && handle !== previousHandle
  const labelRemoved = previousHandle !== null && handle === null
  const stateChanged = previous !== null && previous.trackerStateId !== issue.stateId
  const stoppable = !TERMINAL_FACTORY_STATES.includes(row.factoryState)

  if (stoppable && (issue.stateType === 'canceled' || labelRemoved)) {
    await advanceIssue(deps.db, row.id, { type: 'cancel' })
    return
  }

  if (handle) {
    const agentId = await agentIdForHandle(deps, project.orgId, handle)
    if (!agentId) return
    if (row.assignedAgentId !== agentId) await deps.db('issues').where({ id: row.id }).update({ assignedAgentId: agentId })
    const startable = TERMINAL_FACTORY_STATES.includes(row.factoryState)
    const eligible = project.trigger.states.includes(issue.stateName)
    // A failed or cancelled issue restarts only on a deliberate move, not because someone edited its title.
    const fresh = row.factoryState === 'untracked' || labelJustAdded || stateChanged
    if (startable && eligible && fresh) {
      await advanceIssue(deps.db, row.id, { type: 'start' })
      await writeAudit(deps.db, {
        orgId: project.orgId,
        actorKind: 'system',
        action: 'issue.assigned_to_agent',
        targetType: 'issue',
        targetId: row.id,
        metadata: { handle, identifier: issue.identifier, via: 'label' },
      })
    }
  }
}

function approvalCommand(body: string): 'approved' | 'rejected' | null {
  const first = body.trim().split(/\s+/)[0]?.toLowerCase()
  if (first === '/approve') return 'approved'
  if (first === '/reject') return 'rejected'
  return null
}

export async function applyTrackerComment(
  deps: Deps,
  connection: ConnectionRow,
  comment: TrackerComment,
  action: 'create' | 'update',
): Promise<void> {
  const { db } = deps
  if (isFactoryTrackerComment(comment.body)) return
  if (await isEcho(db, 'linear', 'comment', comment.issueId, 'comment', comment.body)) return
  const issue = (await db('issues')
    .join('projects', 'issues.project_id', 'projects.id')
    .where({ 'projects.tracker_connection_id': connection.id, 'issues.tracker_issue_id': comment.issueId })
    .select('issues.*')
    .first()) as IssueRow | undefined
  if (!issue || action === 'update') return

  const command = approvalCommand(comment.body)
  if (command) {
    const approval = await db<ApprovalRow>('approvals').where({ issueId: issue.id, kind: 'plan', status: 'pending' }).first()
    if (approval) {
      const decided = await db('approvals')
        .where({ id: approval.id, status: 'pending' })
        .update({
          status: command,
          decidedAt: db.fn.now(),
          decision: json({ via: 'tracker', author: comment.authorName, message: comment.body.trim().split(/\s+/).slice(1).join(' ') || undefined }),
        })
      if (decided > 0) {
        await writeAudit(db, {
          orgId: issue.orgId,
          actorKind: 'human',
          action: `approval.${command}`,
          targetType: 'approval',
          targetId: approval.id,
          metadata: { via: 'tracker', author: comment.authorName },
        })
        await advanceIssue(db, issue.id, { type: 'approval.decided', decision: command })
      }
      return
    }
  }
  await db('issue_instructions')
    .insert({ orgId: issue.orgId, issueId: issue.id, source: 'tracker', externalId: comment.id, author: comment.authorName, body: comment.body })
    .onConflict(['issue_id', 'source', 'external_id'])
    .ignore()
  await emit(db, issue.orgId, { type: 'notify', kind: 'issue', id: issue.id, projectId: issue.projectId })
}

export async function handleTrackerEvent(deps: Deps, connectionId: string, event: TrackerWebhookEvent): Promise<'processed' | 'ignored'> {
  const connection = await deps.db<ConnectionRow>('connections').where({ id: connectionId }).first()
  if (!connection) return 'ignored'
  switch (event.kind) {
    case 'issue.upserted': {
      const projects = await projectsFor(deps, connectionId, event.issue)
      // A webhook omits nothing we need except the state name on minimal payloads, so fetch it in that rare case.
      let issue = event.issue
      if (!issue.stateName) {
        const fresh = await trackerFor(deps, connection).getIssue(issue.id)
        if (fresh) issue = fresh
      }
      for (const project of projects) await applyTrackerIssue(deps, project, issue)
      return projects.length > 0 ? 'processed' : 'ignored'
    }
    case 'issue.removed': {
      const rows = await deps
        .db('issues')
        .join('projects', 'issues.project_id', 'projects.id')
        .where({ 'projects.tracker_connection_id': connectionId, 'issues.tracker_issue_id': event.issueId })
        .select('issues.id')
      for (const row of rows) await advanceIssue(deps.db, row.id, { type: 'cancel' })
      return 'processed'
    }
    case 'comment.upserted':
      await applyTrackerComment(deps, connection, event.comment, event.action)
      return 'processed'
    case 'ignored':
      return 'ignored'
  }
}

/** Years of finished work would cost a large share of the tracker's rate limit and add nothing to a development queue. */

export async function syncProjectIssues(
  deps: Deps,
  project: ProjectRow,
  options: { full?: boolean; allClosed?: boolean; onBatch?: (imported: number) => Promise<void> } = {},
): Promise<number> {
  const connection = await getConnection(deps.db, project.orgId, project.trackerConnectionId)
  const tracker = trackerFor(deps, connection)
  const newest = options.full
    ? undefined
    : ((await deps.db('issues').where({ projectId: project.id }).max('tracker_updated_at as max').first()) as { max: Date | null } | undefined)?.max
  // What a project's first import brings in was already there when it was connected, so it is not news.
  const announce = !options.allClosed && (!options.full || project.lastSyncedAt !== null)
  let cursor: string | null = null
  let count = 0
  do {
    const page: Awaited<ReturnType<TrackerConnector['listIssues']>> = await tracker.listIssues({
      teamId: project.trackerTeamId,
      projectId: project.trackerProjectId,
      updatedAfter: newest?.toISOString(),
      closedSince:
        options.full && !options.allClosed ? new Date(Date.now() - (await readSettings(deps)).closedIssueDays * 86_400_000).toISOString() : undefined,
      cursor,
      limit: 50,
    })
    for (const issue of page.nodes) await applyTrackerIssue(deps, project, issue, { announce })
    count += page.nodes.length
    cursor = page.nextCursor
    await options.onBatch?.(count)
  } while (cursor)
  return count
}

/** No progress for this long means the job is gone, and every batch resets the clock. */
export const IMPORT_STALE_MS = 10 * 60_000

export async function requestProjectImport(trx: Knex.Transaction, project: Pick<ProjectRow, 'id' | 'orgId'>): Promise<void> {
  await trx('projects')
    .where({ id: project.id })
    .update({ syncState: 'syncing', syncError: null, syncedIssueCount: 0, syncHeartbeatAt: trx.fn.now() })
  await emit(trx, project.orgId, { type: 'project.sync', projectId: project.id })
  await emit(trx, project.orgId, { type: 'notify', kind: 'project', id: project.id, projectId: project.id })
}

/** Everything slow about a new project happens here, so creating one is instant and its issues arrive a page at a time. */
export async function importProject(deps: Deps, projectId: string, options: { finalAttempt?: boolean } = {}): Promise<void> {
  const { db } = deps
  const project = await db<ProjectRow>('projects').where({ id: projectId }).first()
  if (!project) return
  const report = (patch: Partial<Record<keyof ProjectRow, unknown>>) =>
    db.transaction(async (trx) => {
      await trx('projects')
        .where({ id: projectId })
        .update({ ...patch, syncHeartbeatAt: trx.fn.now() })
      await emit(trx, project.orgId, { type: 'notify', kind: 'project', id: projectId, projectId })
    })
  await report({ syncState: 'syncing', syncError: null, syncedIssueCount: 0 })
  try {
    let labelError: string | null = null
    const agentLabels = await ensureAgentLabels(deps, project).catch((error: Error) => {
      labelError = `Could not create agent labels in the tracker: ${error.message}`
      return project.agentLabels
    })
    // Issues mirrored before created dates were read can sit outside the closed window, where no later import would reach them.
    const undated = await db('issues').where({ projectId }).whereNull('tracker_created_at').first('id')
    await syncProjectIssues(
      deps,
      { ...project, agentLabels },
      { full: true, allClosed: Boolean(undated), onBatch: (imported) => report({ syncedIssueCount: imported }) },
    )
    // Whatever is still undated has left the tracker, and looking for it on every import would defeat the window.
    if (undated) {
      await db('issues')
        .where({ projectId })
        .whereNull('tracker_created_at')
        .update({ trackerCreatedAt: db.ref('created_at') as never })
    }
    await report({ syncState: labelError ? 'failed' : 'idle', syncError: labelError, lastSyncedAt: db.fn.now() })
  } catch (error) {
    if (options.finalAttempt ?? true) await report({ syncState: 'failed', syncError: `Could not import issues: ${(error as Error).message}` })
    throw error
  }
}

/** Linear groups render as Agent/engineer-1 and stay mutually exclusive, which is how assignment shows on boards with no OAuth app. */
export async function ensureAgentLabels(deps: Deps, project: ProjectRow): Promise<Record<string, string>> {
  const connection = await getConnection(deps.db, project.orgId, project.trackerConnectionId)
  const tracker = trackerFor(deps, connection)
  const handles = (await deps
    .db('accounts')
    .join('agents', 'accounts.id', 'agents.account_id')
    .where({ 'accounts.org_id': project.orgId, 'accounts.status': 'active' })
    .pluck('accounts.handle')) as string[]
  const labels = await tracker.listLabels(project.trackerTeamId)
  const group: TrackerLabel =
    labels.find((label) => label.isGroup && label.name === 'Agent') ??
    (await tracker.createLabel({ teamId: project.trackerTeamId, name: 'Agent', isGroup: true, color: '#0080FF' }))
  const map: Record<string, string> = {}
  for (const handle of handles) {
    const existing = labels.find((label) => label.parentId === group.id && label.name === handle)
    map[handle] = existing?.id ?? (await tracker.createLabel({ teamId: project.trackerTeamId, name: handle, parentId: group.id })).id
  }
  await deps
    .db('projects')
    .where({ id: project.id })
    .update({ agentLabelGroupId: group.id, agentLabels: json(map), updatedAt: deps.db.fn.now() })
  return map
}

const COMMENT_TEMPLATES: Record<string, (context: { body?: string; step?: string; error?: string; issue: IssueRow; run?: RunRow | null }) => string> =
  {
    mr_opened: ({ body }) => `Opened a merge request: ${body}`,
    review_verdict: ({ body }) => body ?? 'Review finished.',
    task_report: ({ body }) => body ?? 'Finished.',
    run_failed: ({ step, error }) => `The ${step} step failed and needs a person.${error ? `\n\n> ${error}` : ''}`,
    loops_exceeded: ({ step }) => `Stopped after too many ${step} rounds. A person should take it from here.`,
    merge_blocked: ({ body }) => `Could not merge ${body || 'the merge request'}, so it is waiting for a person.`,
    merge_partial: ({ body }) => `Only part of this change merged. ${body} A person can retry the rest, revert what merged, or keep it, in Factorix.`,
    merge_reverted: ({ body }) => `Reverted what had merged: ${body}.`,
    revert_blocked: ({ body }) => `The revert could not finish, so it is waiting for a person: ${body}.`,
    no_agent: ({ body }) => `No active ${body} agent is available for this project, so the work stopped here.`,
    plan_ready: ({ run }) => {
      const plan = run?.structuredOutput as
        | { summary?: string; steps?: string[]; filesTouched?: string[]; risks?: string[]; questions?: string[] }
        | null
        | undefined
      const list = (title: string, items?: string[]) => (items?.length ? `\n\n**${title}**\n${items.map((item) => `- ${item}`).join('\n')}` : '')
      return `Here is the plan. Reply \`/approve\` to start, or \`/reject\` to stop.\n\n${plan?.summary ?? ''}${list('Steps', plan?.steps)}${list('Files', plan?.filesTouched)}${list('Risks', plan?.risks)}${list('Questions', plan?.questions)}`
    },
  }

async function mergeRequestLinks(db: Db, issueId: string, template: string): Promise<string | undefined> {
  if (!['merge_blocked', 'merge_partial', 'merge_reverted', 'revert_blocked'].includes(template)) return undefined
  const rows = await mergeRequestsOf(db, issueId)
  const withReason = (url: string, reason: string | null) => (reason ? `${url} (${reason})` : url)
  const merged = rows.filter((mr) => mr.mrState === 'merged')
  if (template === 'merge_blocked')
    return rows
      .filter(isOpenMergeRequest)
      .map((mr) => mr.mrUrl)
      .join(', ')
  if (template === 'merge_reverted') return rows.flatMap((mr) => mr.revertMrUrl ?? []).join(', ')
  if (template === 'revert_blocked') {
    return merged
      .filter((mr) => mr.revertState !== 'merged')
      .map((mr) => withReason(mr.revertMrUrl ?? mr.mrUrl, mr.revertError))
      .join(', ')
  }
  const rest = rows.filter((mr) => mr.mrState !== 'merged')
  return `Merged: ${merged.map((mr) => mr.mrUrl).join(', ')}. Not merged: ${rest.map((mr) => withReason(mr.mrUrl, mr.mergeError)).join(', ')}.`
}

export async function postTrackerComment(
  deps: Deps,
  payload: { issueId: string; template: string; agentHandle?: string; runId?: string; body?: string; step?: string },
): Promise<void> {
  const { db } = deps
  const issue = await db<IssueRow>('issues').where({ id: payload.issueId }).first()
  if (!issue) return
  const project = await db<ProjectRow>('projects').where({ id: issue.projectId }).first()
  if (!project) return
  const run = payload.runId
    ? await db<RunRow>('runs').where({ id: payload.runId }).first()
    : await db<RunRow>('runs').where({ issueId: issue.id }).orderBy('created_at', 'desc').first()
  const connection = await trackerConnectionFor(db, issue.orgId, project.trackerConnectionId, run?.agentId)
  const template = COMMENT_TEMPLATES[payload.template]
  const links = await mergeRequestLinks(db, issue.id, payload.template)
  const text = template ? template({ body: payload.body ?? links, step: payload.step, issue, run, error: run?.error?.message }) : (payload.body ?? '')
  const handle = payload.agentHandle ?? String((run?.agentSnapshot as { handle?: string } | undefined)?.handle ?? 'factory')
  const body = formatTrackerComment(handle, text, run?.id)
  await recordEcho(db, 'linear', 'comment', issue.trackerIssueId, 'comment', body)
  await trackerFor(deps, connection).comment(issue.trackerIssueId, body)
}

/** Linear owns workflow state. If a person moved the issue since the factory last did, the factory leaves it alone. */
export async function setTrackerState(deps: Deps, payload: { issueId: string; key: TrackerStateKey }): Promise<void> {
  const { db } = deps
  const issue = await db<IssueRow>('issues').where({ id: payload.issueId }).first()
  if (!issue) return
  const project = await db<ProjectRow>('projects').where({ id: issue.projectId }).first()
  const stateId = project?.stateMap[payload.key]
  if (!project || !stateId || stateId === issue.trackerStateId) return
  if (issue.lastFactoryStateId && issue.lastFactoryStateId !== issue.trackerStateId) {
    await writeAudit(db, {
      orgId: issue.orgId,
      actorKind: 'system',
      action: 'sync.conflict',
      targetType: 'issue',
      targetId: issue.id,
      metadata: { wanted: payload.key, current: issue.trackerStateName },
    })
    return
  }
  const fresh = await writeIssueState(deps, issue, project, stateId)
  if (fresh?.stateId === stateId) {
    await emit(db, issue.orgId, {
      type: 'workflow.event',
      issueId: issue.id,
      event: { kind: 'status.changed', from: issue.trackerStateName, to: fresh.stateName },
    })
  }
}

async function writeIssueState(deps: Deps, issue: IssueRow, project: ProjectRow, stateId: string): Promise<TrackerIssue | null> {
  const { db } = deps
  const connection = await getConnection(db, issue.orgId, project.trackerConnectionId)
  await recordEcho(db, 'linear', 'issue', issue.trackerIssueId, 'state', stateId)
  const tracker = trackerFor(deps, connection)
  await tracker.updateIssueState(issue.trackerIssueId, stateId)
  const fresh = await tracker.getIssue(issue.trackerIssueId).catch(() => null)
  await db('issues')
    .where({ id: issue.id })
    .update({
      lastFactoryStateId: stateId,
      trackerStateId: stateId,
      ...(fresh?.stateId === stateId ? { trackerStateName: fresh.stateName, trackerStateType: fresh.stateType } : {}),
      updatedAt: db.fn.now(),
    })
  return fresh
}

/** A workflow names a status in words. Unlike the pipeline's moves, this is a deliberate instruction, so it applies even if a person moved the ticket. */
export async function moveIssueToStatus(deps: Deps, issue: IssueRow, statusName: string): Promise<void> {
  const project = (await deps.db<ProjectRow>('projects').where({ id: issue.projectId }).first()) as ProjectRow
  const connection = await getConnection(deps.db, issue.orgId, project.trackerConnectionId)
  const wanted = statusName.trim().toLowerCase()
  const state = (await trackerFor(deps, connection).listWorkflowStates(project.trackerTeamId)).find((item) => item.name.toLowerCase() === wanted)
  if (!state) throw new Error(`This team has no status called ${statusName}.`)
  if (state.id !== issue.trackerStateId) await writeIssueState(deps, issue, project, state.id)
}

export async function changeIssueLabel(deps: Deps, issue: IssueRow, action: 'add' | 'remove', labelName: string): Promise<void> {
  const { db } = deps
  const project = (await db<ProjectRow>('projects').where({ id: issue.projectId }).first()) as ProjectRow
  const tracker = trackerFor(deps, await getConnection(db, issue.orgId, project.trackerConnectionId))
  const wanted = labelName.trim()
  if (!wanted) throw new Error('The label name came out empty.')
  const existing = (await tracker.listLabels(project.trackerTeamId)).find((item) => item.name.toLowerCase() === wanted.toLowerCase())
  if (action === 'remove') {
    if (existing) await tracker.updateIssueLabels(issue.trackerIssueId, { remove: [existing.id] })
    if (existing)
      await db('issues')
        .where({ id: issue.id })
        .update({ labels: json(issue.labels.filter((label) => label.id !== existing.id)), updatedAt: db.fn.now() })
    return
  }
  const label = existing ?? (await tracker.createLabel({ teamId: project.trackerTeamId, name: wanted }))
  if (issue.labels.some((item) => item.id === label.id)) return
  await recordEcho(db, 'linear', 'issue', issue.trackerIssueId, 'label', label.name)
  await tracker.updateIssueLabels(issue.trackerIssueId, { add: [label.id] })
  await db('issues')
    .where({ id: issue.id })
    .update({ labels: json([...issue.labels, { id: label.id, name: label.name }]), updatedAt: db.fn.now() })
}
