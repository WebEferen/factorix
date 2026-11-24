import { PACKAGE_LIMITS, type PluginPermission, signPluginPage, splitPluginValues, verifyPlugin } from '@factorix/connectors'
import {
  type ConnectionRow,
  type ContentPackRow,
  json,
  type OrganizationPluginRow,
  type OrganizationRow,
  type PluginInstanceRow,
  type PluginRow,
  type RunnerRow,
} from '@factorix/db'
import type { PluginDto } from '@factorix/schemas'
import {
  pluginActivityInput,
  pluginCallInput,
  pluginInput,
  pluginOrganizationInput,
  pluginRunInput,
  pluginStepInput,
  pluginTicketInput,
  pluginTriggerInput,
} from '@factorix/schemas'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppDeps } from '../deps'
import { writeAudit } from '../lib/audit'
import { requireAdmin, requireAuth, requireInstallationAdmin } from '../lib/auth'
import { badRequest, conflict, HttpError, isUniqueViolation, notFound, parseBody } from '../lib/errors'
import { installContentPack, listContentPacks, removeContentPack } from '../services/content-packs'
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
import { firePluginTrigger } from '../services/plugin-blocks'
import {
  inspectPluginPackage,
  installPluginPackage,
  pluginInstanceDto,
  readPackage,
  removePluginPackage,
  restartPluginPackage,
} from '../services/plugin-packages'
import { enabledPlugin, endpointOf, getPlugin, manifestOf, pluginAllows, pluginDto, readManifest, secretsOf } from '../services/plugins'
import { readSettings } from '../services/settings'
import { finishPluginStep } from '../services/workflows'

