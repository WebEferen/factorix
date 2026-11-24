import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto'
import { type PluginPackageManifest, parsePackageManifest } from './package'
import { BUNDLED_PLUGIN_NAME } from './protocol'

/**
 * A registry is a folder of packages anyone can host as static files: `index.json`, `index.json.sig`, and the zips. The
 * registry's key signs the index, the index pins each zip's sha256, and each publisher signs its own packages, so neither
 * the host nor a registry that lost its files can hand Factorix something nobody signed.
 */
export const REGISTRY_FORMAT = 1
export const REGISTRY_INDEX = 'index.json'
export const REGISTRY_SIGNATURE = 'index.json.sig'
export const REGISTRY_LIMITS = { indexBytes: 5 * 1024 * 1024, packages: 2000, versions: 50, publishers: 500, keys: 5 }

/** How far a registry vouches for a version, weakest first: its publisher signed it, the registry knows who that is, or it read the code. */
export const PACKAGE_TRUST = ['signed', 'verified', 'reviewed'] as const
export type PackageTrust = (typeof PACKAGE_TRUST)[number]

export interface RegistryPublisher {
  id: string
  name: string
  verified: boolean
  /** `ed25519:` and the raw public key in base64. A publisher rotating keys lists both for a while. */
  keys: string[]
}

export interface RegistryVersion {
  version: string
  /** Relative to the registry's address, or absolute. */
  url: string
  sha256: string
  size: number
  /** The publisher's signature over {@link packageSigningMessage}, in base64. */
  signature: string
  reviewed: boolean
  manifest: PluginPackageManifest
}

export interface RegistryPackage {
  name: string
  publisher: string
  /** Newest first. */
  versions: RegistryVersion[]
}

export interface RegistryIndex {
  format: typeof REGISTRY_FORMAT
  name: string
  issuedAt: string
  publishers: RegistryPublisher[]
  packages: RegistryPackage[]
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')
const KEY = /^ed25519:([A-Za-z0-9+/]{43}=)$/
const PUBLISHER = /^[a-z0-9][a-z0-9-]{0,39}$/
const SHA256 = /^[0-9a-f]{64}$/
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/

export function registryKey(value: string): KeyObject {
  const match = KEY.exec(value.trim())
  if (!match) throw new Error('A key looks like ed25519: and 44 characters of base64')
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(match[1] as string, 'base64')]), format: 'der', type: 'spki' })
}

/** A short name for a key, for people and the audit log. */
export function keyId(value: string): string {
  return createHash('sha256').update(value.trim()).digest('hex').slice(0, 16)
}

/** What a publisher signs: the package's name, version, and the sha256 of its zip, under a label no other signature uses. */
export function packageSigningMessage(name: string, version: string, sha256: string): Buffer {
  return Buffer.from(`factorix-package/1\n${name}\n${version}\n${sha256}\n`)
}

export function indexSigningMessage(index: Buffer): Buffer {
  return Buffer.concat([Buffer.from('factorix-registry/1\n'), index])
}

export function verifySignature(key: string, message: Buffer, signature: string): boolean {
  if (!SIGNATURE.test(signature.trim())) return false
  try {
    return verify(null, message, registryKey(key), Buffer.from(signature.trim(), 'base64'))
  } catch {
    return false
  }
}

/** Orders `1.2.3` and `1.2.3-beta.1` the way semver does, with a pre-release before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (value: string) => {
    const [core = '', pre] = value.split(/[-+]/, 2)
    return { parts: core.split('.').map(Number), pre: value.includes('-') ? (pre ?? '') : null }
  }
  const left = split(a)
  const right = split(b)
  for (let at = 0; at < 3; at += 1) {
    const diff = (left.parts[at] ?? 0) - (right.parts[at] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  if (left.pre === right.pre) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  return left.pre < right.pre ? -1 : 1
}

export function trustOf(version: Pick<RegistryVersion, 'reviewed'>, publisher: Pick<RegistryPublisher, 'verified'>): PackageTrust {
  return version.reviewed ? 'reviewed' : publisher.verified ? 'verified' : 'signed'
}

export function trustAllows(least: PackageTrust, trust: PackageTrust): boolean {
  return PACKAGE_TRUST.indexOf(trust) >= PACKAGE_TRUST.indexOf(least)
}

/** Where a registry's files are, from the address an admin typed, with or without index.json at the end. */
export function registryBase(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('A registry is reached over HTTP or HTTPS')
  if (url.username || url.password) throw new Error('Leave credentials out of the address')
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(new RegExp(`/${REGISTRY_INDEX.replace('.', '\\.')}$`), '/')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

/** A zip may sit anywhere over HTTPS, since its sha256 is in the signed index. Over HTTP only when the registry itself is. */
export function versionUrl(base: URL, version: Pick<RegistryVersion, 'url'>): URL {
  const url = new URL(version.url, base)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && base.protocol === 'http:')) {
    throw new Error(`${version.url} is not an address Factorix downloads from`)
  }
  if (url.username || url.password) throw new Error(`${version.url} carries credentials`)
  return url
}

