import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createPluginHost } from './host'
import { type BundledPlugin, childEnv, databaseName, databaseUrlFor, discoverPlugins } from './plugins'

const env = process.env
const port = Number(env.PORT || 4110)
const hostname = env.HOST || '0.0.0.0'
const key = env.FACTORIX_PLUGINS_KEY ?? ''
const factorixUrl = env.FACTORIX_INTERNAL_URL || 'http://localhost:4100'
const dir = env.FACTORIX_PLUGINS_DIR || fileURLToPath(new URL('../../../plugins', import.meta.url))
const adminUrl = env.FACTORIX_PLUGINS_DATABASE_URL || ''
const log = (message: string) => console.error(`[plugin-host] ${message}`)

/** Each plugin with a database gets its own, made on its first start. Its name passed BUNDLED_PLUGIN_NAME, so it is safe to quote. */
async function ensureDatabase(plugin: BundledPlugin): Promise<string> {
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  try {
    const name = databaseName(plugin.name)
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    if (found.rowCount === 0) {
      await client.query(`CREATE DATABASE "${name}"`).catch((error: { code?: string }) => {
        if (error.code !== '42P04') throw error
      })
      log(`created database ${name} for ${plugin.name}`)
    }
    return databaseUrlFor(adminUrl, plugin.name)
  } finally {
    await client.end()
  }
}

async function plugins(): Promise<BundledPlugin[]> {
  if (!key) {
    log('FACTORIX_PLUGINS_KEY is not set, so bundled plugins are off')
    return []
  }
  const found = await discoverPlugins(dir, log)
  return found.filter((plugin) => {
    if (!plugin.database || adminUrl) return true
    log(`Skipping plugins/${plugin.name}: it needs a database and FACTORIX_PLUGINS_DATABASE_URL is not set`)
    return false
  })
}

const bundled = await plugins()
const names = bundled.map((plugin) => plugin.name)
const host = createPluginHost({
  plugins: bundled,
  log,
  env: async (plugin, childPort) =>
    childEnv(plugin, {
      key,
      port: childPort,
      factorixUrl,
      names,
      hostEnv: env,
      ...(plugin.database ? { databaseUrl: await ensureDatabase(plugin) } : {}),
    }),
})

host.server.listen(port, hostname, () => {
  log(`listening on ${port}, with ${names.length ? names.join(', ') : 'no plugins'}`)
  host.start()
})

let stopping = false
const shutdown = () => {
  if (stopping) return
  stopping = true
  void host.stop().finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
