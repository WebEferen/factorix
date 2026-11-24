import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { packPlugin } from './pack'

describe('packPlugin', () => {
  let dir: string
  const write = (path: string, content: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const describeIt = (factorix: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    write('package.json', JSON.stringify({ name: '@acme/factorix-plugin-hello', version: '1.2.3', description: 'Says hello', factorix, ...extra }))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fx-pack-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('packs the entry, the files it names, and the readme, the same bytes every time', async () => {
    describeIt({ entry: './dist/server.mjs', files: ['public'], permissions: ['members:read'], egress: ['api.example.com'], database: true })
    write('dist/server.mjs', 'export {}\n')
    write('dist/server.mjs.map', '{}')
    write('public/logo.svg', '<svg/>')
    write('public/.DS_Store', 'x')
    write('README.md', '# Hello')
    write('src/main.ts', 'export {}')

    const packed = await packPlugin(dir)
    expect(packed.file).toBe(join(dir, 'hello-1.2.3.zip'))
    expect(packed.files).toEqual(['README.md', 'dist/server.mjs', 'factorix-plugin.json', 'public/logo.svg'])
    expect(packed.manifest).toEqual({
      format: 1,
      name: 'hello',
      version: '1.2.3',
      description: 'Says hello',
      entry: 'dist/server.mjs',
      database: true,
      egress: ['api.example.com'],
      permissions: ['members:read'],
      memoryMb: 256,
    })
    const again = await packPlugin(dir, { out: join(dir, 'again.zip') })
    expect(again.sha256).toBe(packed.sha256)
    expect(readFileSync(again.file).equals(readFileSync(packed.file))).toBe(true)
  })

  it('says what is wrong before anything is written', async () => {
    describeIt({ entry: 'dist/server.mjs' })
    await expect(packPlugin(dir)).rejects.toThrow('Build the plugin first')
    describeIt({ entry: 'src/main.ts' })
    await expect(packPlugin(dir)).rejects.toThrow('bundled JavaScript file')
    describeIt({ entry: 'server.mjs', permissions: ['everything'] })
    await expect(packPlugin(dir)).rejects.toThrow('everything')
    describeIt({ entry: 'server.mjs', name: 'Hello World' })
    await expect(packPlugin(dir)).rejects.toThrow('not a plugin name')
    describeIt({ entry: 'server.mjs', files: ['../secrets'] })
    write('server.mjs', 'export {}')
    await expect(packPlugin(dir)).rejects.toThrow("outside the plugin's folder")
    describeIt({ entry: 'server.mjs' }, { version: 'latest' })
    await expect(packPlugin(dir)).rejects.toThrow('Set version')
  })
})
