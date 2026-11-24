import { type ConnectionRow, json } from '@factorix/db'
import { isModelProvider } from '@factorix/runtime'
import { connectionInput, connectionUpdateInput, NOTIFICATION_KINDS, ticketBoardInput } from '@factorix/schemas'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../deps'
import { connectionDto } from '../dto'
import { writeAudit } from '../lib/audit'
import { requireAdmin, requireAuth } from '../lib/auth'
import { badRequest, conflict, isForeignKeyViolation, isUniqueViolation, parseBody } from '../lib/errors'
import {
  connectionUses,
  decryptConnection,
  encodeSecret,
  getConnection,
  notifierFor,
  scmFor,
  trackerFor,
  withWebhookSecret,
} from '../services/connections'
import { secretSourceFor } from '../services/environments'
import { pluginConnectionValues, secretsOf } from '../services/plugins'
import { testModelKey } from '../services/provider-models'
import { readSettings } from '../services/settings'
import { FactorixTracker } from '../services/tickets'

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
    if (input.kind === 'plugin') Object.assign(input, await pluginConnectionValues(deps, account.orgId, input.config, input.secret))
    try {
      const [row] = await db<ConnectionRow>('connections')
        .insert({
          orgId: account.orgId,
          kind: input.kind,
          name: input.name,
          config: json(withWebhookSecret(input.kind, input.config)) as never,
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
      if (isUniqueViolation(error, 'connections_factorix')) throw conflict('This organization already has its built-in tickets')
      if (isUniqueViolation(error)) throw conflict(`A connection named ${input.name} already exists`)
      throw error
    }
  })

  app.put('/api/connections/:id', async (request) => {
    const { account } = requireAdmin(request)
    const { id } = request.params as { id: string }
    const current = await getConnection(db, account.orgId, id)
    const input = parseBody(connectionUpdateInput, request.body)
    if (current.kind === 'plugin' && input.config) {
      // Fields left blank keep their stored secret, and the plugin a connection belongs to never changes.
      const values = await pluginConnectionValues(deps, account.orgId, { ...input.config, pluginId: current.config.pluginId }, input.secret)
      input.config = values.config
      input.secret = { ...secretsOf(deps, current), ...values.secret }
    }
    const config = input.config ? withWebhookSecret(current.kind, { webhookSecret: current.config.webhookSecret, ...input.config }) : current.config
    const [row] = await db<ConnectionRow>('connections')
      .where({ id })
      .update({
        name: input.name ?? current.name,
        config: json(config) as never,
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

  app.get('/api/connections/:id/uses', async (request) => {
    const { account } = requireAdmin(request)
    return { uses: await connectionUses(db, await getConnection(db, account.orgId, (request.params as { id: string }).id)) }
  })

  app.delete('/api/connections/:id', async (request) => {
    const { account } = requireAdmin(request)
    const current = await getConnection(db, account.orgId, (request.params as { id: string }).id)
    if (current.kind === 'factorix') throw badRequest('Built-in tickets cannot be removed, since every ticket in them would go too')
    try {
      await db.transaction(async (trx) => {
        await trx('connections').where({ id: current.id }).forUpdate().first()
        const uses = await connectionUses(trx, current)
        if (uses.length > 0) throw conflict(`${current.name} is still used by ${uses.join(', ')}. Remove it from those first.`)
        await trx('connections').where({ id: current.id }).delete()
        await writeAudit(trx, {
          orgId: account.orgId,
          actorAccountId: account.id,
          actorKind: 'human',
          action: 'connection.deleted',
          targetType: 'connection',
          targetId: current.id,
          metadata: { kind: current.kind, name: current.name },
        })
      })
    } catch (error) {
      // A project made in the meantime still points at it.
      if (isForeignKeyViolation(error)) throw conflict(`${current.name} is still used by a project. Remove it from that first.`)
      throw error
    }
    return { ok: true }
  })

  app.post('/api/connections/:id/test', async (request) => {
    const { account } = requireAdmin(request)
    const connection = await getConnection(db, account.orgId, (request.params as { id: string }).id)
    try {
      if (connection.kind === 'linear' || connection.kind === 'jira' || connection.kind === 'trello' || connection.kind === 'plugin') {
        const viewer = await trackerFor(deps, connection).viewer()
        const label = { linear: 'Linear', jira: 'Jira', trello: 'Trello', plugin: 'the plugin' }[connection.kind]
        return { ok: true, message: `Connected to ${label} as ${viewer.name}` }
      }
      if (connection.kind === 'gitlab' || connection.kind === 'github') {
        const viewer = await scmFor(deps, connection).viewer()
        return { ok: true, message: `Connected to ${connection.kind === 'gitlab' ? 'GitLab' : 'GitHub'} as ${viewer.username}` }
      }
      if (connection.kind === 'slack') {
        const viewer = await notifierFor(deps, connection).viewer()
        return { ok: true, message: `Connected to Slack as ${viewer.name}` }
      }
      if (connection.kind === 'doppler') {
        const viewer = await (await secretSourceFor(deps, account.orgId, connection.id)).viewer()
        return { ok: true, message: `Connected to Doppler as ${viewer.name}` }
      }
      if (isModelProvider(connection.kind)) {
        const key = decryptConnection(deps, connection)
        if (!key) return { ok: false, message: 'This connection has no API key' }
        return { ok: true, message: await testModelKey(deps, connection.kind, key) }
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

  app.get('/api/connections/:id/people', async (request) => {
    const { account } = requireAdmin(request)
    const connection = await getConnection(db, account.orgId, (request.params as { id: string }).id)
    if (!NOTIFICATION_KINDS.includes(connection.kind as never)) throw badRequest('This connection has no people to list')
    return { people: await notifierFor(deps, connection).listPeople() }
  })

  const trackerFromQuery = async (request: { query: unknown; auth: unknown }, orgId: string) => {
    const { connectionId } = request.query as { connectionId?: string }
    if (!connectionId) throw badRequest('connectionId is required')
    return trackerFor(deps, await getConnection(db, orgId, connectionId))
  }

  app.get('/api/tracker/teams', async (request) => ({
    teams: await (await trackerFromQuery(request, requireAuth(request).account.orgId)).listTeams(),
  }))

  app.post('/api/tracker/teams', async (request) => {
    const { account } = requireAdmin(request)
    const input = parseBody(ticketBoardInput, request.body)
    const connection = await getConnection(db, account.orgId, input.connectionId)
    if (connection.kind !== 'factorix') throw badRequest('Teams of this tracker are created in the tracker itself')
    try {
      const team = await new FactorixTracker(db, connection).createBoard(input)
      await writeAudit(db, {
        orgId: account.orgId,
        actorAccountId: account.id,
        actorKind: 'human',
        action: 'ticket_board.created',
        targetType: 'connection',
        targetId: connection.id,
        metadata: { key: team.key, name: team.name },
      })
      return { team }
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(`A board with the prefix ${input.key} already exists`)
      throw error
    }
  })

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
