import { type ConnectionRow, json } from '@factorix/db'
import { connectionInput, connectionUpdateInput, NOTIFICATION_KINDS } from '@factorix/schemas'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../deps'
import { connectionDto } from '../dto'
import { writeAudit } from '../lib/audit'
import { requireAdmin, requireAuth } from '../lib/auth'
import { badRequest, conflict, isUniqueViolation, parseBody } from '../lib/errors'
import { encodeSecret, getConnection, notifierFor, scmFor, trackerFor, withWebhookSecret } from '../services/connections'
import { readSettings } from '../services/settings'

export function connectionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps

  app.get('/api/connections', async (request) => {
    const { account } = requireAuth(request)
    const rows = await db<ConnectionRow>('connections').where({ orgId: account.orgId }).orderBy('name')
    const { publicUrl } = await readSettings(deps)
    return { connections: rows.map((row) => connectionDto(row, publicUrl, account.role === 'admin')) }
  })

  app.post('/api/connections', async (request) => {
    const { account } = requireAdmin(request)
    const input = parseBody(connectionInput, request.body)
    try {
      const [row] = await db<ConnectionRow>('connections')
        .insert({
          orgId: account.orgId,
          kind: input.kind,
          name: input.name,
          config: json(withWebhookSecret(input.kind, input.config)) as never,
          agentVisible: input.agentVisible,
          createdBy: account.id,
          ...encodeSecret(deps, input.secret),
        })
        .returning('*')
      await writeAudit(db, {
        orgId: account.orgId,
        actorAccountId: account.id,
        actorKind: 'human',
        action: 'connection.created',
        targetType: 'connection',
        targetId: row?.id,
        metadata: { kind: input.kind, name: input.name },
      })
      return { connection: connectionDto(row as ConnectionRow, (await readSettings(deps)).publicUrl, true) }
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(`A connection named ${input.name} already exists`)
      throw error
    }
  })

  app.put('/api/connections/:id', async (request) => {
    const { account } = requireAdmin(request)
    const { id } = request.params as { id: string }
    const current = await getConnection(db, account.orgId, id)
    const input = parseBody(connectionUpdateInput, request.body)
    const config = input.config ? withWebhookSecret(current.kind, { webhookSecret: current.config.webhookSecret, ...input.config }) : current.config
    const [row] = await db<ConnectionRow>('connections')
      .where({ id })
      .update({
        name: input.name ?? current.name,
        config: json(config) as never,
        agentVisible: input.agentVisible ?? current.agentVisible,
        updatedAt: db.fn.now() as never,
        ...encodeSecret(deps, input.secret),
      })
      .returning('*')
    await writeAudit(db, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'connection.updated',
      targetType: 'connection',
      targetId: id,
      metadata: { secretChanged: input.secret !== undefined },
    })
    return { connection: connectionDto(row as ConnectionRow, (await readSettings(deps)).publicUrl, true) }
  })

  app.post('/api/connections/:id/test', async (request) => {
    const { account } = requireAdmin(request)
    const connection = await getConnection(db, account.orgId, (request.params as { id: string }).id)
    try {
      if (connection.kind === 'linear') {
        const viewer = await trackerFor(deps, connection).viewer()
        return { ok: true, message: `Connected to Linear as ${viewer.name}` }
      }
      if (connection.kind === 'gitlab') {
        const viewer = await scmFor(deps, connection).viewer()
        return { ok: true, message: `Connected to GitLab as ${viewer.username}` }
      }
      if (connection.kind === 'slack') {
        const viewer = await notifierFor(deps, connection).viewer()
        return { ok: true, message: `Connected to Slack as ${viewer.name}` }
      }
      return { ok: true, message: 'Nothing to test for this kind of connection yet' }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })

  app.get('/api/connections/:id/channels', async (request) => {
    const { account } = requireAdmin(request)
    const connection = await getConnection(db, account.orgId, (request.params as { id: string }).id)
    if (!NOTIFICATION_KINDS.includes(connection.kind as never)) throw badRequest('This connection has no channels')
    return { channels: await notifierFor(deps, connection).listChannels() }
  })

  const trackerFromQuery = async (request: { query: unknown; auth: unknown }, orgId: string) => {
    const { connectionId } = request.query as { connectionId?: string }
    if (!connectionId) throw badRequest('connectionId is required')
    return trackerFor(deps, await getConnection(db, orgId, connectionId))
  }

  app.get('/api/tracker/teams', async (request) => ({
    teams: await (await trackerFromQuery(request, requireAuth(request).account.orgId)).listTeams(),
  }))

  app.get('/api/tracker/projects', async (request) => {
    const { teamId } = request.query as { teamId?: string }
    if (!teamId) throw badRequest('teamId is required')
    return { projects: await (await trackerFromQuery(request, requireAuth(request).account.orgId)).listProjects(teamId) }
  })

  app.get('/api/tracker/states', async (request) => {
    const { teamId } = request.query as { teamId?: string }
    if (!teamId) throw badRequest('teamId is required')
    return { states: await (await trackerFromQuery(request, requireAuth(request).account.orgId)).listWorkflowStates(teamId) }
  })

  app.get('/api/scm/repos', async (request) => {
    const { account } = requireAuth(request)
    const { connectionId, search } = request.query as { connectionId?: string; search?: string }
    if (!connectionId) throw badRequest('connectionId is required')
    return { repos: await scmFor(deps, await getConnection(db, account.orgId, connectionId)).listRepos(search) }
  })
}
