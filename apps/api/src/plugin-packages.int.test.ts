import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginInstanceRow, PluginRow } from '@factorix/db'
import type { SandboxProvider, ServiceSpec } from '@factorix/sandbox'
import { definePlugin, type Permission } from '@moxxy/factorix-plugin-sdk'
import { serve } from '@moxxy/factorix-plugin-sdk/node'
import { packPlugin } from '@moxxy/factorix-plugin-sdk/pack'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { pluginKeys } from './lib/channels'
import { runPluginAction } from './services/plugin-packages'
import { endpointOf } from './services/plugins'
import { ApiClient, createHarness, type Harness } from './testing/harness'

const SETUP = { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' }

/** Records what the worker asks of the machine, and says every service it started is healthy. */
function fakeSandbox() {
  const calls: [string, ...unknown[]][] = []
  const sandbox = {
    ensureEnvironment: async (key: string) => {
      calls.push(['ensureEnvironment', key])
      return { key, network: `fx-env-${key}`, sourceVolume: `fx-envsrc-${key}` }
    },
    stopEnvironment: async (key: string, services?: string[]) => {
      calls.push(['stopEnvironment', key, services])
    },
    writeEnvironmentSource: async (key: string, archive: Buffer) => {
      calls.push(['writeEnvironmentSource', key, archive])
    },
    startService: async (_environment: unknown, spec: ServiceSpec) => {
      calls.push(['startService', spec])
      return `container-${spec.service}`
    },
    serviceState: async () => ({ state: 'healthy' as const }),
    joinEnvironment: async (_environment: unknown, role: string) => {
      calls.push(['joinEnvironment', role])
      return true
    },
    removeEnvironmentVolumes: async (key: string, options: { source: boolean }) => {
      calls.push(['removeEnvironmentVolumes', key, options])
    },
  } as unknown as SandboxProvider
  return { sandbox, calls }
}

function buildPackage(dir: string, version: string, permissions: Permission[]): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'factorix-plugin-hello',
      version,
      description: 'Says hello',
      factorix: { entry: 'server.mjs', permissions, egress: ['api.example.com'] },
    }),
  )
  writeFileSync(join(dir, 'server.mjs'), 'export {}\n')
}

