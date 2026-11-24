import { createHmac, randomBytes } from 'node:crypto'
import {
  checkServedManifest,
  fetchPluginManifest,
  PACKAGE_PORT,
  PLUGIN_PERMISSIONS,
  type PluginPackage,
  packageArchive,
  packagedPluginManifest,
  packageUrls,
  parsePackageManifest,
  readPluginPackage,
} from '@factorix/connectors'
import { type AccountRow, json, type PackageSource, type PluginInstanceRow, type PluginRow, type RunnerRow } from '@factorix/db'
import { environmentDataVolume, type SandboxProvider, serviceContainerName } from '@factorix/sandbox'
import type { PluginInstanceDto, PluginPackageDto } from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { packageSourceDto } from '../dto'
import { writeAudit } from '../lib/audit'
import { pluginKeys, previewKeys, proxyTokenKey } from '../lib/channels'
import { badRequest, conflict } from '../lib/errors'
import { emit } from '../lib/outbox'
import { inspectContentPack } from './content-packs'
import { environmentProxyEnv, revokeProxyGrant, waitUntilReady } from './environment-runtime'
import { endpointOf } from './plugins'
import { GATEWAY_ALIAS } from './preview-runner'
import { newSlug } from './previews'
import { readSettings } from './settings'

type Deps = Pick<AppDeps, 'db' | 'env' | 'redis' | 'secrets'>
type WorkerDeps = Pick<AppDeps, 'db' | 'env' | 'redis' | 'secrets' | 'queues'> & { sandbox: SandboxProvider }

