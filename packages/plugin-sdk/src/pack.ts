import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import type { Permission } from './types.js'

/** Skills, archetypes, and workflows Factorix imports as data. Each points at a file in the package. */
export interface PackageContent {
  /** A skill's key is its slug. The file is its Markdown. */
  skills?: { key: string; name: string; file: string }[]
  /** The prompt file is the archetype's system prompt. */
  archetypes?: { key: string; name: string; role: 'engineer' | 'reviewer' | 'other'; description?: string; prompt?: string }[]
  /** Each file holds `{ name, description, definition }`, with skills named by slug. */
  workflows?: { key: string; file: string }[]
}

/** What Factorix reads first in a package: a server to run, or content to import. A server must not ask for more than this lists. */
export interface PackageManifest {
  format: 1
  name: string
  version: string
  description?: string
  publisher?: string
  entry?: string
  content?: PackageContent
  /** The rest is for a server only. */
  database?: boolean
  egress?: string[]
  permissions?: Permission[]
  memoryMb?: number
}

export interface PackOptions {
  /** Where the zip goes. Defaults to `<name>-<version>.zip` in the plugin's folder. */
  out?: string
}

export interface Packed {
  file: string
  manifest: PackageManifest
  files: string[]
  size: number
  sha256: string
}

/** The `factorix` field of package.json, where a packaged plugin says what it is. */
interface FactorixField {
  name?: string
  entry?: string
  database?: boolean
  egress?: string[]
  permissions?: Permission[]
  memoryMb?: number
  publisher?: string
  /** More files or folders to ship, such as `public`. The entry and README.md always go. */
  files?: string[]
  /** For a package of content in place of a server. */
  content?: PackageContent
}

const NAME = /^[a-z][a-z0-9-]{0,30}$/
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,30})?$/
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,99}$/
const PERMISSIONS: Permission[] = ['activity:read', 'agents:run', 'members:read', 'tickets:write', 'workflows:blocks']

function zipPath(path: string): string {
  const segments = path.split('/')
  if (path.length > 240 || !segments.every((segment) => SEGMENT.test(segment) && !/^\.+$/.test(segment))) {
    throw new Error(`${path} cannot go into a package: use letters, digits, and . _ - @ + in file names`)
  }
  return path
}