describe('plugin packages', () => {
  let harness: Harness
  let ada: ApiClient
  let dir: string
  const servers: Server[] = []

  const upload = (path: string, archive: Buffer, client = ada) =>
    harness.app.inject({ method: 'POST', url: path, payload: archive, headers: { cookie: client.cookie, 'content-type': 'application/zip' } })

  const pack = async (version: string, permissions: Permission[]) => {
    buildPackage(dir, version, permissions)
    return readFileSync((await packPlugin(dir)).file)
  }

  /** Stands where the preview gateway would, serving the package's own server under its slug. */
  const servePackage = async (pluginId: string, version: string, permissions: Permission[]) => {
    const row = (await harness.deps.db<PluginRow>('plugins').where({ id: pluginId }).first()) as PluginRow
    const { slug } = (await harness.deps.db<PluginInstanceRow>('plugin_instances').where({ pluginId }).first()) as PluginInstanceRow
    const plugin = definePlugin({ name: 'hello', version, permissions, pages: [{ key: 'home', label: 'Hello', render: () => 'hi' }] })
    const server = await serve(plugin, { secret: endpointOf(harness.deps, row).secret, path: `/${slug}/factorix`, port: 0, hostname: '127.0.0.1' })
    servers.push(server)
    harness.deps.env.FACTORIX_PACKAGES_INTERNAL_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return slug
  }

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    harness.deps.env.FACTORIX_PACKAGES_INTERNAL_URL = 'http://127.0.0.1:9'
    ada = new ApiClient(harness.app)
    await ada.ok('POST', '/api/auth/setup', SETUP)
    dir = mkdtempSync(join(tmpdir(), 'fx-package-'))
  })

  afterAll(async () => {
    for (const server of servers) server.close()
    rmSync(dir, { recursive: true, force: true })
    await harness.destroy()
  })

  it('shows what a package asks for before anything of it runs', async () => {
    const answer = await upload('/api/plugin-packages/inspect', await pack('1.0.0', ['members:read']))
    expect(answer.statusCode).toBe(200)
    expect(answer.json().package).toMatchObject({
      name: 'hello',
      version: '1.0.0',
      description: 'Says hello',
      permissions: [{ id: 'members:read' }],
      egress: ['api.example.com'],
      database: false,
      replaces: null,
    })
    expect(await harness.deps.db('plugins').count('* as count').first()).toEqual({ count: '0' })
    const junk = await upload('/api/plugin-packages/inspect', Buffer.from('not a zip'))
    expect(junk.statusCode).toBe(400)
    expect(junk.json().error.message).toContain('not a zip')
  })

  let pluginId: string

  it('installs it for its own organization only, and lets it be turned on once it runs', async () => {
    const answer = await upload('/api/plugin-packages', await pack('1.0.0', ['members:read']))
    expect(answer.statusCode, answer.body).toBe(200)
    const { plugin } = answer.json()
    pluginId = plugin.id
    expect(plugin).toMatchObject({ name: 'hello', enabled: false, package: { state: 'starting', version: '1.0.0', runner: null } })
    expect((await ada.request('PUT', `/api/plugins/${pluginId}/organization`, { enabled: true })).status).toBe(409)

    const { org: beta } = await ada.ok('POST', '/api/orgs', { name: 'Beta' })
    await ada.ok('POST', '/api/auth/switch', { orgId: beta.id })
    expect((await ada.ok('GET', '/api/plugins')).plugins.map((entry: { id: string }) => entry.id)).not.toContain(pluginId)
    expect((await ada.request('PUT', `/api/plugins/${pluginId}/organization`, { enabled: true })).status).toBe(404)
    expect((await ada.request('DELETE', `/api/plugins/${pluginId}`)).status).toBe(404)
    const acme = (await ada.ok('GET', '/api/orgs')).orgs.find((entry: { name: string }) => entry.name === 'Acme')
    await ada.ok('POST', '/api/auth/switch', { orgId: acme.id })

    const slug = await servePackage(pluginId, '1.0.0', ['members:read'])
    const { sandbox, calls } = fakeSandbox()
    await runPluginAction({ ...harness.deps, sandbox }, pluginId, 'start')

    const source = calls.find(([name]) => name === 'writeEnvironmentSource')?.[2] as Buffer
    writeFileSync(join(dir, 'source.tgz'), source)
    expect(execFileSync('tar', ['-tzf', join(dir, 'source.tgz')], { encoding: 'utf8' }).split('\n')).toEqual(
      expect.arrayContaining(['factorix-plugin.json', 'server.mjs']),
    )
    const app = calls.find(([name, spec]) => name === 'startService' && (spec as ServiceSpec).service === 'app')?.[1] as ServiceSpec
    expect(app).toMatchObject({
      repoCode: true,
      script: 'exec node /plugin/server.mjs',
      mounts: [{ volume: `fx-envsrc-${slug}`, target: '/plugin', readOnly: true }],
      env: expect.objectContaining({ PORT: '8080', HOST: '0.0.0.0', FACTORIX_URL: 'http://localhost:4101' }),
    })
    expect(app.env.DATABASE_URL).toBeUndefined()
    expect(calls.some(([name, spec]) => name === 'startService' && (spec as ServiceSpec).service === 'db')).toBe(false)
    expect(calls).toContainEqual(['joinEnvironment', 'gateway'])
    expect(JSON.parse((await harness.deps.redis.get(pluginKeys.route(slug))) as string)).toEqual({ host: `fx-env-${slug}-app`, port: 8080 })

    const { plugins } = await ada.ok('GET', '/api/plugins')
    expect(plugins.find((entry: { id: string }) => entry.id === pluginId)).toMatchObject({
      package: { state: 'ready', error: null },
      pages: [{ key: 'home', label: 'Hello' }],
    })
    const enabled = await ada.ok('PUT', `/api/plugins/${pluginId}/organization`, { enabled: true })
    expect(enabled.plugin.permissions).toEqual([expect.objectContaining({ id: 'members:read', granted: true })])
    const page = await ada.ok('POST', `/api/plugins/${pluginId}/pages/home/open`)
    expect(page.url).toMatch(new RegExp(`^http://localhost:4101/_package/${slug}/factorix/pages/home\\?factorix=`))
  })

  it('replaces it in place, and refuses a server that asks for more than the package listed', async () => {
    const answer = await upload('/api/plugin-packages/inspect', await pack('1.1.0', ['members:read']))
    expect(answer.json().package.replaces).toBe('1.0.0')
    const replaced = await upload('/api/plugin-packages', await pack('1.1.0', ['members:read']))
    expect(replaced.json().plugin).toMatchObject({ id: pluginId, package: { state: 'starting', version: '1.1.0' } })

    await servePackage(pluginId, '1.1.0', ['members:read', 'agents:run'])
    await runPluginAction({ ...harness.deps, ...fakeSandbox() }, pluginId, 'start')
    const instance = (await harness.deps.db<PluginInstanceRow>('plugin_instances').where({ pluginId }).first()) as PluginInstanceRow
    expect(instance.state).toBe('failed')
    expect(instance.error).toContain('agents:run')
    const row = (await harness.deps.db<PluginRow>('plugins').where({ id: pluginId }).first()) as PluginRow
    expect(row.manifest.permissions).toEqual(['members:read'])
  })

  it('removes it with its environment and data', async () => {
    const { slug } = (await harness.deps.db<PluginInstanceRow>('plugin_instances').where({ pluginId }).first()) as PluginInstanceRow
    await ada.ok('POST', `/api/plugins/${pluginId}/restart`)
    expect((await ada.request('DELETE', `/api/plugins/${pluginId}`)).status).toBe(200)
    expect((await ada.ok('GET', '/api/plugins')).plugins.find((entry: { id: string }) => entry.id === pluginId)).toMatchObject({
      enabled: false,
      package: { state: 'removing' },
    })
    const { sandbox, calls } = fakeSandbox()
    await runPluginAction({ ...harness.deps, sandbox }, pluginId, 'start')
    expect(calls).toEqual([
      ['stopEnvironment', slug, undefined],
      ['removeEnvironmentVolumes', slug, { source: true }],
    ])
    expect(await harness.deps.db('plugins').where({ id: pluginId }).first()).toBeUndefined()
    expect(await harness.deps.redis.get(pluginKeys.route(slug))).toBeNull()
  })
})
