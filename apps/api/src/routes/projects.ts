import { BUILTIN_PIPELINE_NAME } from '@factorix/core'
import { type ConnectionRow, type IssueRow, json, type PipelineRow, type ProjectRepoRow, type ProjectRow } from '@factorix/db'
import { createIssueInput, projectInput, projectUpdateInput } from '@factorix/schemas'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../deps'
import { CLOSED_SQL, issueDto, projectDto } from '../dto'
import { writeAudit } from '../lib/audit'
import { requireAdmin, requireAuth } from '../lib/auth'
import { conflict, isUniqueViolation, notFound, parseBody } from '../lib/errors'
import { emit } from '../lib/outbox'
import { getConnection, scmFor, trackerFor } from '../services/connections'
import { recordEcho } from '../services/echo'
import { advanceIssue } from '../services/pipeline'
import { projectRepos, saveProjectRepos } from '../services/repos'
import { IMPORT_STALE_MS, requestProjectImport, upsertIssueMirror } from '../services/tracker-sync'

export async function getProject(deps: Pick<AppDeps, 'db'>, orgId: string, id: string): Promise<ProjectRow> {
  const row = await deps.db<ProjectRow>('projects').where({ id, orgId }).first()
  if (!row) throw notFound('Project')
  return row
}

export function projectRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps

  const withStats = async (rows: ProjectRow[], accountId: string) => {
    const ids = rows.map((row) => row.id)
    const [counts, fresh, spend, repos] = await Promise.all([
      db('issues')
        .whereIn('projectId', ids)
        .groupBy('projectId')
        .select(
          'projectId',
          db.raw('COUNT(*) AS total'),
          db.raw(`COUNT(*) FILTER (WHERE factory_state IN ('queued', 'active', 'waiting_human', 'awaiting_merge')) AS active`),
        ),
      db('issues')
        .join('projects', 'issues.project_id', 'projects.id')
        .leftJoin('project_reads', (join) => join.on('project_reads.project_id', 'issues.project_id').andOnVal('project_reads.account_id', accountId))
        .whereIn('issues.project_id', ids)
        .whereRaw('issues.announced_at > COALESCE(project_reads.seen_at, projects.created_at)')
        .whereRaw(`NOT (${CLOSED_SQL})`)
        .groupBy('issues.project_id')
        .select('issues.project_id')
        .count('* as count'),
      db('runs')
        .whereIn('projectId', ids)
        .andWhere('created_at', '>=', db.raw(`date_trunc('month', now())`))
        .groupBy('projectId')
        .select('projectId')
        .sum('cost_usd as spend'),
      db<ProjectRepoRow>('project_repos').whereIn('projectId', ids).orderBy('position'),
    ])
    return rows.map((row) => {
      const count = (counts as unknown as { projectId: string; total: string; active: string }[]).find((entry) => entry.projectId === row.id)
      const cost = (spend as unknown as { projectId: string; spend: string | null }[]).find((entry) => entry.projectId === row.id)
      return projectDto(
        row,
        repos.filter((repo) => repo.projectId === row.id),
        {
          issueCount: Number(count?.total ?? 0),
          activeIssueCount: Number(count?.active ?? 0),
          newIssueCount: Number((fresh as unknown as { projectId: string; count: string }[]).find((entry) => entry.projectId === row.id)?.count ?? 0),
          spendThisMonthUsd: Number(cost?.spend ?? 0),
        },
      )
    })
  }

  app.get('/api/projects', async (request) => {
    const { account } = requireAuth(request)
    return { projects: await withStats(await db<ProjectRow>('projects').where({ orgId: account.orgId }).orderBy('name'), account.id) }
  })

  app.get('/api/projects/:id', async (request) => {
    const { account } = requireAuth(request)
    const [project] = await withStats([await getProject(deps, account.orgId, (request.params as { id: string }).id)], account.id)
    return { project }
  })

  app.post('/api/projects', async (request) => {
    const { account } = requireAdmin(request)
    const { repos, ...input } = parseBody(projectInput, request.body)
    await getConnection(db, account.orgId, input.trackerConnectionId)
    await getConnection(db, account.orgId, input.scmConnectionId)
    const pipeline = await db<PipelineRow>('pipelines')
      .where({ orgId: account.orgId, name: BUILTIN_PIPELINE_NAME })
      .orderBy('version', 'desc')
      .first()
    if (!pipeline) throw notFound('Pipeline')
    try {
      const project = await db.transaction(async (trx) => {
        const [row] = await trx<ProjectRow>('projects')
          .insert({
            ...input,
            orgId: account.orgId,
            pipelineId: pipeline.id,
            stateMap: json(input.stateMap) as never,
            trigger: json(input.trigger) as never,
            networkAllowlist: json(input.networkAllowlist) as never,
          })
          .returning('*')
        const created = row as ProjectRow
        await saveProjectRepos(trx, created, repos)
        await writeAudit(trx, {
          orgId: account.orgId,
          actorAccountId: account.id,
          actorKind: 'human',
          action: 'project.created',
          targetType: 'project',
          targetId: created.id,
          metadata: { name: input.name, autonomy: input.autonomy, repos: repos.map((repo) => repo.scmRepoPath) },
        })
        await requestProjectImport(trx, created)
        return created
      })
      const [fresh] = await withStats([await getProject(deps, account.orgId, project.id)], account.id)
      return { project: fresh }
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('A project with that name, or for that tracker team and project, already exists')
      throw error
    }
  })

  app.put('/api/projects/:id', async (request) => {
    const { account } = requireAdmin(request)
    const { id } = request.params as { id: string }
    const existing = await getProject(deps, account.orgId, id)
    const { repos, ...input } = parseBody(projectUpdateInput, request.body)
    const patch: Record<string, unknown> = { ...input, updatedAt: db.fn.now() }
    if (input.stateMap) patch.stateMap = json(input.stateMap)
    if (input.trigger) patch.trigger = json(input.trigger)
    if (input.networkAllowlist) patch.networkAllowlist = json(input.networkAllowlist)
    await db.transaction(async (trx) => {
      await trx('projects').where({ id }).update(patch)
      if (repos) await saveProjectRepos(trx, existing, repos)
      await writeAudit(trx, {
        orgId: account.orgId,
        actorAccountId: account.id,
        actorKind: 'human',
        action: 'project.updated',
        targetType: 'project',
        targetId: id,
        metadata: { fields: [...Object.keys(input), ...(repos ? ['repos'] : [])] },
      })
    })
    const [project] = await withStats([await getProject(deps, account.orgId, id)], account.id)
    return { project }
  })

  app.post('/api/projects/:id/sync', async (request) => {
    const { account } = requireAuth(request)
    const project = await getProject(deps, account.orgId, (request.params as { id: string }).id)
    const running =
      project.syncState === 'syncing' && project.syncHeartbeatAt && Date.now() - new Date(project.syncHeartbeatAt).getTime() < IMPORT_STALE_MS
    if (!running) await db.transaction((trx) => requestProjectImport(trx, project))
    const [fresh] = await withStats([await getProject(deps, account.orgId, project.id)], account.id)
    return { project: fresh }
  })

  app.post('/api/projects/:id/webhooks', async (request) => {
    const { account } = requireAdmin(request)
    const project = await getProject(deps, account.orgId, (request.params as { id: string }).id)
    const publicUrl = deps.env.FACTORIX_PUBLIC_URL.replace(/\/$/, '')
    const register = async (connection: ConnectionRow, run: (url: string, secret: string) => Promise<unknown>) => {
      const url = `${publicUrl}/webhooks/${connection.kind}/${connection.id}`
      const secret = String(connection.config.webhookSecret ?? '')
      try {
        await run(url, secret)
        return { kind: connection.kind, registered: true, url, secret }
      } catch (error) {
        return { kind: connection.kind, registered: false, url, secret, error: (error as Error).message }
      }
    }
    const tracker = await getConnection(db, account.orgId, project.trackerConnectionId)
    const scm = await getConnection(db, account.orgId, project.scmConnectionId)
    const results = await Promise.all([
      register(tracker, (url, secret) => trackerFor(deps, tracker).registerWebhook({ teamId: project.trackerTeamId, url, secret })),
      ...(await projectRepos(db, project.id)).map(async (repo) => ({
        ...(await register(scm, (url, secret) => scmFor(deps, scm).registerWebhook(repo.scmRepoId, { url, secret }))),
        repoPath: repo.scmRepoPath,
      })),
    ])
    await writeAudit(db, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'project.webhooks_registered',
      targetType: 'project',
      targetId: project.id,
      metadata: { results: results.map(({ kind, registered }) => ({ kind, registered })) },
    })
    return { results }
  })

  app.post('/api/projects/:id/seen', async (request) => {
    const { account } = requireAuth(request)
    const project = await getProject(deps, account.orgId, (request.params as { id: string }).id)
    await db('project_reads')
      .insert({ accountId: account.id, projectId: project.id, orgId: account.orgId })
      .onConflict(['account_id', 'project_id'])
      .merge({ seenAt: db.fn.now() })
    return { ok: true }
  })

  app.post('/api/projects/:id/issues', async (request) => {
    const { account } = requireAuth(request)
    const project = await getProject(deps, account.orgId, (request.params as { id: string }).id)
    const input = parseBody(createIssueInput, request.body)
    const connection = await getConnection(db, account.orgId, project.trackerConnectionId)
    const tracker = trackerFor(deps, connection)

    let handle: string | null = null
    if (input.assignAgentId) {
      const agent = await db('accounts').where({ id: input.assignAgentId, orgId: account.orgId, kind: 'agent' }).first()
      if (!agent) throw notFound('Agent')
      handle = agent.handle
    }
    const labelId = handle ? project.agentLabels[handle] : undefined
    await recordEcho(db, 'linear', 'issue', 'create', 'title', input.title)
    const created = await tracker.createIssue({
      teamId: project.trackerTeamId,
      projectId: project.trackerProjectId,
      title: input.title,
      description: input.description,
      priority: input.priority,
      labelIds: labelId ? [labelId] : undefined,
    })
    const { row } = await upsertIssueMirror(deps, project, created)
    await writeAudit(db, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'issue.created',
      targetType: 'issue',
      targetId: row.id,
      metadata: { identifier: created.identifier, assignedTo: handle },
    })
    await emit(db, account.orgId, { type: 'workflow.event', issueId: row.id, event: { kind: 'issue.created' } })
    if (input.assignAgentId) {
      await db('issues').where({ id: row.id }).update({ assignedAgentId: input.assignAgentId })
      await advanceIssue(db, row.id, { type: 'start' })
    }
    const issue = await db<IssueRow>('issues').where({ id: row.id }).first()
    return { issue: issueDto(issue as IssueRow) }
  })
}
