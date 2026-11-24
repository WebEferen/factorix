import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import type { PluginInstanceRow } from '@factorix/db'
import { packPlugin } from '@moxxy/factorix-plugin-sdk/pack'
import { buildRegistry, generateKey, signPackage } from '@moxxy/factorix-plugin-sdk/registry'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { ApiClient, createHarness, type Harness } from './testing/harness'

const SETUP = { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' }

/** Serves a folder as a static host would, which is all a registry needs. */
async function serveFolder(root: string): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const path = normalize(join(root, decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname)))
    try {
      if (!path.startsWith(root)) throw new Error('outside')
      response.end(readFileSync(path))
    } catch {
      response.statusCode = 404
      response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }
}

describe('market', () => {
  let harness: Harness
  let ada: ApiClient
  let dir: string
  const servers: Server[] = []
  const keys: Record<string, string> = {}
  const key = (name: string) => join(dir, `${name}.key`)

  /** Packs a package the way its author does, and signs it as its publisher, into a registry's folder. */
  const publish = async (market: string, publisher: string, name: string, version: string, factorix: Record<string, unknown>) => {
    const source = join(dir, 'src', `${name}-${version}`)
    mkdirSync(join(source, 'skills'), { recursive: true })
    writeFileSync(join(source, 'server.mjs'), 'export {}\n')
    writeFileSync(join(source, 'skills', 'checklist.md'), '# Checklist')
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name, version, description: `${name} by ${publisher}`, factorix }))
    const out = join(market, publisher, `${name}-${version}.zip`)
    mkdirSync(dirname(out), { recursive: true })
    await signPackage((await packPlugin(source, { out })).file, key(publisher))
    return out
  }
  const index = async (market: string, config: Record<string, unknown>, registryKey = 'registry') => {
    writeFileSync(join(market, 'registry.json'), JSON.stringify(config))
    await buildRegistry(market, key(registryKey))
  }
  const hello = (permissions: string[], egress: string[]) => ({ entry: 'server.mjs', permissions, egress })
  const kit = { content: { skills: [{ key: 'security-checklist', name: 'Security checklist', file: 'skills/checklist.md' }] } }

  let registry: { id: string }
  let url = ''
  const market = async () => (await ada.ok('GET', '/api/market')).market
  const find = async (name: string, registryName = 'Acme market') =>
    (await market()).packages.find((entry: { name: string; registry: string }) => entry.name === name && entry.registry === registryName)
  const pick = (entry: { registryId: string; name: string; version: string; sha256: string }) => ({
    registryId: entry.registryId,
    name: entry.name,
    version: entry.version,
    sha256: entry.sha256,
  })

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    harness.deps.env.FACTORIX_PACKAGES_INTERNAL_URL = 'http://127.0.0.1:9'
    ada = new ApiClient(harness.app)
    await ada.ok('POST', '/api/auth/setup', SETUP)
    dir = mkdtempSync(join(tmpdir(), 'fx-market-'))
    for (const name of ['acme', 'umbrella', 'registry', 'other-registry', 'stranger']) keys[name] = await generateKey(key(name))

    const acme = join(dir, 'acme-market')
    await publish(acme, 'acme', 'hello', '1.0.0', hello(['members:read'], ['api.example.com']))
    await publish(acme, 'acme', 'security-kit', '1.0.0', kit)
    await index(acme, {
      name: 'Acme market',
      publishers: [{ id: 'acme', name: 'Acme', verified: true, keys: [keys.acme] }],
      reviewed: ['security-kit@1.0.0'],
    })
    copyFileSync(join(acme, 'index.json'), join(dir, 'first-index.json'))
    copyFileSync(join(acme, 'index.json.sig'), join(dir, 'first-index.json.sig'))
    const served = await serveFolder(acme)
    servers.push(served.server)
    url = served.url
  })

  afterAll(async () => {
    for (const server of servers) server.close()
    await harness.destroy()
    rmSync(dir, { recursive: true, force: true })
  })

  it('adds a registry only with the key that signs its index', async () => {
    const wrong = await ada.request('POST', '/api/market/registries', { url, publicKey: keys.stranger, trust: 'signed' })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error.message).toContain("not signed by this registry's key")

    const added = await ada.request('POST', '/api/market/registries', { url: `${url}index.json`, publicKey: keys.registry, trust: 'signed' })
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    registry = added.body.registry
    expect(added.body.registry).toMatchObject({ name: 'Acme market', url, trust: 'signed', packages: 2, error: null })
    expect((await ada.request('POST', '/api/market/registries', { url, publicKey: keys.registry })).status).toBe(409)

    const { packages } = await market()
    expect(packages.map((entry: { name: string; kind: string; trust: string }) => [entry.name, entry.kind, entry.trust])).toEqual([
      ['hello', 'plugin', 'verified'],
      ['security-kit', 'content', 'reviewed'],
    ])
    expect(await find('hello')).toMatchObject({
      version: '1.0.0',
      publisher: { id: 'acme', name: 'Acme', verified: true },
      permissions: [{ id: 'members:read' }],
      egress: ['api.example.com'],
      blocked: null,
      installed: null,
    })
  })

  it('installs only as far as the installation trusts the registry', async () => {
    await ada.ok('PUT', `/api/market/registries/${registry.id}`, { trust: 'reviewed' })
    const entry = await find('hello')
    expect(entry.blocked).toContain('only packages it reviewed')
    const refused = await ada.request('POST', '/api/market/inspect', pick(entry))
    expect(refused.status).toBe(403)
    await ada.ok('PUT', `/api/market/registries/${registry.id}`, { trust: 'signed' })
  })

  it('imports content and runs a plugin from the registry, and remembers who signed each', async () => {
    const kitEntry = await find('security-kit')
    const plan = await ada.ok('POST', '/api/market/inspect', pick(kitEntry))
    expect(plan.package).toMatchObject({
      kind: 'content',
      name: 'security-kit',
      items: [{ kind: 'skill', key: 'security-checklist', action: 'create' }],
      source: { registry: 'Acme market', publisher: 'Acme', trust: 'reviewed' },
    })
    expect((await ada.ok('POST', '/api/market/install', pick(kitEntry))).installed).toEqual({
      kind: 'content',
      name: 'security-kit',
      version: '1.0.0',
    })
    const { contentPacks } = await ada.ok('GET', '/api/content-packs')
    expect(contentPacks[0]).toMatchObject({ name: 'security-kit', source: { registryId: registry.id, publisher: 'Acme', trust: 'reviewed' } })

    const helloEntry = await find('hello')
    expect((await ada.ok('POST', '/api/market/inspect', pick(helloEntry))).package).toMatchObject({ kind: 'plugin', replaces: null, adds: null })
    await ada.ok('POST', '/api/market/install', pick(helloEntry))
    const instance = (await harness.deps.db<PluginInstanceRow>('plugin_instances').first()) as PluginInstanceRow
    expect(instance.source).toMatchObject({ registryUrl: url, publisher: 'acme', trust: 'verified' })
    expect(instance.source?.keyId).toMatch(/^[0-9a-f]{16}$/)
    const audit = await harness.deps.db('audit_log').where({ action: 'plugin.uploaded', targetId: instance.pluginId }).first()
    expect(audit.metadata.source).toMatchObject({ registry: 'Acme market', publisher: 'acme', trust: 'verified' })
    const { plugins } = await ada.ok('GET', '/api/plugins')
    expect(plugins.find((plugin: { name: string }) => plugin.name === 'hello').package.source).toMatchObject({
      registry: 'Acme market',
      publisher: 'Acme',
    })
    expect(await find('hello')).toMatchObject({ installed: { version: '1.0.0', fromHere: true }, update: false })
  })

  it('offers a newer version, and shows what it asks for that the running one did not', async () => {
    const zip = await publish(
      join(dir, 'acme-market'),
      'acme',
      'hello',
      '1.1.0',
      hello(['members:read', 'tickets:write'], ['api.example.com', 'hooks.example.com']),
    )
    await index(join(dir, 'acme-market'), { name: 'Acme market', publishers: [{ id: 'acme', name: 'Acme', verified: true, keys: [keys.acme] }] })
    await ada.ok('POST', `/api/market/registries/${registry.id}/refresh`)
    const entry = await find('hello')
    expect(entry).toMatchObject({ version: '1.1.0', installed: { version: '1.0.0', fromHere: true }, update: true })

    const plan = (await ada.ok('POST', '/api/market/inspect', pick(entry))).package
    expect(plan).toMatchObject({ replaces: '1.0.0', adds: { permissions: ['tickets:write'], egress: ['hooks.example.com'], database: false } })

    const stale = await ada.request('POST', '/api/market/install', { ...pick(entry), sha256: 'a'.repeat(64) })
    expect(stale.status).toBe(409)
    const original = readFileSync(zip)
    writeFileSync(zip, Buffer.concat([original, Buffer.from(' ')]))
    const swapped = await ada.request('POST', '/api/market/install', pick(entry))
    expect(swapped.status).toBe(502)
    expect(swapped.body.error.message).toContain('not the one the registry signed')
    writeFileSync(zip, original)

    await ada.ok('POST', '/api/market/install', pick(entry))
    const instance = (await harness.deps.db<PluginInstanceRow>('plugin_instances').first()) as PluginInstanceRow
    expect(instance.package).toMatchObject({ version: '1.1.0', permissions: ['members:read', 'tickets:write'] })
  })

  it('keeps the newer index when someone replays an older one', async () => {
    copyFileSync(join(dir, 'first-index.json'), join(dir, 'acme-market', 'index.json'))
    copyFileSync(join(dir, 'first-index.json.sig'), join(dir, 'acme-market', 'index.json.sig'))
    const { registry: refreshed } = await ada.ok('POST', `/api/market/registries/${registry.id}/refresh`)
    expect(refreshed.error).toContain('older than the one Factorix has')
    expect((await find('hello')).version).toBe('1.1.0')
  })

  it('never hands one publisher what another one installed under the same name', async () => {
    const umbrella = join(dir, 'umbrella-market')
    await publish(umbrella, 'umbrella', 'hello', '2.0.0', hello([], []))
    await index(umbrella, { name: 'Umbrella market', publishers: [{ id: 'umbrella', name: 'Umbrella', keys: [keys.umbrella] }] }, 'other-registry')
    const served = await serveFolder(umbrella)
    servers.push(served.server)
    await ada.ok('POST', '/api/market/registries', { url: served.url, publicKey: keys['other-registry'], trust: 'signed' })

    const entry = await find('hello', 'Umbrella market')
    expect(entry).toMatchObject({ trust: 'signed', installed: { version: '1.1.0', fromHere: false }, update: false })
    expect(entry.blocked).toContain('from Acme in Acme market')
    expect((await ada.request('POST', '/api/market/install', pick(entry))).status).toBe(403)
  })

  it('turns off uploads for an installation that installs only from registries', async () => {
    await ada.ok('PUT', '/api/settings/general', { values: { allowPackageUploads: false } })
    expect((await market()).uploads).toBe(false)
    const upload = await harness.app.inject({
      method: 'POST',
      url: '/api/plugin-packages/inspect',
      payload: Buffer.from('PK'),
      headers: { cookie: ada.cookie, 'content-type': 'application/zip' },
    })
    expect(upload.statusCode).toBe(403)
    expect(upload.json().error.message).toContain('only from its registries')
    await ada.ok('PUT', '/api/settings/general', { values: { allowPackageUploads: null } })
  })
})
