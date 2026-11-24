import { createHash } from 'node:crypto'
import { crc32, gzipSync, inflateRawSync } from 'node:zlib'
import { BUNDLED_PLUGIN_NAME, PLUGIN_PERMISSIONS, PLUGIN_PROTOCOL, type PluginManifest, type PluginPermission } from './protocol'

/**
 * A package is a zip with `factorix-plugin.json` at its root, uploaded by an organization's admin for that organization
 * alone. It holds either a plugin Factorix runs itself, as one bundled JavaScript file that serves the plugin protocol,
 * or content Factorix imports as data: skills, archetypes, and workflows.
 */
export const PACKAGE_FORMAT = 1
export const PACKAGE_MANIFEST = 'factorix-plugin.json'
export const PACKAGE_LIMITS = { archiveBytes: 10 * 1024 * 1024, unpackedBytes: 64 * 1024 * 1024, files: 2000 }
export const PACKAGE_MEMORY_MB = { min: 64, default: 256, max: 1024 }
/** Where its server listens inside its container. */
export const PACKAGE_PORT = 8080
/** People open a package's pages under Factorix's own address, which the web passes to the preview gateway. */
export const PACKAGE_PAGES = '/_package'
export const PACKAGE_SLUG = /^[a-z0-9]{10}$/
/** How many of each kind of content one package may hold. */
export const PACKAGE_CONTENT_MAX = 100
export const PACKAGE_ARCHETYPE_ROLES = ['engineer', 'reviewer', 'other'] as const

export interface PackageContent {
  /** A skill's key is its slug. */
  skills: { key: string; name: string; file: string }[]
  archetypes: { key: string; name: string; role: (typeof PACKAGE_ARCHETYPE_ROLES)[number]; description: string; prompt?: string }[]
  /** Each file holds `{ name, description, definition }`, as the workflow editor stores it. */
  workflows: { key: string; file: string }[]
}

export interface PluginPackageManifest {
  format: typeof PACKAGE_FORMAT
  name: string
  version: string
  description?: string
  publisher?: string
  /** The file `node` runs, relative to the package root. A package has this or `content`. */
  entry?: string
  content?: PackageContent
  /** Gives it a Postgres of its own, as DATABASE_URL. */
  database: boolean
  /** The only hosts it may reach, besides Factorix. `*.example.com` covers subdomains. */
  egress: string[]
  /** The most its served manifest may ask for. */
  permissions: PluginPermission[]
  memoryMb: number
}

export interface PluginPackage {
  manifest: PluginPackageManifest
  files: Map<string, Buffer>
  sha256: string
  size: number
}

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,30})?$/
/** Safe to put in a shell command unquoted, which is how the entry reaches `node`. */
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,99}$/
const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const KEY = /^[a-z0-9][a-z0-9-]{1,39}$/

function packagePath(value: string): string {
  const segments = value.split('/')
  if (value.length > 240 || segments.length > 16 || !segments.every((segment) => PATH_SEGMENT.test(segment) && !/^\.+$/.test(segment))) {
    throw new Error(`The package holds a file it may not: ${JSON.stringify(value.slice(0, 120))}`)
  }
  return value
}

