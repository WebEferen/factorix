import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  checkRegistryArchive,
  compareVersions,
  indexSigningMessage,
  packageSigningMessage,
  parseRegistryIndex,
  registryBase,
  trustAllows,
  trustOf,
  versionUrl,
} from './registry'

function keyPair(): { key: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { key: `ed25519:${publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64')}`, privateKey }
}

const registry = keyPair()
const acme = keyPair()
const archive = Buffer.from('pretend this is a zip')
const sha256 = createHash('sha256').update(archive).digest('hex')
const manifest = (version: string) => ({ format: 1, name: 'kit', version, content: { skills: [{ key: 'tone', name: 'Tone', file: 'tone.md' }] } })
const version = (value: string, signer = acme.privateKey) => ({
  version: value,
  url: `kit-${value}.zip`,
  sha256,
  size: archive.length,
  signature: sign(null, packageSigningMessage('kit', value, sha256), signer).toString('base64'),
  manifest: manifest(value),
})

function signed(index: Record<string, unknown>, signer = registry.privateKey): [Buffer, string] {
  const bytes = Buffer.from(JSON.stringify(index))
  return [bytes, sign(null, indexSigningMessage(bytes), signer).toString('base64')]
}

const INDEX = {
  format: 1,
  name: 'Acme market',
  issuedAt: '2026-11-24T10:00:00.000Z',
  publishers: [{ id: 'acme', name: 'Acme', verified: true, keys: [acme.key] }],
  packages: [{ name: 'kit', publisher: 'acme', versions: [version('1.0.0'), { ...version('1.10.0'), reviewed: true }, version('1.2.0-beta.1')] }],
}

describe('parseRegistryIndex', () => {
  it('reads an index its registry signed, newest version first', () => {
    const index = parseRegistryIndex(...signed(INDEX), registry.key)
    expect(index).toMatchObject({ name: 'Acme market', publishers: [{ id: 'acme', verified: true, keys: [acme.key] }] })
    expect(index.packages[0]?.versions.map((entry) => [entry.version, entry.reviewed])).toEqual([
      ['1.10.0', true],
      ['1.2.0-beta.1', false],
      ['1.0.0', false],
    ])
  })

  it('refuses an index another key signed, or one changed after signing', () => {
    expect(() => parseRegistryIndex(...signed(INDEX, acme.privateKey), registry.key)).toThrow("not signed by this registry's key")
    const [bytes, signature] = signed(INDEX)
    const changed = Buffer.from(bytes.toString().replace('"verified":true', '"verified":fals'))
    expect(() => parseRegistryIndex(changed, signature, registry.key)).toThrow("not signed by this registry's key")
    expect(() => parseRegistryIndex(bytes, signature, 'ed25519:nope')).toThrow("not signed by this registry's key")
  })

  it.each([
    [{ packages: [{ name: 'kit', publisher: 'acme', versions: [{ ...version('1.0.0'), manifest: manifest('2.0.0') }] }] }, 'carries the manifest'],
    [{ packages: [{ name: 'kit', publisher: 'umbrella', versions: [version('1.0.0')] }] }, 'does not list'],
    [{ packages: [INDEX.packages[0], INDEX.packages[0]] }, 'share a name'],
    [{ packages: [{ name: 'kit', publisher: 'acme', versions: [version('1.0.0'), version('1.0.0')] }] }, 'lists a version twice'],
    [{ publishers: [{ id: 'acme', name: 'Acme', keys: [] }] }, 'lists 1 to 5 keys'],
    [{ format: 2 }, 'reads format 1'],
  ])('refuses what it cannot trust or read: %#', (change, message) => {
    expect(() => parseRegistryIndex(...signed({ ...INDEX, ...change }), registry.key)).toThrow(message)
  })
})

describe('checkRegistryArchive', () => {
  const publisher = { id: 'acme', name: 'Acme', verified: false, keys: [keyPair().key, acme.key] }
  const parsed = (entry: ReturnType<typeof version>) => ({ ...entry, reviewed: false }) as never

  it('takes the zip the index pinned, signed by any key of its publisher', () => {
    expect(checkRegistryArchive(publisher, parsed(version('1.0.0')), 'kit', archive)).toBe(acme.key)
  })

  it('refuses other bytes, and a signature by someone else', () => {
    expect(() => checkRegistryArchive(publisher, parsed(version('1.0.0')), 'kit', Buffer.from('another zip'))).toThrow(
      'not the one the registry signed',
    )
    expect(() => checkRegistryArchive(publisher, parsed(version('1.0.0', registry.privateKey)), 'kit', archive)).toThrow('not signed by Acme')
    expect(() => checkRegistryArchive(publisher, parsed({ ...version('1.0.0'), version: '1.0.1' }), 'kit', archive)).toThrow('not signed by Acme')
  })
})

describe('registry helpers', () => {
  it('orders versions as semver does', () => {
    expect(['1.0.0', '1.10.0', '1.2.0', '1.2.0-beta.2', '1.2.0-beta.1'].sort(compareVersions)).toEqual([
      '1.0.0',
      '1.2.0-beta.1',
      '1.2.0-beta.2',
      '1.2.0',
      '1.10.0',
    ])
  })

  it('ranks trust, with a review above a known publisher', () => {
    expect(trustOf({ reviewed: true }, { verified: false })).toBe('reviewed')
    expect(trustOf({ reviewed: false }, { verified: true })).toBe('verified')
    expect(trustOf({ reviewed: false }, { verified: false })).toBe('signed')
    expect(trustAllows('verified', 'reviewed')).toBe(true)
    expect(trustAllows('verified', 'signed')).toBe(false)
  })

  it('finds the folder from the address an admin typed, and keeps zips on HTTPS', () => {
    expect(registryBase('https://market.example.com/factorix/index.json?x=1').toString()).toBe('https://market.example.com/factorix/')
    expect(registryBase('https://market.example.com/factorix').toString()).toBe('https://market.example.com/factorix/')
    const base = registryBase('https://market.example.com/')
    expect(versionUrl(base, { url: 'kit/kit-1.0.0.zip' }).toString()).toBe('https://market.example.com/kit/kit-1.0.0.zip')
    expect(versionUrl(base, { url: 'https://cdn.example.org/kit.zip' }).host).toBe('cdn.example.org')
    expect(() => versionUrl(base, { url: 'http://cdn.example.org/kit.zip' })).toThrow('not an address')
    expect(() => versionUrl(base, { url: 'file:///etc/passwd' })).toThrow('not an address')
    expect(versionUrl(registryBase('http://127.0.0.1:8080'), { url: 'kit.zip' }).toString()).toBe('http://127.0.0.1:8080/kit.zip')
  })
})
