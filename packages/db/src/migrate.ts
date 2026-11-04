import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from './client'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const ADVISORY_LOCK_ID = 7_204_118

export async function migrate(db: Db, directory: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(directory)
    .filter((file) => /^\d{4}_.*\.sql$/.test(file))
    .sort()
  const applied: string[] = []
  await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(?)', [ADVISORY_LOCK_ID])
    await trx.raw('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    const done = await trx.raw<{ rows: { name: string }[] }>('SELECT name FROM schema_migrations')
    const seen = new Set(done.rows.map((row) => row.name))
    for (const file of files) {
      if (seen.has(file)) continue
      await trx.raw(readFileSync(join(directory, file), 'utf8').replace(/\?/g, '\\?'))
      await trx.raw('INSERT INTO schema_migrations (name) VALUES (?)', [file])
      applied.push(file)
    }
  })
  return applied
}
