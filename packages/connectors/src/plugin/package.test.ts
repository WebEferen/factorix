import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  checkServedManifest,
  PACKAGE_MANIFEST,
  packageArchive,
  packagedPluginManifest,
  parsePackageManifest,
  readPluginPackage,
  readZip,
} from './package'

interface Entry {
  name: string
  data?: Buffer
  stored?: boolean
  /** Unix mode bits, such as 0o120777 for a link. */
  mode?: number
  /** What the central directory claims, when it should lie. */
  size?: number
}

function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0)
    const body = entry.stored ? data : deflateRawSync(data)
    const name = Buffer.from(entry.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(entry.stored ? 0 : 8, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE((3 << 8) | 20, 4)
    header.writeUInt16LE(entry.stored ? 0 : 8, 10)
    header.writeUInt32LE(crc32(data), 16)
    header.writeUInt32LE(body.length, 20)
    header.writeUInt32LE(entry.size ?? data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    header.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    central.push(header, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const manifest = (extra: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ format: 1, name: 'timesheets', version: '1.2.0', entry: 'dist/server.mjs', ...extra }))

describe('plugin packages', () => {
  it('reads a package and its manifest', () => {
    const archive = zip([
      { name: PACKAGE_MANIFEST, data: manifest({ permissions: ['members:read'], egress: ['api.harvestapp.com'], database: true }) },
      { name: 'dist/', data: Buffer.alloc(0) },
      { name: 'dist/server.mjs', data: Buffer.from('console.log(1)\n'.repeat(100)) },
      { name: 'README.md', data: Buffer.from('# Timesheets'), stored: true },
    ])
    const read = readPluginPackage(archive)
    expect(read.manifest).toEqual({
      format: 1,
      name: 'timesheets',
      version: '1.2.0',
      entry: 'dist/server.mjs',
      database: true,
      egress: ['api.harvestapp.com'],
      permissions: ['members:read'],
      memoryMb: 256,
    })
    expect([...read.files.keys()].sort()).toEqual(['README.md', 'dist/server.mjs', PACKAGE_MANIFEST])
    expect(read.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    ['../escape.js', 'may not'],
    ['/etc/passwd', 'may not'],
    ['dist/../../x', 'may not'],
    ['dist\\server.mjs', 'may not'],
    ['a/./b', 'may not'],
    ['$(touch x).js', 'may not'],
  ])('refuses the name %s', (name, message) => {
    expect(() => readZip(zip([{ name, data: Buffer.from('x') }]))).toThrow(message)
  })

  it('refuses links, which would let the unpacked tree point anywhere', () => {
    expect(() => readZip(zip([{ name: 'link', data: Buffer.from('/etc'), mode: 0o120777 }]))).toThrow('links are not allowed')
  })

  it('refuses an entry that inflates past what it declared', () => {
    const bomb = zip([{ name: 'big.txt', data: Buffer.alloc(1_000_000), size: 10 }])
    expect(() => readZip(bomb)).toThrow('declared size')
  })

  it('refuses a package that declares more than it may unpack to', () => {
    const big = zip([{ name: 'big.txt', data: Buffer.alloc(2000) }])
    expect(() => readZip(big, { archiveBytes: 1e6, unpackedBytes: 1000, files: 10 })).toThrow('unpacks to at most')
  })

  it('needs a manifest and an entry that exists', () => {
    expect(() => readPluginPackage(zip([{ name: 'server.mjs', data: Buffer.from('') }]))).toThrow(`no ${PACKAGE_MANIFEST}`)
    expect(() => readPluginPackage(zip([{ name: PACKAGE_MANIFEST, data: manifest() }]))).toThrow('dist/server.mjs is not in the package')
  })

  it.each([
    [{ format: 2 }, 'reads format 1'],
    [{ name: 'Time Sheets' }, 'lowercase'],
    [{ version: 'latest' }, '1.2.3'],
    [{ entry: 'server.ts' }, 'JavaScript'],
    [{ entry: 'bin/run me.js' }, 'may not'],
    [{ egress: ['*'] }, 'host names'],
    [{ egress: ['10.0.0.1'] }, 'host names'],
    [{ permissions: ['admin'] }, 'may only name'],
    [{ memoryMb: 8192 }, 'memoryMb'],
  ])('refuses a manifest with %j', (extra, message) => {
    expect(() => parsePackageManifest(JSON.parse(manifest(extra).toString()))).toThrow(message)
  })

  it('unpacks with tar to the same files, root-owned and read-only for everyone else', () => {
    const files = new Map([
      ['server.mjs', Buffer.from('export {}\n')],
      ['public/css/site.css', Buffer.from('body{}')],
      [`deep/${'d'.repeat(90)}/${'f'.repeat(90)}.js`, Buffer.from('long')],
    ])
    const dir = mkdtempSync(join(tmpdir(), 'fx-package-'))
    try {
      writeFileSync(join(dir, 'source.tgz'), packageArchive(files))
      const listing = execFileSync('tar', ['-tvzf', join(dir, 'source.tgz')], { encoding: 'utf8' })
      expect(listing).toMatch(/-rw-r--r--.*server\.mjs/)
      expect(listing).toMatch(/drwxr-xr-x.*public\/css\//)
      execFileSync('tar', ['-xzf', join(dir, 'source.tgz'), '-C', dir])
      for (const [path, data] of files) expect(readFileSync(join(dir, path))).toEqual(data)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('holds the running plugin to what the package listed', () => {
    const listed = parsePackageManifest(JSON.parse(manifest({ permissions: ['members:read'] }).toString()))
    const served = packagedPluginManifest(listed)
    expect(() => checkServedManifest(listed, served)).not.toThrow()
    expect(() => checkServedManifest(listed, { ...served, permissions: ['members:read', 'agents:run'] })).toThrow('agents:run')
    expect(() => checkServedManifest(listed, { ...served, version: '1.3.0' })).toThrow('says it is timesheets 1.3.0')
  })
})
