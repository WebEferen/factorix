import { factorix, migrateUp } from '@moxxy/factorix-plugin-sdk'
import { serve } from '@moxxy/factorix-plugin-sdk/node'
import pg from 'pg'
import { type Deps, sweep } from './digests'
import { digestPlugin } from './plugin'
import { MIGRATIONS, pgStore } from './store'

const SWEEP_MS = 30_000

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}. The plugin host sets it for a plugin in Factorix's plugins/ folder`)
  return value
}

const secret = required('PLUGIN_SECRET')
const factorixUrl = required('FACTORIX_URL')
const pool = new pg.Pool({ connectionString: required('DATABASE_URL'), max: 5 })
const log = (message: string) => console.log(`[digest] ${message}`)

const client = await pool.connect()
try {
  const ran = await migrateUp(client, MIGRATIONS)
  if (ran.length > 0) log(`migrated ${ran.join(', ')}`)
} finally {
  client.release()
}

const deps: Deps = { store: pgStore(pool), factorix: (pluginId) => factorix({ url: factorixUrl, secret, pluginId }), log }
const port = Number(process.env.PORT ?? 8790)
const server = await serve(digestPlugin(deps), { secret, port, hostname: process.env.HOST ?? '0.0.0.0' })
log(`listening on ${process.env.HOST ?? '0.0.0.0'}:${port}`)

let sweeping = false
const timer = setInterval(() => {
  if (sweeping) return
  sweeping = true
  sweep(deps)
    .catch((error: Error) => log(`sweep failed: ${error.message}`))
    .finally(() => {
      sweeping = false
    })
}, SWEEP_MS)

for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    clearInterval(timer)
    server.close(() => void pool.end().then(() => process.exit(0)))
  })