/** A running package's egress grant outlives a few missed sweeps, and each sweep renews it. */
const GRANT_TTL_SECONDS = 24 * 3600
const READY_SECONDS = 120
const STUCK_MS = 15 * 60_000
const LOCK_MS = 10 * 60_000
const DATABASE_IMAGE = 'postgres:17'
const PORT_CHECK = `node -e "require('net').connect(${PACKAGE_PORT},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function readPackage(archive: Buffer): PluginPackage {
  try {
    return readPluginPackage(archive)
  } catch (error) {
    throw badRequest((error as Error).message)
  }
}

async function packagePlugin(deps: Pick<AppDeps, 'db'>, orgId: string, name: string) {
  const plugin = await deps.db<PluginRow>('plugins').where({ orgId, name }).first()
  const instance = plugin ? await deps.db<PluginInstanceRow>('plugin_instances').where({ pluginId: plugin.id }).first() : undefined
  return { plugin, instance }
}

export function pluginPackageDto(
  pkg: PluginPackage,
  current: { version: string; adds: PluginPackageDto['adds'] } | null,
  items: PluginPackageDto['items'],
  source: PackageSource | null,
): PluginPackageDto {
  const { manifest } = pkg
  return {
    kind: manifest.content ? 'content' : 'plugin',
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? null,
    publisher: manifest.publisher ?? null,
    permissions: manifest.permissions.map((id) => ({ id, description: PLUGIN_PERMISSIONS[id] })),
    egress: manifest.egress,
    database: manifest.database,
    memoryMb: manifest.memoryMb,
    files: pkg.files.size,
    size: pkg.size,
    sha256: pkg.sha256,
    replaces: current?.version ?? null,
    adds: current?.adds ?? null,
    items,
    source: packageSourceDto(source),
  }
}

export function pluginInstanceDto(instance: PluginInstanceRow, runner: Pick<RunnerRow, 'id' | 'name'> | undefined): PluginInstanceDto {
  const manifest = parsePackageManifest(instance.package)
  return {
    state: instance.state,
    error: instance.error,
    version: manifest.version,
    sha256: instance.sha256,
    database: manifest.database,
    egress: manifest.egress,
    runner: runner ? { id: runner.id, name: runner.name } : null,
    readyAt: instance.readyAt?.toISOString() ?? null,
    source: packageSourceDto(instance.source),
  }
}

/** What a package asks for, read without storing or running any of it. */
export async function inspectPluginPackage(
  deps: Pick<AppDeps, 'db'>,
  orgId: string,
  pkg: PluginPackage,
  source: PackageSource | null,
): Promise<PluginPackageDto> {
  if (pkg.manifest.content) {
    const { replaces, items } = await inspectContentPack(deps, orgId, pkg)
    return pluginPackageDto(pkg, replaces ? { version: replaces, adds: null } : null, items, source)
  }
  const { instance } = await packagePlugin(deps, orgId, pkg.manifest.name)
  if (!instance) return pluginPackageDto(pkg, null, [], source)
  const current = parsePackageManifest(instance.package)
  const adds = {
    permissions: pkg.manifest.permissions.filter((permission) => !current.permissions.includes(permission)),
    egress: pkg.manifest.egress.filter((host) => !current.egress.includes(host)),
    database: pkg.manifest.database && !current.database,
  }
  return pluginPackageDto(pkg, { version: current.version, adds }, [], source)
}

/**
 * Installs a package for the admin's organization, or replaces the one of the same name it runs now. A replacement keeps
 * its machine, database, settings, and what the admin allowed, so a permission the new version adds waits for them.
 */
export async function installPluginPackage(
  deps: Deps,
  account: AccountRow,
  pkg: PluginPackage,
  archive: Buffer,
  runnerId: string | null,
  source: PackageSource | null,
): Promise<PluginRow> {
  const { db, env } = deps
  if (!env.FACTORIX_PACKAGES_INTERNAL_URL) throw conflict('This installation has no package gateway. Set FACTORIX_PACKAGES_INTERNAL_URL')
  const { manifest } = pkg
  const runner = runnerId ? await db<RunnerRow>('runners').where({ id: runnerId, orgId: account.orgId }).first() : undefined
  if (runnerId && !runner) throw badRequest('That runner is not in this organization')
  const existing = await packagePlugin(deps, account.orgId, manifest.name)
  if (existing.instance?.state === 'removing') throw conflict(`${manifest.name} is being removed. Upload it again once it is gone`)

  const plugin = await db.transaction(async (trx) => {
    let row: PluginRow
    if (existing.plugin && existing.instance) {
      row = existing.plugin
      await trx('plugin_instances')
        .where({ pluginId: row.id })
        .update({
          package: json(manifest) as never,
          archive,
          sha256: pkg.sha256,
          source: source ? (json(source) as never) : null,
          state: 'starting',
          error: null,
          uploadedBy: account.id,
          updatedAt: trx.fn.now() as never,
        })
    } else {
      let slug = newSlug()
      while ((await trx('plugin_instances').where({ slug }).first('slug')) || (await trx('environment_instances').where({ slug }).first('slug')))
        slug = newSlug()
      const { url, pageUrl } = packageUrls(slug, env.FACTORIX_PACKAGES_INTERNAL_URL as string, (await readSettings(deps)).publicUrl)
      const sealed = deps.secrets.encrypt(randomBytes(32).toString('hex'))
      const [inserted] = await trx<PluginRow>('plugins')
        .insert({
          name: manifest.name,
          url,
          pageUrl,
          orgId: account.orgId,
          manifest: json(packagedPluginManifest(manifest)) as never,
          secretCiphertext: sealed.ciphertext,
          secretNonce: sealed.nonce,
          keyVersion: sealed.keyVersion,
        })
        .returning('*')
      row = inserted as PluginRow
      await trx('plugin_instances').insert({
        pluginId: row.id,
        orgId: account.orgId,
        slug,
        runnerId: runner?.id ?? null,
        package: json(manifest) as never,
        archive,
        sha256: pkg.sha256,
        source: source ? (json(source) as never) : null,
        state: 'starting',
        uploadedBy: account.id,
      })
    }
    await emit(trx, account.orgId, { type: 'plugin.action', pluginId: row.id, action: 'start' })
    await writeAudit(trx, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'plugin.uploaded',
      targetType: 'plugin',
      targetId: row.id,
      metadata: {
        name: manifest.name,
        version: manifest.version,
        sha256: pkg.sha256,
        permissions: manifest.permissions,
        egress: manifest.egress,
        source,
      },
    })
    return row
  })
  return plugin
}

export async function restartPluginPackage(deps: Pick<AppDeps, 'db'>, orgId: string, plugin: PluginRow): Promise<void> {
  await deps.db.transaction(async (trx) => {
    const updated = await trx('plugin_instances')
      .where({ pluginId: plugin.id })
      .whereNot({ state: 'removing' })
      .update({ state: 'starting', error: null, updatedAt: trx.fn.now() })
    if (!updated) throw conflict(`${plugin.name} is being removed`)
    await emit(trx, orgId, { type: 'plugin.action', pluginId: plugin.id, action: 'start' })
  })
}

/** Nothing reaches it once its organization row is gone, and the worker removes its environment, data, and then the plugin. */
export async function removePluginPackage(deps: Pick<AppDeps, 'db'>, account: AccountRow, plugin: PluginRow): Promise<void> {
  await deps.db.transaction(async (trx) => {
    await trx('organization_plugins').where({ pluginId: plugin.id }).delete()
    await trx('plugin_instances').where({ pluginId: plugin.id }).update({ state: 'removing', updatedAt: trx.fn.now() })
    await emit(trx, account.orgId, { type: 'plugin.action', pluginId: plugin.id, action: 'remove' })
    await writeAudit(trx, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'plugin.removed',
      targetType: 'plugin',
      targetId: plugin.id,
      metadata: { name: plugin.name },
    })
  })
}

async function withLock(deps: Pick<AppDeps, 'redis'>, pluginId: string, work: () => Promise<void>): Promise<void> {
  const token = randomBytes(8).toString('hex')
  const deadline = Date.now() + LOCK_MS
  while (!(await deps.redis.set(pluginKeys.lock(pluginId), token, 'PX', LOCK_MS, 'NX'))) {
    if (Date.now() > deadline) throw new Error('Another worker has held this plugin for too long')
    await sleep(2000)
  }
  try {
    await work()
  } finally {
    if ((await deps.redis.get(pluginKeys.lock(pluginId))) === token) await deps.redis.del(pluginKeys.lock(pluginId))
  }
}

async function startInstance(deps: WorkerDeps, plugin: PluginRow, instance: PluginInstanceRow): Promise<void> {
  const { db, env, redis, sandbox } = deps
  const { manifest, files } = readPluginPackage(instance.archive)
  if (!manifest.entry) throw new Error('This package has no server to run')
  const { slug } = instance
  const labels = { 'factorix.plugin': plugin.id }
  const settings = await readSettings(deps)
  const environment = await sandbox.ensureEnvironment(slug, { internal: Boolean(env.FACTORIX_PROXY_URL), labels })
  await sandbox.stopEnvironment(slug, ['app', 'db'])
  await sandbox.writeEnvironmentSource(slug, packageArchive(files))
  const secret = endpointOf(deps, plugin).secret
  const proxy = await environmentProxyEnv(deps, {
    environment,
    services: manifest.database ? ['app', 'db'] : ['app'],
    bypass: [],
    grant: { orgId: instance.orgId },
    allow: [...manifest.egress, new URL(settings.publicUrl).hostname],
    ttlSeconds: GRANT_TTL_SECONDS,
  })
  const database: Record<string, string> = {}
  if (manifest.database) {
    // Only its own app shares the network, so the password is derived rather than stored, and never leaves the worker.
    const password = createHmac('sha256', secret).update('factorix-plugin-database').digest('hex')
    const id = await sandbox.startService(environment, {
      service: 'db',
      image: DATABASE_IMAGE,
      repoCode: false,
      env: { POSTGRES_USER: 'plugin', POSTGRES_PASSWORD: password, POSTGRES_DB: 'plugin' },
      mounts: [{ volume: environmentDataVolume(slug, 'db'), target: '/var/lib/postgresql/data', readOnly: false }],
      healthcheck: 'pg_isready -U plugin -d plugin -h 127.0.0.1',
      limits: { memoryBytes: 512 * 1024 ** 2, cpus: 1, pids: 256 },
      labels,
    })
    await waitUntilReady(sandbox, id, { name: 'db', timeoutSeconds: READY_SECONDS })
    database.DATABASE_URL = `postgres://plugin:${password}@db:5432/plugin`
  }
  if (!(await sandbox.joinEnvironment(environment, 'gateway', GATEWAY_ALIAS))) {
    throw new Error(
      environment.runner
        ? 'Its runner has no preview tunnel, so Factorix cannot reach it. Update the runner with docker compose -f docker-compose.runner.yml up -d --build.'
        : 'No preview gateway is running, so Factorix cannot reach it. Start the preview-gateway service.',
    )
  }
  const containerId = await sandbox.startService(environment, {
    service: 'app',
    repoCode: true,
    script: `exec node /plugin/${manifest.entry}`,
    workdir: '/plugin',
    env: {
      ...proxy,
      ...database,
      PLUGIN_SECRET: secret,
      PORT: String(PACKAGE_PORT),
      HOST: '0.0.0.0',
      FACTORIX_URL: new URL(settings.publicUrl).origin,
      NODE_ENV: 'production',
      HOME: '/tmp',
    },
    mounts: [{ volume: environment.sourceVolume, target: '/plugin', readOnly: true }],
    healthcheck: PORT_CHECK,
    limits: { memoryBytes: manifest.memoryMb * 1024 ** 2, cpus: 1, pids: 256 },
    labels,
  })
  await db('plugin_instances').where({ pluginId: plugin.id }).update({ containerId, updatedAt: db.fn.now() })
  await waitUntilReady(sandbox, containerId, { name: 'app', timeoutSeconds: READY_SECONDS })
  await redis.set(pluginKeys.route(slug), JSON.stringify({ host: serviceContainerName(slug, 'app'), port: PACKAGE_PORT, runner: environment.runner }))

  const urls = packageUrls(slug, env.FACTORIX_PACKAGES_INTERNAL_URL as string, settings.publicUrl)
  const served = await fetchPluginManifest({ url: urls.url, secret })
  checkServedManifest(manifest, served)
  await db.transaction(async (trx) => {
    await trx('plugins')
      .where({ id: plugin.id })
      .update({ ...urls, manifest: json(served) as never, updatedAt: trx.fn.now() })
    await trx('plugin_instances')
      .where({ pluginId: plugin.id, sha256: instance.sha256 })
      .whereNot({ state: 'removing' })
      .update({ state: 'ready', error: null, readyAt: trx.fn.now(), updatedAt: trx.fn.now() })
  })
}