const optionalText = (value: unknown, max: number, label: string): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} must be text of at most ${max} characters`)
  return value
}

function parseContent(value: unknown): PackageContent {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const list = (kind: keyof PackageContent): Record<string, unknown>[] => {
    const items = raw[kind] ?? []
    if (!Array.isArray(items) || items.length > PACKAGE_CONTENT_MAX || !items.every((item) => item && typeof item === 'object')) {
      throw new Error(`content.${kind} lists up to ${PACKAGE_CONTENT_MAX} entries`)
    }
    const keys = items.map((item) => String(item.key ?? ''))
    const bad = keys.find((key) => !KEY.test(key))
    if (bad !== undefined)
      throw new Error(`content.${kind} has the key ${JSON.stringify(bad.slice(0, 60))}: use 2 to 40 lowercase letters, digits, and dashes`)
    if (new Set(keys).size !== keys.length) throw new Error(`Each entry in content.${kind} needs a key of its own`)
    return items
  }
  const name = (item: Record<string, unknown>, kind: string) => {
    const text = String(item.name ?? '').trim()
    if (!text || text.length > 60) throw new Error(`The ${kind} ${String(item.key)} needs a name of at most 60 characters`)
    return text
  }
  const file = (item: Record<string, unknown>, field: string) => packagePath(String(item[field] ?? ''))
  const content: PackageContent = {
    skills: list('skills').map((item) => ({ key: String(item.key), name: name(item, 'skill'), file: file(item, 'file') })),
    archetypes: list('archetypes').map((item) => {
      const role = item.role as PackageContent['archetypes'][number]['role']
      if (!PACKAGE_ARCHETYPE_ROLES.includes(role))
        throw new Error(`The archetype ${String(item.key)} works as ${PACKAGE_ARCHETYPE_ROLES.join(', or ')}`)
      return {
        key: String(item.key),
        name: name(item, 'archetype'),
        role,
        description: optionalText(item.description, 500, `The description of ${String(item.key)}`) ?? '',
        ...(item.prompt === undefined ? {} : { prompt: file(item, 'prompt') }),
      }
    }),
    workflows: list('workflows').map((item) => ({ key: String(item.key), file: file(item, 'file') })),
  }
  if (content.skills.length + content.archetypes.length + content.workflows.length === 0) throw new Error('content lists nothing to import')
  return content
}

/** Every file a package's content points at. */
export function packageContentFiles(content: PackageContent): string[] {
  return [
    ...content.skills.map((skill) => skill.file),
    ...content.archetypes.flatMap((archetype) => (archetype.prompt ? [archetype.prompt] : [])),
    ...content.workflows.map((workflow) => workflow.file),
  ]
}

/** The manifest comes from whoever built the package, so it is read field by field and anything unexpected is refused. */
export function parsePackageManifest(value: unknown): PluginPackageManifest {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  if (raw.format !== PACKAGE_FORMAT)
    throw new Error(`This package has format ${String(raw.format)}, and this Factorix reads format ${PACKAGE_FORMAT}`)
  const name = String(raw.name ?? '')
  if (!BUNDLED_PLUGIN_NAME.test(name))
    throw new Error('The package name is lowercase letters, digits, and dashes, up to 31 characters, starting with a letter')
  const version = String(raw.version ?? '')
  if (!VERSION.test(version)) throw new Error('The package version looks like 1.2.3')
  const content = raw.content === undefined ? undefined : parseContent(raw.content)
  if ((raw.entry === undefined) === (content === undefined)) {
    throw new Error('A package names either an entry, the server Factorix runs, or content, what Factorix imports')
  }
  const entry = content ? undefined : String(raw.entry ?? '')
  if (entry !== undefined) {
    if (!/\.(?:mjs|cjs|js)$/.test(entry)) throw new Error('The entry is the JavaScript file to run, such as server.mjs')
    packagePath(entry)
  }
  const egress = raw.egress ?? []
  if (!Array.isArray(egress) || egress.length > 20 || !egress.every((host) => typeof host === 'string' && host.length <= 253 && HOST.test(host))) {
    throw new Error('egress lists up to 20 host names, such as api.example.com or *.example.com')
  }
  const permissions = raw.permissions ?? []
  if (!Array.isArray(permissions) || !permissions.every((permission) => typeof permission === 'string' && permission in PLUGIN_PERMISSIONS)) {
    throw new Error(`permissions may only name ${Object.keys(PLUGIN_PERMISSIONS).join(', ')}`)
  }
  const memory = raw.memoryMb ?? PACKAGE_MEMORY_MB.default
  if (!Number.isInteger(memory) || (memory as number) < PACKAGE_MEMORY_MB.min || (memory as number) > PACKAGE_MEMORY_MB.max) {
    throw new Error(`memoryMb is a whole number from ${PACKAGE_MEMORY_MB.min} to ${PACKAGE_MEMORY_MB.max}`)
  }
  if (raw.database !== undefined && typeof raw.database !== 'boolean') throw new Error('database is true or false')
  // A stored manifest is read again, so the default memory it was given stays readable.
  if (content && (raw.database === true || egress.length > 0 || permissions.length > 0 || memory !== PACKAGE_MEMORY_MB.default)) {
    throw new Error('Content runs nothing, so a package of content lists no database, egress, permissions, or memory')
  }
  const description = optionalText(raw.description, 300, 'description')
  const publisher = optionalText(raw.publisher, 80, 'publisher')
  return {
    format: PACKAGE_FORMAT,
    name,
    version,
    ...(description ? { description } : {}),
    ...(publisher ? { publisher } : {}),
    ...(entry ? { entry } : {}),
    ...(content ? { content } : {}),
    database: raw.database === true,
    egress: [...new Set(egress as string[])],
    permissions: [...new Set(permissions as PluginPermission[])],
    memoryMb: memory as number,
  }
}

/**
 * Reads a zip without trusting it: every name is checked before anything is unpacked, links and encrypted entries are
 * refused, and sizes are capped as declared and again as inflated.
 */
export function readZip(archive: Buffer, limits = PACKAGE_LIMITS): Map<string, Buffer> {
  const corrupt = (why: string) => new Error(`This is not a zip Factorix can read: ${why}`)
  let end = -1
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 0xffff); at -= 1) {
    if (archive.readUInt32LE(at) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end < 0) throw corrupt('no end of central directory')
  const count = archive.readUInt16LE(end + 10)
  const directorySize = archive.readUInt32LE(end + 12)
  const directoryAt = archive.readUInt32LE(end + 16)
  if (archive.readUInt16LE(end + 4) !== 0 || count === 0xffff || directoryAt === 0xffffffff)
    throw corrupt('split or zip64 archives are not supported')
  if (directoryAt + directorySize > end) throw corrupt('the central directory is out of bounds')
  if (count > limits.files) throw new Error(`A package holds at most ${limits.files} files`)

  const files = new Map<string, Buffer>()
  let declared = 0
  let at = directoryAt
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > end || archive.readUInt32LE(at) !== 0x02014b50) throw corrupt('a broken central directory entry')
    const madeBy = archive.readUInt16LE(at + 4)
    const flags = archive.readUInt16LE(at + 8)
    const method = archive.readUInt16LE(at + 10)
    const checksum = archive.readUInt32LE(at + 16)
    const compressed = archive.readUInt32LE(at + 20)
    const size = archive.readUInt32LE(at + 24)
    const nameLength = archive.readUInt16LE(at + 28)
    const next = at + 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32)
    const external = archive.readUInt32LE(at + 38)
    const localAt = archive.readUInt32LE(at + 42)
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength)
    at = next
    if (flags & 0x1) throw new Error('Encrypted packages are not supported')
    const unixMode = madeBy >> 8 === 3 ? external >>> 16 : 0
    if ((unixMode & 0o170000) === 0o120000) throw new Error(`The package holds a link, ${JSON.stringify(name)}, and links are not allowed`)
    if (name.endsWith('/')) continue
    const path = packagePath(name)
    if (files.has(path)) throw corrupt(`${path} appears twice`)
    if (method !== 0 && method !== 8) throw corrupt(`${path} is compressed in a way Factorix does not read`)
    declared += size
    if (declared > limits.unpackedBytes) throw new Error(`A package unpacks to at most ${limits.unpackedBytes / 1024 / 1024} MB`)
    if (localAt + 30 > end || archive.readUInt32LE(localAt) !== 0x04034b50) throw corrupt(`${path} has no local header`)
    const dataAt = localAt + 30 + archive.readUInt16LE(localAt + 26) + archive.readUInt16LE(localAt + 28)
    if (dataAt + compressed > end) throw corrupt(`${path} is out of bounds`)
    const raw = archive.subarray(dataAt, dataAt + compressed)
    let data: Buffer
    try {
      data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) })
    } catch {
      throw corrupt(`${path} does not inflate to its declared size`)
    }
    if (data.length !== size || crc32(data) !== checksum) throw corrupt(`${path} fails its checksum`)
    files.set(path, data)
  }
  return files
}

export function readPluginPackage(archive: Buffer): PluginPackage {
  if (archive.length > PACKAGE_LIMITS.archiveBytes) throw new Error(`A package is at most ${PACKAGE_LIMITS.archiveBytes / 1024 / 1024} MB`)
  const files = readZip(archive)
  const raw = files.get(PACKAGE_MANIFEST)
  if (!raw) throw new Error(`The package has no ${PACKAGE_MANIFEST} at its root`)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error(`${PACKAGE_MANIFEST} is not JSON`)
  }
  const manifest = parsePackageManifest(parsed)
  for (const path of manifest.content ? packageContentFiles(manifest.content) : [manifest.entry as string]) {
    if (!files.has(path)) throw new Error(`${path} is not in the package`)
  }
  return { manifest, files, sha256: createHash('sha256').update(archive).digest('hex'), size: archive.length }
}

function tarHeader(path: string, size: number, directory: boolean): Buffer {
  const header = Buffer.alloc(512)
  let name = path
  let prefix = ''
  if (name.length > 100) {
    const split = [...path.matchAll(/\//g)].map((match) => match.index).find((index) => index <= 155 && path.length - index - 1 <= 100)
    if (split === undefined) throw new Error(`${path} is too long to unpack`)
    prefix = path.slice(0, split)
    name = path.slice(split + 1)
  }
  const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, '0')}\0`
  header.write(name, 0, 100, 'utf8')
  header.write(octal(directory ? 0o755 : 0o644, 8), 100)
  header.write(octal(0, 8), 108)
  header.write(octal(0, 8), 116)
  header.write(octal(size, 12), 124)
  header.write(octal(0, 12), 136)
  header.write('        ', 148)
  header.write(directory ? '5' : '0', 156)
  header.write('ustar\u000000', 257)
  header.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return header
}

