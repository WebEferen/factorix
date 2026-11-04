import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { TRACKER_SOURCES } from '@factorix/connectors'
import type { ApprovalRow, ConnectionRow, IssueInstructionRow, IssueRow, MrDiscussionRow, ProjectRow } from '@factorix/db'
import {
  assignIssueInput,
  ISSUE_GROUP_ORDER,
  ISSUE_SORTS,
  type IssueFilterDto,
  type IssueFilterOptionDto,
  type IssueListQuery,
  type IssueSort,
  type IssueSortDto,
  issueListQuery,
  NO_VALUE,
} from '@factorix/schemas'
import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import type { AppDeps } from '../deps'
import { approvalDto, auditDto, CLOSED_SQL, issueDto, isTrackerClosed, MERGE_REQUESTS_SQL, projectDto, RUN_LIST_COLUMNS, runDto } from '../dto'
import { writeAudit } from '../lib/audit'
import { requireAuth } from '../lib/auth'
import { conflict, notFound, parseBody } from '../lib/errors'
import { emit } from '../lib/outbox'
import { assignIssue, CLOSED_MESSAGE } from '../services/assign'
import { getConnection, trackerFor } from '../services/connections'
import { issueTextFormatters } from '../services/markup'
import { advanceIssue } from '../services/pipeline'
import { projectRepos } from '../services/repos'

const ISSUE_COLUMNS = ['issues.*', 'projects.name as project_name', 'accounts.handle as assigned_agent_handle']
const SAFE_INLINE_MEDIA = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|quicktime|ogg))$/
const STATUS_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']