const text = (value: unknown, max: number, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be text of at most ${max} characters`)
  return value.trim()
}

const list = (value: unknown, max: number, label: string): Record<string, unknown>[] => {
  if (!Array.isArray(value) || value.length > max || !value.every((item) => item && typeof item === 'object')) {
    throw new Error(`${label} lists up to ${max} entries`)
  }
  return value
}

/**
 * Reads an index after checking that the registry's key signed these exact bytes. Everything in it is then the registry's
 * word, but each zip still has to match its sha256 and its publisher's signature when it is downloaded.
 */
export function parseRegistryIndex(index: Buffer, signature: string, publicKey: string): RegistryIndex {
  if (index.length > REGISTRY_LIMITS.indexBytes) throw new Error(`An index is at most ${REGISTRY_LIMITS.indexBytes / 1024 / 1024} MB`)
  if (!verifySignature(publicKey, indexSigningMessage(index), signature)) {
    throw new Error(`${REGISTRY_INDEX} is not signed by this registry's key`)
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(index.toString('utf8'))
  } catch {
    throw new Error(`${REGISTRY_INDEX} is not JSON`)
  }
  if (!raw || raw.format !== REGISTRY_FORMAT) {
    throw new Error(`This registry has format ${String(raw?.format)}, and this Factorix reads format ${REGISTRY_FORMAT}`)
  }
  const issuedAt = new Date(String(raw.issuedAt ?? ''))
  if (Number.isNaN(issuedAt.getTime())) throw new Error('issuedAt is the time the index was signed, as an ISO date')

  const publishers = list(raw.publishers, REGISTRY_LIMITS.publishers, 'publishers').map((publisher): RegistryPublisher => {
    const id = String(publisher.id ?? '')
    if (!PUBLISHER.test(id)) throw new Error(`The publisher ${JSON.stringify(id.slice(0, 60))} needs an id of lowercase letters, digits, and dashes`)
    const keys = publisher.keys
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > REGISTRY_LIMITS.keys || !keys.every((key) => typeof key === 'string')) {
      throw new Error(`The publisher ${id} lists 1 to ${REGISTRY_LIMITS.keys} keys`)
    }
    for (const key of keys) registryKey(key)
    return {
      id,
      name: text(publisher.name, 80, `The name of ${id}`),
      verified: publisher.verified === true,
      keys: keys.map((key: string) => key.trim()),
    }
  })
  const publisherIds = new Set(publishers.map((publisher) => publisher.id))
  if (publisherIds.size !== publishers.length) throw new Error('Two publishers share an id')

  const packages = list(raw.packages, REGISTRY_LIMITS.packages, 'packages').map((entry): RegistryPackage => {
    const name = String(entry.name ?? '')
    if (!BUNDLED_PLUGIN_NAME.test(name)) throw new Error(`${JSON.stringify(name.slice(0, 60))} is not a package name`)
    const publisher = String(entry.publisher ?? '')
    if (!publisherIds.has(publisher))
      throw new Error(`${name} names the publisher ${JSON.stringify(publisher.slice(0, 60))}, which the index does not list`)
    const versions = list(entry.versions, REGISTRY_LIMITS.versions, `The versions of ${name}`).map((item): RegistryVersion => {
      let manifest: PluginPackageManifest
      try {
        manifest = parsePackageManifest(item.manifest)
      } catch (error) {
        throw new Error(`${name} ${String(item.version)}: ${(error as Error).message}`)
      }
      if (manifest.name !== name || manifest.version !== item.version) {
        throw new Error(`${name} ${String(item.version)} carries the manifest of ${manifest.name} ${manifest.version}`)
      }
      const sha256 = String(item.sha256 ?? '')
      const size = Number(item.size)
      if (!SHA256.test(sha256) || !Number.isInteger(size) || size <= 0) throw new Error(`${name} ${manifest.version} needs its zip's sha256 and size`)
      return {
        version: manifest.version,
        url: text(item.url, 2000, `The address of ${name} ${manifest.version}`),
        sha256,
        size,
        signature: text(item.signature, 200, `The signature of ${name} ${manifest.version}`),
        reviewed: item.reviewed === true,
        manifest,
      }
    })
    if (versions.length === 0) throw new Error(`${name} has no versions`)
    if (new Set(versions.map((version) => version.version)).size !== versions.length) throw new Error(`${name} lists a version twice`)
    return { name, publisher, versions: versions.sort((a, b) => compareVersions(b.version, a.version)) }
  })
  if (new Set(packages.map((entry) => entry.name)).size !== packages.length) throw new Error('Two packages in the index share a name')

  return { format: REGISTRY_FORMAT, name: text(raw.name, 80, 'name'), issuedAt: issuedAt.toISOString(), publishers, packages }
}

/** Checks a downloaded zip against the index: the bytes it pinned, signed by a key of the publisher it names. Returns that key. */
export function checkRegistryArchive(publisher: RegistryPublisher, version: RegistryVersion, name: string, archive: Buffer): string {
  const sha256 = createHash('sha256').update(archive).digest('hex')
  if (archive.length !== version.size || sha256 !== version.sha256) {
    throw new Error(`The zip of ${name} ${version.version} is not the one the registry signed`)
  }
  const message = packageSigningMessage(name, version.version, sha256)
  const key = publisher.keys.find((candidate) => verifySignature(candidate, message, version.signature))
  if (!key) throw new Error(`${name} ${version.version} is not signed by ${publisher.name}`)
  return key
}
