import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundledPluginSecret } from '@factorix/connectors'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { childEnv, databaseUrlFor, discoverPlugins } from './plugins'

describe('discoverPlugins', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fx-plugins-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  const plugin = async (name: string, manifest: unknown, files: string[] = ['src/main.ts']) => {
    await mkdir(join(dir, name, 'src'), { recursive: true })
    if (manifest !== undefined) await writeFile(join(dir, name, 'package.json'), JSON.stringify(manifest))
    for (const file of files) await writeFile(join(dir, name, file), '')
  }

  it('finds plugins by their factorix field and says why it skipped the rest', async () => {
    await plugin('digest', { factorix: { main: 'src/main.ts', database: true } })
    await plugin('board-2', { factorix: { main: 'src/main.ts' } })
    await plugin('Bad_Name', { factorix: { main: 'src/main.ts' } })
    await plugin('plugins', { factorix: { main: 'src/main.ts' } })
    await plugin('__shared', { factorix: { main: 'src/main.ts' } })
    await plugin('no-manifest', undefined)
    await plugin('library', { name: 'just-a-package' })
    await plugin('escapes', { factorix: { main: '../digest/src/main.ts' } })
    await plugin('missing', { factorix: { main: 'src/server.ts' } })
    await writeFile(join(dir, 'README.md'), '')
    const logs: string[] = []

    const found = await discoverPlugins(dir, (message) => logs.push(message))

    expect(found).toEqual([
      { name: 'board-2', dir: join(dir, 'board-2'), main: join(dir, 'board-2/src/main.ts'), database: false },
      { name: 'digest', dir: join(dir, 'digest'), main: join(dir, 'digest/src/main.ts'), database: true },
    ])
    for (const skipped of ['Bad_Name', 'plugins', '__shared', 'no-manifest', 'library', 'escapes', 'missing'])
      expect(logs.some((line) => line.startsWith(`Skipping plugins/${skipped}:`))).toBe(true)
  })

  it('runs nothing when the folder is missing', async () => {
    const logs: string[] = []
    expect(await discoverPlugins(join(dir, 'nowhere'), (message) => logs.push(message))).toEqual([])
    expect(logs).toHaveLength(1)
  })
})

describe('childEnv', () => {
  const base = {
    key: 'the-installation-plugins-key',
    port: 51234,
    factorixUrl: 'http://api:4100',
    names: ['digest', 'digest-extra'],
    hostEnv: {
      PATH: '/usr/bin',
      HOME: '/home/node',
      NODE_ENV: 'production',
      FACTORIX_PLUGINS_KEY: 'the-installation-plugins-key',
      FACTORIX_PLUGINS_DATABASE_URL: 'postgres://plugins:plugins@plugins-db:5432/plugins',
      DATABASE_URL: 'postgres://factorix:factorix@postgres:5432/factorix',
      FACTORIX_SECRET_KEY: 'never',
      PLUGIN_DIGEST_SLACK_TOKEN: 'xoxb-1',
      PLUGIN_DIGEST_PORT: '1',
      PLUGIN_DIGEST_EXTRA_COLOR: 'blue',
      PLUGIN_OTHER_TOKEN: 'not-for-digest',
    },
  }

  it('gives a plugin its own secret, its own config, and nothing else of the host', () => {
    expect(childEnv({ name: 'digest' }, { ...base, databaseUrl: 'postgres://plugins:plugins@plugins-db:5432/plugin_digest' })).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/node',
      NODE_ENV: 'production',
      SLACK_TOKEN: 'xoxb-1',
      PLUGIN_SECRET: bundledPluginSecret('the-installation-plugins-key', 'digest'),
      PORT: '51234',
      HOST: '127.0.0.1',
      FACTORIX_URL: 'http://api:4100',
      DATABASE_URL: 'postgres://plugins:plugins@plugins-db:5432/plugin_digest',
    })
  })

  it('hands config to the plugin with the longest matching name', () => {
    const extra = childEnv({ name: 'digest-extra' }, base)
    expect(extra.COLOR).toBe('blue')
    expect(extra.SLACK_TOKEN).toBeUndefined()
    expect(extra.DATABASE_URL).toBeUndefined()
    expect(extra.PLUGIN_SECRET).not.toBe(childEnv({ name: 'digest' }, base).PLUGIN_SECRET)
    expect(Object.values(extra)).not.toContain('the-installation-plugins-key')
  })
})

it('points the admin connection at the plugin database', () => {
  expect(databaseUrlFor('postgres://plugins:s3cret@plugins-db:5432/plugins?sslmode=disable', 'team-board')).toBe(
    'postgres://plugins:s3cret@plugins-db:5432/plugin_team_board?sslmode=disable',
  )
})
