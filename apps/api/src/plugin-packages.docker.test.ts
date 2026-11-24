// Runs an uploaded package the way the server does: its source written into a volume, its own Postgres, the egress
// proxy as its only way out, and the preview gateway as Factorix's only way in.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PluginInstanceRow } from '@factorix/db'
import { DockerSandboxProvider, dockerClientFromEnv, type SandboxProvider } from '@factorix/sandbox'
import { packPlugin } from '@moxxy/factorix-plugin-sdk/pack'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { pluginKeys } from './lib/channels'
import { runPluginAction } from './services/plugin-packages'
import { ApiClient, createHarness, type Harness } from './testing/harness'

const image = process.env.FACTORIX_SANDBOX_IMAGE ?? 'factorix/sandbox-base:dev'
const docker = dockerClientFromEnv()
const suffix = randomUUID().slice(0, 8)
const stack = `test-${suffix}`
const egressNetwork = `fx-test-pkg-egress-${suffix}`

const PROBE = `
import { writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { definePlugin } from '@moxxy/factorix-plugin-sdk'
import { serve } from '@moxxy/factorix-plugin-sdk/node'

const reach = (url) => fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.status, () => 'failed')
const database = () =>
  new Promise((done) => {
    const socket = connect(5432, 'db', () => (socket.end(), done('open')))
    socket.on('error', () => done('closed'))
  })
const write = () => {
  try {
    writeFileSync('/plugin/changed.txt', 'x')
    return 'changed'
  } catch {
    return 'refused'
  }
}
const plugin = definePlugin({
  name: 'probe',
  version: '1.0.0',
  pages: [
    {
      key: 'home',
      label: 'Probe',
      render: async () =>
        JSON.stringify({ allowed: await reach('http://allowed.test:8000/'), denied: await reach('http://denied.example/'), database: await database(), write: write() }),
    },
  ],
})
await serve(plugin, { secret: process.env.PLUGIN_SECRET, port: Number(process.env.PORT), hostname: process.env.HOST })
`

