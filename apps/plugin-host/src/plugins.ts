import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { BUNDLED_PLUGIN_NAME, bundledPluginSecret } from '@factorix/connectors'

export interface BundledPlugin {
  name: string
  dir: string
  /** The file tsx starts, inside `dir`. */
  main: string
  database: boolean
}

const RESERVED = new Set(['plugins'])

/** Every folder of `dir` whose package.json has a `factorix` field. Anything else is skipped and said so, never fatal. */
export async function discoverPlugins(dir: string, log: (message: string) => void): Promise<BundledPlugin[]> {
  let entries: string[]
  try {
    entries = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    log(`No plugins folder at ${dir}: ${(error as Error).message}`)
    return []
  }
  const plugins: BundledPlugin[] = []
  for (const name of entries.sort()) {
    if (name.startsWith('.')) continue
    if (RESERVED.has(name) || name.startsWith('__') || !BUNDLED_PLUGIN_NAME.test(name)) {
      log(`Skipping plugins/${name}: a plugin's folder is named with lowercase letters, digits, and dashes, and not "plugins"`)
      continue
    }
    const pluginDir = join(dir, name)
    let manifest: { factorix?: { main?: unknown; database?: unknown } }
    try {
      manifest = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'))
    } catch {
      log(`Skipping plugins/${name}: it has no readable package.json`)
      continue
    }
    const factorix = manifest.factorix
    if (!factorix || typeof factorix !== 'object') {
      log(`Skipping plugins/${name}: its package.json has no "factorix" field`)
      continue
    }
    const main = typeof factorix.main === 'string' ? factorix.main : ''
    const file = resolve(pluginDir, main)
    const inside = relative(pluginDir, file)
    if (!main || isAbsolute(main) || inside.startsWith('..') || isAbsolute(inside)) {
      log(`Skipping plugins/${name}: "factorix.main" must name a file inside its folder`)
      continue
    }
    if (!(await stat(file).catch(() => null))?.isFile()) {
      log(`Skipping plugins/${name}: ${main} does not exist`)
      continue
    }
    plugins.push({ name, dir: pluginDir, main: file, database: factorix.database === true })
  }
  return plugins
}

export const envPrefix = (name: string) => `PLUGIN_${name.toUpperCase().replace(/-/g, '_')}_`

export interface ChildEnvInput {
  key: string
  port: number
  factorixUrl: string
  databaseUrl?: string
  /** Every bundled plugin's name, so `PLUGIN_A_B_X` reaches plugin `a-b` and not plugin `a`. */
  names: string[]
  hostEnv: NodeJS.ProcessEnv
}

/** What one plugin starts with: its own secret, never the key, and only the installation config addressed to it. */
export function childEnv(plugin: Pick<BundledPlugin, 'name'>, input: ChildEnvInput): Record<string, string> {
  const own = envPrefix(plugin.name)
  const prefixes = [...new Set([...input.names, plugin.name])].map(envPrefix).sort((a, b) => b.length - a.length)
  const passed: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.hostEnv)) {
    if (value === undefined || !key.startsWith('PLUGIN_')) continue
    if (prefixes.find((prefix) => key.startsWith(prefix)) !== own) continue
    const name = key.slice(own.length)
    if (name) passed[name] = value
  }
  const inherited: Record<string, string> = {}
  for (const key of ['NODE_ENV', 'PATH', 'HOME', 'TZ']) {
    const value = input.hostEnv[key]
    if (value !== undefined) inherited[key] = value
  }
  return {
    ...passed,
    ...inherited,
    PLUGIN_SECRET: bundledPluginSecret(input.key, plugin.name),
    PORT: String(input.port),
    HOST: '127.0.0.1',
    FACTORIX_URL: input.factorixUrl,
    ...(input.databaseUrl ? { DATABASE_URL: input.databaseUrl } : {}),
  }
}

export const databaseName = (name: string) => `plugin_${name.replace(/-/g, '_')}`

/** The admin connection's address and credentials, pointed at one plugin's own database. */
export function databaseUrlFor(adminUrl: string, name: string): string {
  const url = new URL(adminUrl)
  url.pathname = `/${databaseName(name)}`
  return url.toString()
}