const PAGE_TTL_MS = 5 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

  /** A package belongs to the organization that uploaded it. Every other one is told it does not exist. */
  const visible = (plugin: PluginRow, orgId: string): PluginRow => {
    if (plugin.orgId && plugin.orgId !== orgId) throw notFound('Plugin')
    return plugin
  }

  const packagesOf = async (plugins: PluginRow[]): Promise<Map<string, PluginDto['package']>> => {
    const ids = plugins.flatMap((plugin) => (plugin.orgId ? [plugin.id] : []))
    if (ids.length === 0) return new Map()
    const instances = await db<PluginInstanceRow>('plugin_instances')
      .whereIn('pluginId', ids)
      .select('pluginId', 'runnerId', 'package', 'sha256', 'state', 'error', 'readyAt')
    const runnerIds = instances.flatMap((instance) => (instance.runnerId ? [instance.runnerId] : []))
    const runners = runnerIds.length > 0 ? await db<RunnerRow>('runners').whereIn('id', runnerIds).select('id', 'name') : []
    const runnerById = new Map(runners.map((runner) => [runner.id, runner]))
    return new Map(
      instances.map((instance) => [
        instance.pluginId,
        pluginInstanceDto(instance as PluginInstanceRow, instance.runnerId ? runnerById.get(instance.runnerId) : undefined),
      ]),
    )
  }

  app.get('/api/plugins', async (request) => {
    const { account, user } = requireAuth(request)
    const [plugins, enabled] = await Promise.all([
      db<PluginRow>('plugins')
        .where((query) => query.whereNull('orgId').orWhere({ orgId: account.orgId }))
        .orderBy('name'),
      db<OrganizationPluginRow>('organization_plugins').where({ orgId: account.orgId }),
    ])
    const byPlugin = new Map(enabled.map((row) => [row.pluginId, row]))
    const packages = await packagesOf(plugins)
    return {
      plugins: plugins.map((plugin) => pluginDto(plugin, byPlugin.get(plugin.id), user.installationAdmin, packages.get(plugin.id) ?? null)),
    }
  })

  /** What the web's content security policy lets a frame load. Only the origins, since anyone signed in can ask. */
  app.get('/api/plugins/origins', async (request) => {
    requireAuth(request)
    const plugins = await db<PluginRow>('plugins').select('url', 'pageUrl')
    return { origins: [...new Set(plugins.map((plugin) => new URL(plugin.pageUrl ?? plugin.url).origin))] }
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
    if (plugin.orgId) throw conflict(`${plugin.name} is an uploaded package. Restart it, or upload a new version`)
    const manifest = await readManifest(endpointOf(deps, plugin))
    const [row] = await db<PluginRow>('plugins')
      .where({ id: plugin.id })
      .update({ name: manifest.name, manifest: json(manifest) as never, updatedAt: db.fn.now() as never })
      .returning('*')
    const enabled = await db<OrganizationPluginRow>('organization_plugins').where({ orgId: account.orgId, pluginId: plugin.id }).first()
    return { plugin: pluginDto(row as PluginRow, enabled, true) }
  })

  app.delete('/api/plugins/:id', async (request) => {
    requireAuth(request)
    const plugin = await getPlugin(db, (request.params as { id: string }).id)
    if (plugin.orgId) {
      const { account } = requireAdmin(request)
      visible(plugin, account.orgId)
      if (await usedBy(plugin.id)) throw conflict(`A connection still uses ${plugin.name}. Remove it first`)
      await removePluginPackage(deps, account, plugin)
      return { ok: true }
    }
    const { account } = requireInstallationAdmin(request)
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
    const plugin = visible(await getPlugin(db, (request.params as { id: string }).id), account.orgId)
    const input = parseBody(pluginOrganizationInput, request.body)
    const current = await db<OrganizationPluginRow>('organization_plugins').where({ orgId: account.orgId, pluginId: plugin.id }).first()
    if (input.enabled && plugin.orgId) {
      const instance = await db<PluginInstanceRow>('plugin_instances').where({ pluginId: plugin.id }).first('state')
      if (instance?.state !== 'ready') throw conflict(`${plugin.name} is not running yet, so there is nothing to turn on`)
    }
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
    const packages = await packagesOf([plugin])
    return { plugin: pluginDto(plugin, enabled, user.installationAdmin, packages.get(plugin.id) ?? null) }
  })

  app.post('/api/plugins/:id/restart', async (request) => {
    const { account } = requireAdmin(request)
    const plugin = visible(await getPlugin(db, (request.params as { id: string }).id), account.orgId)
    if (!plugin.orgId) throw conflict(`${plugin.name} runs on its own server, so Factorix cannot restart it`)
    await restartPluginPackage(deps, account.orgId, plugin)
    return { ok: true }
  })

  /** A package arrives as the zip itself. Reading it runs none of it, and only installing stores it. */
  app.register(async (scope) => {
    scope.addContentTypeParser(
      ['application/zip', 'application/octet-stream'],
      { parseAs: 'buffer', bodyLimit: PACKAGE_LIMITS.archiveBytes },
      (_request, body, done) => done(null, body),
    )
    const zip = (request: FastifyRequest): Buffer => {
      if (!Buffer.isBuffer(request.body)) throw badRequest('Send the package as application/zip')
      return request.body
    }

    scope.post('/api/plugin-packages/inspect', async (request) => {
      const { account } = requireAdmin(request)
      return { package: await inspectPluginPackage(deps, account.orgId, zip(request)) }
    })

    scope.post('/api/plugin-packages', async (request) => {
      const { account, user } = requireAdmin(request)
      const archive = zip(request)
      const pkg = readPackage(archive)
      if (pkg.manifest.content) {
        const pack = await installContentPack(deps, account, pkg)
        return { contentPack: (await listContentPacks(db, account.orgId)).find((entry) => entry.id === pack.id) }
      }
      const runner = (request.query as { runner?: string }).runner || null
      if (runner && !UUID.test(runner)) throw badRequest('That runner is not in this organization')
      const plugin = await installPluginPackage(deps, account, pkg, archive, runner)
      const enabled = await db<OrganizationPluginRow>('organization_plugins').where({ orgId: account.orgId, pluginId: plugin.id }).first()
      const packages = await packagesOf([plugin])
      return { plugin: pluginDto(plugin, enabled, user.installationAdmin, packages.get(plugin.id) ?? null) }
    })
  })

  app.get('/api/content-packs', async (request) => {
    const { account } = requireAuth(request)
    return { contentPacks: await listContentPacks(db, account.orgId) }
  })

  app.delete('/api/content-packs/:id', async (request) => {
    const { account } = requireAdmin(request)
    const { id } = request.params as { id: string }
    const pack = UUID.test(id) ? await db<ContentPackRow>('content_packs').where({ id, orgId: account.orgId }).first() : undefined
    if (!pack) throw notFound('Content pack')
    return { kept: await removeContentPack(deps, account, pack) }
  })

  /**
   * Where a plugin's page loads from, for one person and a few minutes. The page sits on the plugin's own address, or
   * for a bundled plugin under Factorix's with a sandbox policy, so it never sees Factorix's session. What it knows
   * about the person is in the signed part of this address.
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
          `${plugin.name} may not use ${permission} here. An admin of the organization allows it under Integrations, Plugins`,
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

    scope.post('/webhooks/plugins/:id/workflow-steps', async (request) => {
      const { plugin, enabled, body } = await signed(request, 'workflows:blocks')
      await finishPluginStep(db, plugin.id, enabled.orgId, parseBody(pluginStepInput, body))
      return { ok: true }
    })

    scope.post('/webhooks/plugins/:id/workflow-triggers', async (request) => {
      const { plugin, enabled, body } = await signed(request, 'workflows:blocks')
      return { started: await firePluginTrigger(db, plugin.id, enabled.orgId, parseBody(pluginTriggerInput, body)) }
    })
  })
}
