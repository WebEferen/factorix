import { createPublicKey, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { packPlugin } from './pack'
import { buildRegistry, generateKey, signPackage } from './registry'

const publicKey = (text: string) =>
  createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(text.slice('ed25519:'.length), 'base64')]),
    format: 'der',
    type: 'spki',
  })

describe('registries', () => {
  let dir: string
  let market: string

  /** Packs content, which needs no build, into the registry folder under its publisher. */
  const packed = async (name: string, version: string, folder: string) => {
    const source = join(dir, `${name}-${version}`)
    mkdirSync(join(source, 'skills'), { recursive: true })
    writeFileSync(join(source, 'skills', 'tone.md'), `Tone ${version}`)
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({ name, version, factorix: { content: { skills: [{ key: 'tone', name: 'Tone', file: 'skills/tone.md' }] } } }),
    )
    mkdirSync(join(market, folder), { recursive: true })
    return (await packPlugin(source, { out: join(market, folder, `${name}-${version}.zip`) })).file
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fx-registry-'))
    market = join(dir, 'market')
    mkdirSync(market)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('makes a key only its owner reads, and never overwrites one', async () => {
    const key = await generateKey(join(dir, 'acme.key'))
    expect(key).toMatch(/^ed25519:[A-Za-z0-9+/]{43}=$/)
    expect(statSync(join(dir, 'acme.key')).mode & 0o777).toBe(0o600)
    await expect(generateKey(join(dir, 'acme.key'))).rejects.toThrow('never overwrites')
  })

  it('signs zips as their publisher and the index as the registry', async () => {
    const acme = await generateKey(join(dir, 'acme.key'))
    const registry = await generateKey(join(dir, 'registry.key'))
    for (const version of ['1.0.0', '1.10.0', '1.2.0']) {
      const signed = await signPackage(await packed('kit', version, 'acme'), join(dir, 'acme.key'))
      expect(signed).toMatchObject({ name: 'kit', version, key: acme })
    }
    writeFileSync(
      join(market, 'registry.json'),
      JSON.stringify({ name: 'Acme market', publishers: [{ id: 'acme', name: 'Acme', verified: true, keys: [acme] }], reviewed: ['kit@1.2.0'] }),
    )

    const built = await buildRegistry(market, join(dir, 'registry.key'), { now: new Date('2026-11-24T10:00:00Z') })
    expect(built).toMatchObject({ packages: 1, versions: 3, key: registry })
    const bytes = readFileSync(join(market, 'index.json'))
    const signature = Buffer.from(readFileSync(join(market, 'index.json.sig'), 'utf8').trim(), 'base64')
    expect(verify(null, Buffer.concat([Buffer.from('factorix-registry/1\n'), bytes]), publicKey(registry), signature)).toBe(true)
    const index = JSON.parse(bytes.toString())
    expect(index).toMatchObject({ format: 1, name: 'Acme market', issuedAt: '2026-11-24T10:00:00.000Z' })
    expect(index.publishers).toEqual([{ id: 'acme', name: 'Acme', verified: true, keys: [acme] }])
    expect(
      index.packages[0].versions.map((version: { version: string; url: string; reviewed: boolean }) => [
        version.version,
        version.url,
        version.reviewed,
      ]),
    ).toEqual([
      ['1.10.0', 'acme/kit-1.10.0.zip', false],
      ['1.2.0', 'acme/kit-1.2.0.zip', true],
      ['1.0.0', 'acme/kit-1.0.0.zip', false],
    ])
    expect(index.packages[0].versions[0].manifest).toMatchObject({ name: 'kit', version: '1.10.0', content: { skills: [{ key: 'tone' }] } })
  })

  it('stops at a zip nobody it lists signed', async () => {
    const acme = await generateKey(join(dir, 'acme.key'))
    await generateKey(join(dir, 'stranger.key'))
    await generateKey(join(dir, 'registry.key'))
    writeFileSync(join(market, 'registry.json'), JSON.stringify({ name: 'Acme market', publishers: [{ id: 'acme', name: 'Acme', keys: [acme] }] }))
    const zip = await packed('kit', '1.0.0', 'acme')
    await expect(buildRegistry(market, join(dir, 'registry.key'))).rejects.toThrow('acme/kit-1.0.0.zip has no acme/kit-1.0.0.zip.sig')
    await signPackage(zip, join(dir, 'stranger.key'))
    await expect(buildRegistry(market, join(dir, 'registry.key'))).rejects.toThrow('not signed by any publisher')
    await signPackage(zip, join(dir, 'acme.key'))
    writeFileSync(zip, Buffer.concat([readFileSync(zip), Buffer.from(' ')]))
    await expect(buildRegistry(market, join(dir, 'registry.key'))).rejects.toThrow('not signed by any publisher')
  })
})
