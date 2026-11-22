import { type PluginPermission, signPluginPage, splitPluginValues, verifyPlugin } from '@factorix/connectors'
import { type ConnectionRow, json, type OrganizationPluginRow, type OrganizationRow, type PluginRow } from '@factorix/db'
import { pluginActivityInput, pluginCallInput, pluginInput, pluginOrganizationInput, pluginRunInput, pluginTicketInput } from '@factorix/schemas'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppDeps } from '../deps'
import { writeAudit } from '../lib/audit'
import { requireAdmin, requireAuth, requireInstallationAdmin } from '../lib/auth'
import { badRequest, conflict, HttpError, isUniqueViolation, notFound, parseBody } from '../lib/errors'
import {
  createPluginTicket,
  getPluginRun,
  getPluginTicket,
  pluginActivity,
  pluginAgents,
  pluginMembers,
  pluginProjects,
  startPluginRun,
} from '../services/plugin-api'
import { enabledPlugin, endpointOf, getPlugin, manifestOf, pluginAllows, pluginDto, readManifest, secretsOf } from '../services/plugins'
import { readSettings } from '../services/settings'

const PAGE_TTL_MS = 5 * 60_000

export function pluginRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps

  const pluginUrl = async (value: string): Promise<string> => {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('A plugin is reached over HTTP or HTTPS')
    if (url.username || url.password) throw badRequest('Leave credentials out of the address')
    // A page framed from Factorix's own address would run with a signed-in person's session.
    if (url.origin === new URL((await readSettings(deps)).publicUrl).origin)
      throw badRequest('A plugin cannot live at the address of Factorix itself')
    url.hash = ''
    return url.toString()
  }

  const usedBy = (pluginId: string, orgId?: string) =>
    db<ConnectionRow>('connections')
      .where({ kind: 'plugin', ...(orgId ? { orgId } : {}) })
      .whereRaw("config->>'pluginId' = ?", [pluginId])
      .first('id')

  app.get('/api/plugins', async (request) => {
    const { account, user } = requireAuth(request)
    const [plugins, enabled] = await Promise.all([
      db<PluginRow>('plugins').orderBy('name'),
      db<OrganizationPluginRow>('organization_plugins').where({ orgId: account.orgId }),
    ])
    const byPlugin = new Map(enabled.map((row) => [row.pluginId, row]))
    return { plugins: plugins.map((plugin) => pluginDto(plugin, byPlugin.get(plugin.id), user.installationAdmin)) }
  })

  /** What the web's content security policy lets a frame load. Only the origins, since anyone signed in can ask. */
  app.get('/api/plugins/origins', async (request) => {
    requireAuth(request)
    const plugins = await db<PluginRow>('plugins').select('url', 'pageUrl')
    return { origins: [...new Set(plugins.map((plugin) => new URL(plugin.pageUrl ?? plugin.url).origin))] }
  })

  /**
   * Caddy's on-demand TLS asks this before it requests a certificate. A bundled plugin's subdomain gets one, and every
   * other name is the preview gateway's to answer, as before plugins had pages of their own.
   */
  app.get('/__factorix/tls', async (request, reply) => {
    const domain = String((request.query as { domain?: unknown }).domain ?? '').toLowerCase()
    reply.header('cache-control', 'no-store')
    const pages = (await db<PluginRow>('plugins').whereNotNull('pageUrl').pluck('pageUrl')) as string[]
    if (domain && pages.some((page) => new URL(page).hostname === domain)) return reply.code(200).send()
    const gateway = deps.env.FACTORIX_GATEWAY_URL
    if (!domain || !gateway) return reply.code(404).send()
    const asked = await fetch(`${new URL(gateway).origin}/__factorix/tls?domain=${encodeURIComponent(domain)}`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined)
    return reply.code(asked?.status === 200 ? 200 : 404).send()
  })

  app.post('/api/plugins', async (request) => {
    const { account } = requireInstallationAdmin(request)
    const input = parseBody(pluginInput, request.body)
    const url = await pluginUrl(input.url)
    const manifest = await readManifest({ url, secret: input.secret })
    const { ciphertext, nonce, keyVersion } = deps.secrets.encrypt(input.secret)
    try {
      const [row] = await db<PluginRow>('plugins')
        .insert({ name: manifest.name, url, manifest: json(manifest) as never, secretCiphertext: ciphertext, secretNonce: nonce, keyVersion })
        .returning('*')
      await writeAudit(db, {
        orgId: account.orgId,
        actorAccountId: account.id,
        actorKind: 'human',
        action: 'plugin.installed',
        targetType: 'plugin',
        targetId: row?.id,
        metadata: { name: manifest.name, version: manifest.version, origin: new URL(url).origin },
      })
      return { plugin: pluginDto(row as PluginRow, undefined, true) }
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('That plugin is already installed')
      throw error
    }
  })

  /** Reads the manifest again, after the plugin was updated. */
  app.post('/api/plugins/:id/refresh', async (request) => {
    const { account } = requireInstallationAdmin(request)
    const plugin = await getPlugin(db, (request.params as { id: string }).id)
    const manifest = await readManifest(endpointOf(deps, plugin))
    const [row] = await db<PluginRow>('plugins')
      .where({ id: plugin.id })
      .update({ name: manifest.name, manifest: json(manifest) as never, updatedAt: db.fn.now() as never })
      .returning('*')
    const enabled = await db<OrganizationPluginRow>('organization_plugins').where({ orgId: account.orgId, pluginId: plugin.id }).first()
    return { plugin: pluginDto(row as PluginRow, enabled, true) }
  })

  app.delete('/api/plugins/:id', async (request) => {
    const { account } = requireInstallationAdmin(request)
    const plugin = await getPlugin(db, (request.params as { id: string }).id)
    if (plugin.bundled) throw conflict(`${plugin.name} comes with this installation. Each organization can turn it off instead`)
    if (await usedBy(plugin.id)) throw conflict(`A connection still uses ${plugin.name}. Remove it first`)
    await db('plugins').where({ id: plugin.id }).delete()
    await writeAudit(db, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'plugin.removed',
      targetType: 'plugin',
      targetId: plugin.id,
      metadata: { name: plugin.name },
    })
    return { ok: true }
  })

  /** An organization turns a plugin on or off for itself, and sets what the plugin asks for. */
  app.put('/api/plugins/:id/organization', async (request) => {
    const { account, user } = requireAdmin(request)
    const plugin = await getPlugin(db, (request.params as { id: string }).id)
    const input = parseBody(pluginOrganizationInput, request.body)
    const current = await db<OrganizationPluginRow>('organization_plugins').where({ orgId: account.orgId, pluginId: plugin.id }).first()
    if (!input.enabled) {
      if (await usedBy(plugin.id, account.orgId)) throw conflict(`A connection still uses ${plugin.name}. Remove it first`)
      await db('organization_plugins').where({ orgId: account.orgId, pluginId: plugin.id }).delete()
    } else {
      const manifest = manifestOf(plugin)
      const fields = manifest.settings.fields
      let values: ReturnType<typeof splitPluginValues>
      try {
        values = splitPluginValues(fields, input.settings ?? current?.config ?? {})
      } catch (error) {
        throw badRequest((error as Error).message)
      }
      const secrets = { ...(current ? secretsOf(deps, current) : {}), ...values.secrets }
      const missing = fields.find((field) => field.required && !(field.type === 'secret' ? secrets : values.config)[field.key])
      if (missing) throw badRequest(`${missing.label} is required`)
      const sealed = Object.keys(secrets).length > 0 ? deps.secrets.encrypt(JSON.stringify(secrets)) : null
      // Whoever saves has seen what the plugin asks for, so saving allows it.
      const row = {
        config: json(values.config) as never,
        permissions: manifest.permissions,
        secretCiphertext: sealed?.ciphertext ?? null,
        secretNonce: sealed?.nonce ?? null,
        ...(sealed ? { keyVersion: sealed.keyVersion } : {}),
        updatedAt: db.fn.now() as never,
      }
      await db<OrganizationPluginRow>('organization_plugins')
        .insert({ orgId: account.orgId, pluginId: plugin.id, enabledBy: account.id, ...row })
        .onConflict(['orgId', 'pluginId'])
        .merge(row)
    }
    if (!current || !input.enabled) {
      await writeAudit(db, {
        orgId: account.orgId,
        actorAccountId: account.id,
        actorKind: 'human',
        action: input.enabled ? 'plugin.enabled' : 'plugin.disabled',
        targetType: 'plugin',
        targetId: plugin.id,
        metadata: { name: plugin.name, ...(input.enabled ? { permissions: manifestOf(plugin).permissions } : {}) },
      })
    } else {
      await writeAudit(db, {
        orgId: account.orgId,
        actorAccountId: account.id,
        actorKind: 'human',
        action: 'plugin.settings_changed',
        targetType: 'plugin',
        targetId: plugin.id,
        metadata: { name: plugin.name, permissions: manifestOf(plugin).permissions },
      })
    }
    const enabled = await db<OrganizationPluginRow>('organization_plugins').where({ orgId: account.orgId, pluginId: plugin.id }).first()
    return { plugin: pluginDto(plugin, enabled, user.installationAdmin) }
  })

  /**
   * Where a plugin's page loads from, for one person and a few minutes. The page sits on the plugin's own address, so it
   * never sees Factorix's session. What it knows about the person is in the signed part of this address.
   */
  app.post('/api/plugins/:id/pages/:key/open', async (request) => {
    const { account } = requireAuth(request)
    const { id, key } = request.params as { id: string; key: string }
    const { plugin, enabled } = await enabledPlugin(db, account.orgId, id)
    const page = manifestOf(plugin).pages.find((candidate) => candidate.key === key)
    if (!page) throw notFound('Page')
    const org = await db<OrganizationRow>('organizations').where({ id: account.orgId }).first()
    const base = new URL(plugin.pageUrl ?? plugin.url)
    const url = new URL(base.origin + base.pathname.replace(/\/$/, '') + page.path)
    url.searchParams.set(
      'factorix',
      signPluginPage(endpointOf(deps, plugin).secret, {
        exp: Date.now() + PAGE_TTL_MS,
        page: page.key,
        plugin: { id: plugin.id },
        org: { id: account.orgId, name: org?.name ?? '' },
        account: { id: account.id, name: account.displayName, role: account.role },
        settings: enabled.config,
      }),
    )
    return { url: url.toString(), label: page.label }
  })

  app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))

    /** Every call a plugin makes is signed and names an organization that turned it on. Some also need a permission it was given. */
    const signed = async (request: FastifyRequest, permission?: PluginPermission) => {
      const plugin = await getPlugin(db, (request.params as { id: string }).id).catch(() => undefined)
      const rawBody = request.body as Buffer
      const header = (name: string) => [request.headers[name]].flat()[0]
      if (!plugin || !verifyPlugin(endpointOf(deps, plugin).secret, header('x-factorix-timestamp'), header('x-factorix-signature'), rawBody)) {
        throw new HttpError(401, 'bad_signature', 'Plugin signature check failed')
      }
      let body: unknown
      try {
        body = JSON.parse(rawBody.toString('utf8'))
      } catch {
        throw badRequest('The body is not JSON')
      }
      const { orgId } = (body ?? {}) as { orgId?: unknown }
      const enabled =
        typeof orgId === 'string' && /^[0-9a-f-]{36}$/i.test(orgId)
          ? await db<OrganizationPluginRow>('organization_plugins').where({ orgId, pluginId: plugin.id }).first()
          : undefined
      if (!enabled) throw notFound('Organization')
      if (permission && !pluginAllows(plugin, enabled, permission)) {
        throw new HttpError(
          403,
          'not_allowed',
          `${plugin.name} may not use ${permission} here. An admin of the organization allows it under Settings, Plugins`,
        )
      }
      return { plugin, enabled, body }
    }

    /** A plugin holds nothing between calls, so it asks for what an organization set, secrets included, and signs the question. */
    scope.post('/webhooks/plugins/:id/settings', async (request) => {
      const { enabled } = await signed(request)
      return { settings: enabled.config, secrets: secretsOf(deps, enabled) }
    })

    scope.post('/webhooks/plugins/:id/activity', async (request) => {
      const { enabled, body } = await signed(request, 'activity:read')
      return { activity: await pluginActivity(db, enabled.orgId, new Date(parseBody(pluginActivityInput, body).since)) }
    })

    scope.post('/webhooks/plugins/:id/agents', async (request) => {
      const { enabled, body } = await signed(request, 'agents:run')
      parseBody(pluginCallInput, body)
      return { agents: await pluginAgents(db, enabled.orgId) }
    })

    scope.post('/webhooks/plugins/:id/runs', async (request) => {
      const { plugin, enabled, body } = await signed(request, 'agents:run')
      return { run: await startPluginRun(deps, plugin, enabled.orgId, parseBody(pluginRunInput, body)) }
    })

    scope.post('/webhooks/plugins/:id/runs/:runId', async (request) => {
      const { plugin, enabled } = await signed(request, 'agents:run')
      return { run: await getPluginRun(deps, plugin, enabled.orgId, (request.params as { runId: string }).runId) }
    })

    scope.post('/webhooks/plugins/:id/members', async (request) => {
      const { enabled, body } = await signed(request, 'members:read')
      parseBody(pluginCallInput, body)
      return { members: await pluginMembers(db, enabled.orgId) }
    })

    scope.post('/webhooks/plugins/:id/projects', async (request) => {
      const { enabled, body } = await signed(request, 'tickets:write')
      parseBody(pluginCallInput, body)
      return { projects: await pluginProjects(db, enabled.orgId) }
    })

    scope.post('/webhooks/plugins/:id/tickets', async (request) => {
      const { plugin, enabled, body } = await signed(request, 'tickets:write')
      return { ticket: await createPluginTicket(deps, plugin, enabled.orgId, parseBody(pluginTicketInput, body)) }
    })

    scope.post('/webhooks/plugins/:id/tickets/:ticketId', async (request) => {
      const { plugin, enabled } = await signed(request, 'tickets:write')
      return { ticket: await getPluginTicket(db, plugin, enabled.orgId, (request.params as { ticketId: string }).ticketId) }
    })
  })
}
