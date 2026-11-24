import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { PackageManifest } from './pack.js'

/**
 * A registry is a folder anyone can serve as static files. Publishers sign their zips with `factorix-plugin sign`, and
 * whoever runs the registry lists who they are in `registry.json` and signs the index with `factorix-plugin registry`.
 * Factorix checks both signatures, and the sha256 the index pins, before it installs anything.
 */
export interface RegistryConfig {
  name: string
  publishers: { id: string; name: string; verified?: boolean; keys: string[] }[]
  /** Versions someone read the code of, as `name@version`. */
  reviewed?: string[]
}

export interface SignedPackage {
  file: string
  name: string
  version: string
  sha256: string
  key: string
}

export interface BuiltRegistry {
  index: string
  packages: number
  versions: number
  /** What an installation admin pastes into Factorix beside the registry's address. */
  key: string
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')
const KEY = /^ed25519:([A-Za-z0-9+/]{43}=)$/

/** The same bytes Factorix checks a publisher's signature against. */
export function packageSigningMessage(name: string, version: string, sha256: string): Buffer {
  return Buffer.from(`factorix-package/1\n${name}\n${version}\n${sha256}\n`)
}

const indexSigningMessage = (index: Buffer) => Buffer.concat([Buffer.from('factorix-registry/1\n'), index])

function publicKeyText(key: KeyObject): string {
  return `ed25519:${createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519.length).toString('base64')}`
}

function publicKeyOf(value: string): KeyObject {
  const match = KEY.exec(value.trim())
  if (!match) throw new Error(`${value.slice(0, 20)}... is not a key: it looks like ed25519: and 44 characters of base64`)
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(match[1] as string, 'base64')]), format: 'der', type: 'spki' })
}

async function privateKeyFrom(file: string): Promise<KeyObject> {
  const key = createPrivateKey(await readFile(file))
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} is not an ed25519 key. Make one with factorix-plugin keygen`)
  return key
}

/** Writes a new private key, readable only by its owner, and returns its public key for registry.json. */
export async function generateKey(file: string): Promise<string> {
  const { privateKey } = generateKeyPairSync('ed25519')
  await writeFile(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    throw error.code === 'EEXIST' ? new Error(`${file} already exists. Factorix never overwrites a key`) : error
  })
  return publicKeyText(privateKey)
}

/** Reads one file out of a zip, enough to find a package's manifest. Factorix reads the whole archive more strictly. */
function readZipEntry(archive: Buffer, wanted: string): Buffer | undefined {
  let end = -1
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 0xffff); at -= 1) {
    if (archive.readUInt32LE(at) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end < 0) throw new Error('This is not a zip')
  let at = archive.readUInt32LE(end + 16)
  for (let index = 0; index < archive.readUInt16LE(end + 10); index += 1) {
    const nameLength = archive.readUInt16LE(at + 28)
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength)
    if (name === wanted) {
      const local = archive.readUInt32LE(at + 42)
      const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28)
      const data = archive.subarray(start, start + archive.readUInt32LE(at + 20))
      return archive.readUInt16LE(at + 10) === 8 ? inflateRawSync(data) : Buffer.from(data)
    }
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32)
  }
  return undefined
}

function manifestOf(archive: Buffer, file: string): PackageManifest {
  const raw = readZipEntry(archive, 'factorix-plugin.json')
  if (!raw) throw new Error(`${file} has no factorix-plugin.json. Build it with factorix-plugin pack`)
  return JSON.parse(raw.toString('utf8')) as PackageManifest
}

/** Signs a packed zip as its publisher, into `<zip>.sig` beside it. The registry needs both files. */
export async function signPackage(zipFile: string, keyFile: string): Promise<SignedPackage> {
  const archive = await readFile(zipFile)
  const { name, version } = manifestOf(archive, zipFile)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const key = await privateKeyFrom(keyFile)
  const file = `${resolve(zipFile)}.sig`
  await writeFile(file, `${sign(null, packageSigningMessage(name, version, sha256), key).toString('base64')}\n`)
  return { file, name, version, sha256, key: publicKeyText(key) }
}

async function zipsIn(root: string, dir = root): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await zipsIn(root, path)))
    else if (entry.name.endsWith('.zip')) found.push(path)
  }
  return found.sort()
}

/**
 * Writes `index.json` and `index.json.sig` into a registry's folder, from its `registry.json` and every signed zip under
 * it. Each zip's publisher is whoever's key signed it, and a zip nobody listed signed stops the build.
 */
export async function buildRegistry(dir: string, keyFile: string, options: { now?: Date } = {}): Promise<BuiltRegistry> {
  const root = resolve(dir)
  const config = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8')) as RegistryConfig
  if (!config.name || !Array.isArray(config.publishers)) throw new Error('registry.json needs a name and its publishers')
  const publishers = config.publishers.map((publisher) => ({
    id: publisher.id,
    name: publisher.name,
    verified: publisher.verified === true,
    keys: publisher.keys,
    publicKeys: publisher.keys.map(publicKeyOf),
  }))
  const reviewed = new Set(config.reviewed ?? [])
  const packages = new Map<string, { name: string; publisher: string; versions: Record<string, unknown>[] }>()
  let versions = 0
  for (const path of await zipsIn(root)) {
    const url = relative(root, path).split(sep).join('/')
    const archive = await readFile(path)
    const signature = await readFile(`${path}.sig`, 'utf8').catch(() => {
      throw new Error(`${url} has no ${url}.sig beside it. Its publisher signs it with factorix-plugin sign`)
    })
    const manifest = manifestOf(archive, url)
    const sha256 = createHash('sha256').update(archive).digest('hex')
    const message = packageSigningMessage(manifest.name, manifest.version, sha256)
    const publisher = publishers.find((candidate) =>
      candidate.publicKeys.some((key) => verify(null, message, key, Buffer.from(signature.trim(), 'base64'))),
    )
    if (!publisher) throw new Error(`${url} is not signed by any publisher in registry.json`)
    const entry = packages.get(manifest.name) ?? { name: manifest.name, publisher: publisher.id, versions: [] }
    if (entry.publisher !== publisher.id) throw new Error(`${manifest.name} comes from both ${entry.publisher} and ${publisher.id}`)
    if (entry.versions.some((version) => version.version === manifest.version)) throw new Error(`${manifest.name} ${manifest.version} is here twice`)
    entry.versions.push({
      version: manifest.version,
      url,
      sha256,
      size: archive.length,
      signature: signature.trim(),
      reviewed: reviewed.has(`${manifest.name}@${manifest.version}`),
      manifest,
    })
    packages.set(manifest.name, entry)
    versions += 1
  }
  const index = {
    format: 1,
    name: config.name,
    issuedAt: (options.now ?? new Date()).toISOString(),
    publishers: publishers.map(({ publicKeys: _, ...publisher }) => publisher),
    packages: [...packages.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({
        ...entry,
        versions: entry.versions.sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true })),
      })),
  }
  const bytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`)
  const key = await privateKeyFrom(keyFile)
  const file = join(root, 'index.json')
  await writeFile(file, bytes)
  await writeFile(`${file}.sig`, `${sign(null, indexSigningMessage(bytes), key).toString('base64')}\n`)
  return { index: file, packages: packages.size, versions, key: publicKeyText(key) }
}