/** A zip Factorix reads: deflated entries with fixed dates, so the same files always give the same bytes. */
export function writeZip(files: Map<string, Buffer>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  const dosDate = (1 << 5) | 1
  for (const [path, data] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const name = Buffer.from(zipPath(path))
    const body = deflateRawSync(data)
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE((3 << 8) | 20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x800, 8)
    header.writeUInt16LE(8, 10)
    header.writeUInt16LE(dosDate, 14)
    header.writeUInt32LE(checksum, 16)
    header.writeUInt32LE(body.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    header.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    central.push(header, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.size, 8)
  end.writeUInt16LE(files.size, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

async function collect(root: string, path: string, into: Map<string, Buffer>): Promise<void> {
  const full = resolve(root, path)
  const inside = relative(root, full)
  if (!inside || inside.startsWith('..')) throw new Error(`${path} is outside the plugin's folder`)
  const info = await stat(full)
  if (info.isDirectory()) {
    for (const entry of await readdir(full)) if (entry !== 'node_modules' && !entry.startsWith('.')) await collect(root, join(inside, entry), into)
    return
  }
  into.set(zipPath(inside.split(sep).join('/')), await readFile(full))
}

/**
 * Packs a built plugin into the zip Factorix installs. The entry must already be one bundled JavaScript file, since
 * nothing is installed where it runs:
 *
 * `esbuild src/main.ts --bundle --platform=node --target=node22 --format=esm --outfile=dist/server.mjs`
 */
export async function packPlugin(dir: string, options: PackOptions = {}): Promise<Packed> {
  const root = resolve(dir)
  const own = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    name?: string
    version?: string
    description?: string
    factorix?: FactorixField
  }
  const field = own.factorix ?? {}
  const name = field.name ?? basename(String(own.name ?? '')).replace(/^factorix-plugin-/, '')
  if (!NAME.test(name)) throw new Error(`"${name}" is not a plugin name. Set factorix.name to lowercase letters, digits, and dashes`)
  const version = String(own.version ?? '')
  if (!VERSION.test(version)) throw new Error('Set version in package.json, such as 1.0.0')
  if (field.content) return packContent(root, field, { name, version, description: own.description }, options)
  if (!field.entry || !/\.(?:mjs|cjs|js)$/.test(field.entry)) {
    throw new Error('Set factorix.entry to the bundled JavaScript file Factorix runs, such as dist/server.mjs, or factorix.content')
  }
  const entry = relative(root, resolve(root, field.entry)).split(sep).join('/')
  const unknown = (field.permissions ?? []).filter((permission) => !PERMISSIONS.includes(permission))
  if (unknown.length > 0) throw new Error(`factorix.permissions names ${unknown.join(', ')}, which Factorix does not have`)

  const manifest: PackageManifest = {
    format: 1,
    name,
    version,
    ...(own.description ? { description: own.description.slice(0, 300) } : {}),
    ...(field.publisher ? { publisher: field.publisher } : {}),
    entry: zipPath(entry),
    database: field.database === true,
    egress: field.egress ?? [],
    permissions: field.permissions ?? [],
    memoryMb: field.memoryMb ?? 256,
  }
  const files = new Map<string, Buffer>()
  await collect(root, entry, files).catch((error: NodeJS.ErrnoException) => {
    throw error.code === 'ENOENT' ? new Error(`${field.entry} does not exist yet. Build the plugin first`) : error
  })
  for (const path of field.files ?? []) await collect(root, path, files)
  await collect(root, 'README.md', files).catch(() => undefined)
  return write(root, manifest, files, options)
}

async function write(root: string, manifest: PackageManifest, files: Map<string, Buffer>, options: PackOptions): Promise<Packed> {
  files.set('factorix-plugin.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
  const archive = writeZip(files)
  const file = resolve(options.out ?? join(root, `${manifest.name}-${manifest.version}.zip`))
  await writeFile(file, archive)
  return { file, manifest, files: [...files.keys()].sort(), size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }
}

async function packContent(
  root: string,
  field: FactorixField,
  about: { name: string; version: string; description?: string },
  options: PackOptions,
): Promise<Packed> {
  if (field.entry || field.database || field.egress?.length || field.permissions?.length || field.memoryMb) {
    throw new Error('A package of content runs nothing, so factorix lists no entry, database, egress, permissions, or memoryMb')
  }
  const content = field.content as PackageContent
  const normal = (path: string) => relative(root, resolve(root, path)).split(sep).join('/')
  const packed: PackageContent = {
    ...(content.skills?.length ? { skills: content.skills.map((skill) => ({ ...skill, file: normal(skill.file) })) } : {}),
    ...(content.archetypes?.length
      ? { archetypes: content.archetypes.map((archetype) => ({ ...archetype, ...(archetype.prompt ? { prompt: normal(archetype.prompt) } : {}) })) }
      : {}),
    ...(content.workflows?.length ? { workflows: content.workflows.map((workflow) => ({ ...workflow, file: normal(workflow.file) })) } : {}),
  }
  const paths = [
    ...(packed.skills ?? []).map((skill) => skill.file),
    ...(packed.archetypes ?? []).flatMap((archetype) => (archetype.prompt ? [archetype.prompt] : [])),
    ...(packed.workflows ?? []).map((workflow) => workflow.file),
  ]
  if (paths.length === 0 && !packed.archetypes?.length) throw new Error('factorix.content lists no skills, archetypes, or workflows')
  const files = new Map<string, Buffer>()
  for (const path of paths) {
    await collect(root, path, files).catch((error: NodeJS.ErrnoException) => {
      throw error.code === 'ENOENT' ? new Error(`${path} does not exist`) : error
    })
  }
  await collect(root, 'README.md', files).catch(() => undefined)
  const manifest: PackageManifest = {
    format: 1,
    name: about.name,
    version: about.version,
    ...(about.description ? { description: about.description.slice(0, 300) } : {}),
    ...(field.publisher ? { publisher: field.publisher } : {}),
    content: packed,
  }
  return write(root, manifest, files, options)
}