function contains(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`
}

function whereValues(builder: Knex.QueryBuilder, column: string, values: string[]): void {
  if (values.length === 0) return
  const named = values.filter((value) => value !== NO_VALUE)
  builder.where((inner) => {
    inner.whereIn(column, named)
    if (named.length < values.length) inner.orWhereNull(column)
  })
}

// Work the factory has in flight stays open even after someone closes the ticket, until the pipeline has reacted.
const OPEN_SQL = `NOT (${CLOSED_SQL}) OR issues.factory_state IN ('queued', 'active', 'waiting_human', 'awaiting_merge')`
const GROUP_SQL = `CASE WHEN issues.factory_state = 'untracked' AND ${CLOSED_SQL} THEN 'closed' ELSE issues.factory_state END`

function applyScope(builder: Knex.QueryBuilder, scope: IssueListQuery['scope']): void {
  if (scope === 'open') builder.whereRaw(`(${OPEN_SQL})`)
  if (scope === 'closed') builder.whereRaw(`NOT (${OPEN_SQL})`)
}

function applyIssueFilters(builder: Knex.QueryBuilder, query: IssueListQuery): void {
  if (query.projectId) builder.where({ 'issues.project_id': query.projectId })
  applyScope(builder, query.scope)
  if (query.q) {
    const pattern = contains(query.q)
    builder.where((inner) =>
      inner.whereILike('issues.title', pattern).orWhereILike('issues.identifier', pattern).orWhereILike('issues.description', pattern),
    )
  }
  if (query.title) builder.whereILike('issues.title', contains(query.title))
  whereValues(builder, 'issues.tracker_state_name', query.status)
  whereValues(builder, 'issues.assignee_name', query.assignee)
  whereValues(builder, 'issues.author_name', query.author)
  if (query.factoryState.length > 0) builder.whereRaw(`${GROUP_SQL} = ANY(?)`, [query.factoryState])
  whereValues(builder, 'issues.assigned_agent_id', query.agentId)
  const priorities = query.priority.map(Number).filter(Number.isInteger)
  if (query.priority.length > 0) builder.whereIn('issues.priority', priorities)
  if (query.label.length > 0)
    builder.whereRaw(`EXISTS (SELECT 1 FROM jsonb_array_elements(issues.labels) AS label WHERE label->>'name' = ANY(?))`, [query.label])
}

const issueFilterScope = issueListQuery.pick({ projectId: true, scope: true })
const STATE_RANK = `CASE ${GROUP_SQL} ${ISSUE_GROUP_ORDER.map((state, rank) => `WHEN '${state}' THEN ${rank}`).join(' ')} END`
const STATUS_RANK = `CASE issues.tracker_state_type ${STATUS_ORDER.map((type, rank) => `WHEN '${type}' THEN ${rank}`).join(' ')} END`

const SORT_SQL: Record<IssueSort, string[]> = {
  updated: ['issues.updated_at'],
  created: ['COALESCE(issues.tracker_created_at, issues.created_at)'],
  // Zero means no priority, which stays after the others in both directions instead of reading as the most urgent.
  priority: ['NULLIF(issues.priority, 0)'],
  status: [STATUS_RANK, 'lower(issues.tracker_state_name)'],
  title: ['lower(issues.title)'],
  // Compared as a number, or ABC-100 would come before ABC-9.
  identifier: [`substring(issues.identifier from '^[^0-9]*')`, `substring(issues.identifier from '[0-9]+$')::numeric`],
  assignee: ['lower(issues.assignee_name)'],
  author: ['lower(issues.author_name)'],
}

export function issueRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps

  const load = async (orgId: string, id: string): Promise<IssueRow> => {
    const row = (await db('issues').where({ id, orgId }).select('issues.*', db.raw(MERGE_REQUESTS_SQL)).first()) as IssueRow | undefined
    if (!row) throw notFound('Issue')
    return row
  }

  const joined = (orgId: string) =>
    db('issues')
      .join('projects', 'issues.project_id', 'projects.id')
      .leftJoin('accounts', 'issues.assigned_agent_id', 'accounts.id')
      .where({ 'issues.org_id': orgId })
      .select(...ISSUE_COLUMNS, db.raw(MERGE_REQUESTS_SQL))

  app.get('/api/issues', async (request) => {
    const { account } = requireAuth(request)
    const query = parseBody(issueListQuery, request.query)
    const filtered = joined(account.orgId)
    applyIssueFilters(filtered, query)
    const page = filtered
      .clone()
      .limit(query.limit)
      .offset((query.page - 1) * query.limit)
    if (query.group === 'state') page.orderByRaw(STATE_RANK)
    const direction = query.direction ?? ISSUE_SORTS[query.sort]
    for (const expression of SORT_SQL[query.sort]) page.orderByRaw(`${expression} ${direction} NULLS LAST`)
    page.orderBy('issues.updated_at', 'desc').orderBy('issues.id')
    const [rows, grouped] = await Promise.all([
      page,
      filtered
        .clone()
        .clearSelect()
        .groupByRaw(GROUP_SQL)
        .select(db.raw(`${GROUP_SQL} AS issue_group`))
        .count('* as count'),
    ])
    const counts = Object.fromEntries((grouped as { issueGroup: string; count: string }[]).map((row) => [row.issueGroup, Number(row.count)]))
    return {
      // Lists never show the description, and it can run to 100 KB per row.
      issues: rows.map((row: IssueRow) => ({ ...issueDto(row), description: null })),
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      counts,
      page: query.page,
      limit: query.limit,
    }
  })

  /** Filters come from the source behind the issues, so a new tracker brings its own without touching the UI. */
  app.get('/api/issues/filters', async (request) => {
    const { account } = requireAuth(request)
    const { projectId, scope: issueScope } = parseBody(issueFilterScope, request.query)
    const scope = () => {
      const builder = db('issues').where({ 'issues.org_id': account.orgId })
      if (projectId) builder.where({ 'issues.project_id': projectId })
      applyScope(builder, issueScope)
      return builder
    }
    const kinds = (await db('projects')
      .join('connections', 'projects.tracker_connection_id', 'connections.id')
      .where({ 'projects.org_id': account.orgId, ...(projectId ? { 'projects.id': projectId } : {}) })
      .distinct('connections.kind')
      .pluck('connections.kind')) as (keyof typeof TRACKER_SOURCES)[]
    const sources = kinds.map((kind) => TRACKER_SOURCES[kind]).filter(Boolean)
    const named = async (column: string, none?: string): Promise<IssueFilterOptionDto[]> => {
      const rows = (await scope().groupBy(column).select({ value: column }).count('* as count').orderBy('count', 'desc').limit(200)) as {
        value: string | null
        count: string
      }[]
      return rows
        .map((row) => ({ value: row.value ?? NO_VALUE, label: row.value ?? (none as string), count: Number(row.count) }))
        .filter((option) => option.label)
    }
    const status = async (): Promise<IssueFilterOptionDto[]> => {
      const rows = (await scope()
        .whereNotNull('issues.tracker_state_name')
        .groupBy('issues.tracker_state_name', 'issues.tracker_state_type')
        .select({ name: 'issues.tracker_state_name', type: 'issues.tracker_state_type' })
        .count('* as count')) as { name: string; type: string; count: string }[]
      return rows
        .sort((a, b) => STATUS_ORDER.indexOf(a.type) - STATUS_ORDER.indexOf(b.type) || a.name.localeCompare(b.name))
        .map((row) => ({ value: row.name, label: row.name, count: Number(row.count), meta: row.type }))
    }
    const priority = async (): Promise<IssueFilterOptionDto[]> => {
      const labels = Object.assign({}, ...sources.map((source) => source.priorityLabels)) as Record<number, string>
      const rows = (await scope().groupBy('issues.priority').select('issues.priority').count('* as count')) as { priority: number; count: string }[]
      return rows
        .sort((a, b) => (a.priority || 9) - (b.priority || 9))
        .map((row) => ({ value: String(row.priority), label: labels[row.priority] ?? String(row.priority), count: Number(row.count) }))
    }
    const label = async (): Promise<IssueFilterOptionDto[]> => {
      const rows = (await scope()
        .joinRaw(`CROSS JOIN LATERAL jsonb_array_elements(issues.labels) AS label`)
        .whereRaw(`label->>'name' NOT IN (SELECT handle FROM accounts WHERE org_id = ? AND kind = 'agent')`, [account.orgId])
        .groupByRaw(`label->>'name'`)
        .select(db.raw(`label->>'name' AS value`))
        .count('* as count')
        .orderBy('count', 'desc')
        .limit(200)) as { value: string; count: string }[]
      return rows.map((row) => ({ value: row.value, label: row.value, count: Number(row.count) }))
    }
    const optionsFor: Record<string, () => Promise<IssueFilterOptionDto[]>> = {
      title: async () => [],
      status,
      priority,
      assignee: () => named('issues.assignee_name', 'No assignee'),
      author: () => named('issues.author_name'),
      label,
    }
    const specs = [...new Map(sources.flatMap((source) => source.issueFilters).map((spec) => [spec.key, spec])).values()]
    const sourceFilters = await Promise.all(specs.map(async (spec) => ({ ...spec, options: (await optionsFor[spec.key]?.()) ?? [] })))
    const factory = (await scope()
      .groupByRaw(GROUP_SQL)
      .select(db.raw(`${GROUP_SQL} AS issue_group`))
      .count('* as count')) as {
      issueGroup: string
      count: string
    }[]
    const agents = (await scope()
      .leftJoin('accounts', 'issues.assigned_agent_id', 'accounts.id')
      .groupBy('issues.assigned_agent_id', 'accounts.handle')
      .select({ value: 'issues.assigned_agent_id', handle: 'accounts.handle' })
      .count('* as count')
      .orderBy('count', 'desc')) as { value: string | null; handle: string | null; count: string }[]
    const filters: IssueFilterDto[] = [
      ...sourceFilters,
      {
        key: 'factoryState',
        label: 'Factory',
        kind: 'multi',
        options: ISSUE_GROUP_ORDER.flatMap((state) => {
          const row = factory.find((entry) => entry.issueGroup === state)
          return row ? [{ value: state, label: state, count: Number(row.count) }] : []
        }),
      },
      {
        key: 'agentId',
        label: 'Agent',
        kind: 'multi',
        options: agents.map((row) => ({ value: row.value ?? NO_VALUE, label: row.handle ?? 'No agent', count: Number(row.count) })),
      },
    ]
    const sorts: IssueSortDto[] = [...new Map(sources.flatMap((source) => source.issueSorts).map((spec) => [spec.key, spec])).values()]
    return { filters, sorts }
  })

  /** Linear uploads need the connection's token, which the browser must never see, so they load through here. */
  app.get('/api/issues/:id/media', async (request, reply) => {
    const { account } = requireAuth(request)
    const issue = await load(account.orgId, (request.params as { id: string }).id)
    const project = (await db<ProjectRow>('projects').where({ id: issue.projectId }).first()) as ProjectRow
    const connection = await getConnection(db, account.orgId, project.trackerConnectionId)
    const url = (request.query as { url?: string }).url ?? ''
    if (!TRACKER_SOURCES[connection.kind as keyof typeof TRACKER_SOURCES]?.markup.isMediaUrl(url)) throw notFound('File')
    const media = await trackerFor(deps, connection).fetchMedia(url, { range: request.headers.range })
    if (!media) throw notFound('File')
    const type = media.contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
    const inline = SAFE_INLINE_MEDIA.test(type)
    reply
      .status(media.status)
      .header('Content-Type', inline ? type : 'application/octet-stream')
      .header('Content-Disposition', inline ? 'inline' : 'attachment')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=3600')
      .header('Accept-Ranges', 'bytes')
    if (media.contentLength) reply.header('Content-Length', media.contentLength)
    if (media.contentRange) reply.header('Content-Range', media.contentRange)
    return reply.send(Readable.fromWeb(media.body as NodeReadableStream))
  })

  app.get('/api/issues/:id', async (request) => {
    const { account } = requireAuth(request)
    const { id } = request.params as { id: string }
    const row = await joined(account.orgId).where({ 'issues.id': id }).first()
    if (!row) throw notFound('Issue')
    const projectRow = (await db<ProjectRow>('projects').where({ id: row.projectId }).first()) as ProjectRow
    const [runs, approvals, discussions, instructions, timeline, connections, repos] = await Promise.all([
      db('runs')
        .leftJoin('issues', 'runs.issue_id', 'issues.id')
        .leftJoin('projects', 'runs.project_id', 'projects.id')
        .where({ 'runs.issue_id': id })
        .orderBy('runs.created_at', 'desc')
        .select(RUN_LIST_COLUMNS(db)),
      db('approvals')
        .leftJoin('accounts', 'approvals.decided_by', 'accounts.id')
        .where({ 'approvals.issue_id': id })
        .orderBy('approvals.requested_at', 'desc')
        .select('approvals.*', 'accounts.display_name as decided_by_name'),
      db<MrDiscussionRow>('mr_discussions').where({ issueId: id }).orderBy('created_at'),
      db<IssueInstructionRow>('issue_instructions').where({ issueId: id }).orderBy('created_at'),
      db('audit_log')
        .leftJoin('accounts', 'audit_log.actor_account_id', 'accounts.id')
        .where({ 'audit_log.target_type': 'issue', 'audit_log.target_id': id })
        .orderBy('audit_log.id', 'desc')
        .limit(100)
        .select('audit_log.*', 'accounts.display_name as actor_name'),
      db<ConnectionRow>('connections').whereIn('id', [projectRow.trackerConnectionId, projectRow.scmConnectionId]),
      projectRepos(db, projectRow.id),
    ])
    const format = await issueTextFormatters(deps, {
      orgId: account.orgId,
      issue: row,
      project: projectRow,
      repos,
      mergeRequests: row.mergeRequests,
      connections,
      texts: [row.description ?? '', ...instructions.map((instruction) => instruction.body), ...discussions.map((discussion) => discussion.body)],
    })
    return {
      issue: {
        ...issueDto(row),
        description: row.description ? format.tracker(row.description) : null,
        project: projectDto(projectRow, repos),
        runs: runs.map(runDto),
        approvals: (approvals as ApprovalRow[]).map(approvalDto),
        discussions: discussions.map((discussion) => ({
          id: discussion.id,
          repoPath: repos.find((repo) => repo.id === discussion.repoId)?.scmRepoPath ?? null,
          discussionId: discussion.discussionId,
          noteId: discussion.noteId,
          author: discussion.authorLogin,
          origin: discussion.origin,
          body: format.scm(discussion.body, discussion.repoId),
          path: discussion.path,
          line: discussion.line,
          resolved: discussion.resolved,
          createdAt: new Date(discussion.createdAt).toISOString(),
        })),
        instructions: instructions.map((instruction) => ({
          id: instruction.id,
          author: instruction.author,
          body: format.tracker(instruction.body),
          createdAt: new Date(instruction.createdAt).toISOString(),
          consumed: instruction.consumedByRunId !== null,
        })),
        timeline: timeline.map(auditDto),
      },
    }
  })

  app.post('/api/issues/:id/assign', async (request) => {
    const { account } = requireAuth(request)
    const issue = await load(account.orgId, (request.params as { id: string }).id)
    const input = parseBody(assignIssueInput, request.body)
    await assignIssue(deps, issue, input.agentId, { accountId: account.id, via: 'ui' })
    return { issue: issueDto((await load(account.orgId, issue.id)) as IssueRow) }
  })

  app.post('/api/issues/:id/retry', async (request) => {
    const { account } = requireAuth(request)
    const issue = await load(account.orgId, (request.params as { id: string }).id)
    if (isTrackerClosed(issue)) throw conflict(CLOSED_MESSAGE)
    if (!['failed', 'cancelled'].includes(issue.factoryState)) throw conflict(`An issue that is ${issue.factoryState} cannot be retried`)
    await writeAudit(db, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'issue.retried',
      targetType: 'issue',
      targetId: issue.id,
      metadata: { identifier: issue.identifier },
    })
    await advanceIssue(db, issue.id, { type: 'start' })
    return { issue: issueDto(await load(account.orgId, issue.id)) }
  })

  app.post('/api/issues/:id/cancel', async (request) => {
    const { account } = requireAuth(request)
    const issue = await load(account.orgId, (request.params as { id: string }).id)
    await writeAudit(db, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'issue.cancelled',
      targetType: 'issue',
      targetId: issue.id,
      metadata: { identifier: issue.identifier },
    })
    await advanceIssue(db, issue.id, { type: 'cancel' })
    return { issue: issueDto(await load(account.orgId, issue.id)) }
  })

  app.post('/api/issues/:id/instructions', async (request) => {
    const { account } = requireAuth(request)
    const issue = await load(account.orgId, (request.params as { id: string }).id)
    const { body } = (request.body ?? {}) as { body?: string }
    if (!body?.trim()) throw conflict('Write an instruction first')
    await db('issue_instructions').insert({ orgId: account.orgId, issueId: issue.id, source: 'ui', author: account.displayName, body: body.trim() })
    await emit(db, account.orgId, { type: 'notify', kind: 'issue', id: issue.id, projectId: issue.projectId })
    return { ok: true }
  })
}