async function removeInstance(deps: WorkerDeps, instance: PluginInstanceRow): Promise<void> {
  const { db, redis, sandbox } = deps
  await sandbox.stopEnvironment(instance.slug)
  await sandbox.removeEnvironmentVolumes(instance.slug, { source: true })
  await revokeProxyGrant(redis, instance.slug)
  await redis.del(pluginKeys.route(instance.slug))
  await db('plugins').where({ id: instance.pluginId }).delete()
}

/** Runs in the worker, one action at a time per plugin. A start that fails is recorded on the plugin, for its admin to see. */
export async function runPluginAction(deps: WorkerDeps, pluginId: string, action: 'start' | 'remove'): Promise<void> {
  await withLock(deps, pluginId, async () => {
    const instance = await deps.db<PluginInstanceRow>('plugin_instances').where({ pluginId }).first()
    const plugin = await deps.db<PluginRow>('plugins').where({ id: pluginId }).first()
    if (!instance || !plugin) return
    if (instance.state === 'removing') return removeInstance(deps, instance)
    if (action !== 'start') return
    try {
      await startInstance(deps, plugin, instance)
    } catch (error) {
      await deps
        .db('plugin_instances')
        .where({ pluginId, sha256: instance.sha256, state: 'starting' })
        .update({ state: 'failed', error: (error as Error).message.slice(0, 1000), updatedAt: deps.db.fn.now() })
    }
  })
}