/** The files as a gzipped tar owned by root and readable by all, which is what the sandbox unpacks into the source volume. */
export function packageArchive(files: Map<string, Buffer>): Buffer {
  const parts: Buffer[] = []
  const directories = new Set<string>()
  for (const path of [...files.keys()].sort()) {
    const segments = path.split('/')
    for (let depth = 1; depth < segments.length; depth += 1) {
      const directory = `${segments.slice(0, depth).join('/')}/`
      if (directories.has(directory)) continue
      directories.add(directory)
      parts.push(tarHeader(directory, 0, true))
    }
    const data = files.get(path) as Buffer
    parts.push(tarHeader(path, data.length, false), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

/** What the plugin is taken to be until its own server answers: no pages, settings, or blocks, and only what the package asks for. */
export function packagedPluginManifest(manifest: PluginPackageManifest): PluginManifest {
  return {
    protocol: PLUGIN_PROTOCOL,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description ? { description: manifest.description } : {}),
    provides: [],
    permissions: manifest.permissions,
    connection: { fields: [] },
    settings: { fields: [] },
    pages: [],
    blocks: [],
    triggers: [],
  }
}

/** The running plugin must be the one the admin saw: same name and version, and no permission the package did not list. */
export function checkServedManifest(manifest: PluginPackageManifest, served: PluginManifest): void {
  if (served.name !== manifest.name || served.version !== manifest.version) {
    throw new Error(`The package is ${manifest.name} ${manifest.version}, but its server says it is ${served.name} ${served.version}`)
  }
  const extra = served.permissions.filter((permission) => !manifest.permissions.includes(permission))
  if (extra.length > 0) throw new Error(`Its server asks for ${extra.join(', ')}, which ${PACKAGE_MANIFEST} does not list`)
}

/** Where Factorix calls a package, through the preview gateway's internal port, and where people open its pages. */
export function packageUrls(slug: string, internalUrl: string, factorixUrl: string): { url: string; pageUrl: string } {
  return {
    url: `${new URL(internalUrl).origin}/${slug}/factorix`,
    pageUrl: `${new URL(factorixUrl).origin}${PACKAGE_PAGES}/${slug}/factorix`,
  }
}