async function bundle(entry: string, name: string): Promise<{ tar: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'fx-pkg-'))
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, name), logLevel: 'silent' })
  const tar = join(dir, `${name}.tar`)
  execFileSync('tar', ['--no-xattrs', '-C', dir, '-cf', tar, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  return { tar, dir }
}

async function start(options: Parameters<typeof docker.createContainer>[0], files?: { tar: string; dir: string }): Promise<string> {
  const container = await docker.createContainer({ Image: image, ...options })
  if (files) await container.putArchive(files.tar, { path: '/tmp' })
  await container.start()
  if (files) rmSync(files.dir, { recursive: true, force: true })
  return container.id
}

describe('an uploaded plugin package', () => {
  let harness: Harness
  let sandbox: SandboxProvider
  let ada: ApiClient
  let packagesPort: number
  let pluginId: string
  let slug: string
  const containers: string[] = []
  const dir = mkdtempSync(join(tmpdir(), 'fx-pkg-src-'))

  const worker = () => ({ ...harness.deps, sandbox })

  beforeAll(async () => {
    await docker.createNetwork({ Name: egressNetwork, Labels: { 'factorix.test': stack } })
    const redisEnv = `REDIS_URL=redis://host.docker.internal:${new URL(inject('redisUrl')).port}`
    containers.push(
      await start({
        Cmd: ['node', '-e', `require('node:http').createServer((q,s)=>s.end('stub')).listen(8000)`],
        HostConfig: { NetworkMode: egressNetwork },
        NetworkingConfig: { EndpointsConfig: { [egressNetwork]: { Aliases: ['allowed.test'] } } },
      }),
    )
    containers.push(
      await start(
        {
          Cmd: ['node', '/tmp/proxy.cjs'],
          Env: [redisEnv, 'PORT=8080'],
          Labels: { 'factorix.role': 'egress', 'factorix.stack': stack },
          HostConfig: { NetworkMode: egressNetwork, ExtraHosts: ['host.docker.internal:host-gateway'] },
        },
        await bundle(resolve(import.meta.dirname, '../../egress-proxy/src/index.ts'), 'proxy.cjs'),
      ),
    )
    const gateway = await start(
      {
        Cmd: ['node', '/tmp/gateway.cjs'],
        Env: [redisEnv, 'PORT=4102', 'PACKAGE_PORT=4103'],
        Labels: { 'factorix.role': 'gateway', 'factorix.stack': stack },
        ExposedPorts: { '4103/tcp': {} },
        HostConfig: { PortBindings: { '4103/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] }, ExtraHosts: ['host.docker.internal:host-gateway'] },
      },
      await bundle(resolve(import.meta.dirname, '../../preview-gateway/src/index.ts'), 'gateway.cjs'),
    )
    containers.push(gateway)
    packagesPort = Number((await docker.getContainer(gateway).inspect()).NetworkSettings.Ports['4103/tcp']?.[0]?.HostPort)

    sandbox = new DockerSandboxProvider({ image, stepNetwork: egressNetwork, stack }, docker)
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') }, { sandbox })
    Object.assign(harness.deps.env, {
      FACTORIX_PROXY_URL: 'http://egress-proxy:8080',
      FACTORIX_PACKAGES_INTERNAL_URL: `http://127.0.0.1:${packagesPort}`,
    })
    ada = new ApiClient(harness.app)
    await ada.ok('POST', '/api/auth/setup', { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })

    await build({
      stdin: { contents: PROBE, resolveDir: import.meta.dirname, loader: 'js' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: join(dir, 'server.mjs'),
      logLevel: 'silent',
    })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'probe', version: '1.0.0', factorix: { entry: 'server.mjs', database: true, egress: ['allowed.test'] } }),
    )
  }, 240_000)

  afterAll(async () => {
    if (slug) {
      await sandbox?.stopEnvironment(slug).catch(() => undefined)
      await sandbox?.removeEnvironmentVolumes(slug, { source: true }).catch(() => undefined)
    }
    await harness?.destroy()
    for (const id of containers)
      await docker
        .getContainer(id)
        .remove({ force: true })
        .catch(() => undefined)
    await docker
      .getNetwork(egressNetwork)
      .remove()
      .catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs with its own database, reaches only what it listed, and cannot change its own code', async () => {
    const archive = readFileSync((await packPlugin(dir)).file)
    const answer = await harness.app.inject({
      method: 'POST',
      url: '/api/plugin-packages',
      payload: archive,
      headers: { cookie: ada.cookie, 'content-type': 'application/zip' },
    })
    expect(answer.statusCode, answer.body).toBe(200)
    pluginId = answer.json().plugin.id
    await runPluginAction(worker(), pluginId, 'start')
    const instance = (await harness.deps.db<PluginInstanceRow>('plugin_instances').where({ pluginId }).first()) as PluginInstanceRow
    slug = instance.slug
    expect(instance.error).toBeNull()
    expect(instance.state).toBe('ready')

    await ada.ok('PUT', `/api/plugins/${pluginId}/organization`, { enabled: true })
    const { url } = await ada.ok('POST', `/api/plugins/${pluginId}/pages/home/open`)
    const page = await fetch(`http://127.0.0.1:${packagesPort}${new URL(url).pathname}${new URL(url).search}`, {
      headers: { cookie: 'fx_session=secret' },
    })
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain('sandbox allow-scripts')
    expect(JSON.parse(await page.text())).toEqual({ allowed: 200, denied: 'failed', database: 'open', write: 'refused' })
    expect((await fetch(`http://127.0.0.1:${packagesPort}/${slug}/factorix`)).status).toBe(404)
  }, 300_000)

  it('is removed with its containers, data, and route', async () => {
    expect((await ada.request('DELETE', `/api/plugins/${pluginId}`)).status).toBe(200)
    await runPluginAction(worker(), pluginId, 'remove')
    const left = await docker.listContainers({ all: true, filters: JSON.stringify({ name: [`fx-env-${slug}-`] }) })
    expect(left).toEqual([])
    const volumes = (await docker.listVolumes()).Volumes ?? []
    expect(volumes.filter((volume) => volume.Name.includes(slug))).toEqual([])
    expect(await harness.deps.redis.get(pluginKeys.route(slug))).toBeNull()
    expect(await harness.deps.db('plugins').where({ id: pluginId }).first()).toBeUndefined()
  }, 120_000)
})