/**
 * Keeps packages running: starts one again when its server stopped, picks up a start or removal a lost worker left
 * behind, and renews each egress grant. A machine that cannot be asked right now is left for the next pass.
 */
export async function sweepPluginInstances(deps: WorkerDeps): Promise<void> {
  const { db, redis, sandbox, queues } = deps
  const instances = await db<PluginInstanceRow>('plugin_instances').select('pluginId', 'orgId', 'slug', 'state', 'containerId', 'updatedAt')
  const bucket = Math.floor(Date.now() / STUCK_MS)
  for (const instance of instances) {
    const enqueue = (action: 'start' | 'remove') =>
      queues.environments.add(
        `plugin.${action}`,
        { pluginId: instance.pluginId, action },
        { jobId: `sweep-${instance.pluginId}-${action}-${bucket}` },
      )
    if (instance.state === 'removing' || (instance.state === 'starting' && Date.now() - instance.updatedAt.getTime() > STUCK_MS)) {
      await enqueue(instance.state === 'removing' ? 'remove' : 'start')
      continue
    }
    if (instance.state !== 'ready' || !instance.containerId) continue
    const token = await redis.get(previewKeys.grant(instance.slug))
    const state = await sandbox
      .serviceState(instance.containerId)
      .then((answer) => answer.state)
      .catch(() => null)
    const lostGrant = !token && Boolean(deps.env.FACTORIX_PROXY_URL)
    if (state === 'exited' || state === 'missing' || state === 'unhealthy' || lostGrant) {
      const why = lostGrant ? 'Its network grant ran out' : `Its server ${state === 'unhealthy' ? 'stopped answering' : 'stopped'}`
      await db('plugin_instances')
        .where({ pluginId: instance.pluginId, state: 'ready' })
        .update({ state: 'starting', error: `${why}, so Factorix started it again`, updatedAt: db.fn.now() })
      await enqueue('start')
      continue
    }
    if (token) await redis.multi().expire(previewKeys.grant(instance.slug), GRANT_TTL_SECONDS).expire(proxyTokenKey(token), GRANT_TTL_SECONDS).exec()
  }
}
