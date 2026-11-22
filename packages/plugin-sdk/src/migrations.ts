/** One database connection that runs SQL with numbered parameters. A `pg` Client fits as it is. A Pool does not, since a transaction must stay on one connection. */
export interface SqlClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export interface Migration {
  /** Sorted as text to decide the order, so start it with a number: `0001_boards`. */
  id: string
  up: string
  down: string
}

const TABLE = 'plugin_migrations'

async function applied(db: SqlClient): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
  return (await db.query(`SELECT id FROM ${TABLE} ORDER BY id`)).rows.map((row) => String(row.id))
}

function ordered(migrations: Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => (a.id < b.id ? -1 : 1))
  if (new Set(sorted.map((migration) => migration.id)).size !== sorted.length) throw new Error('Two migrations share an id')
  return sorted
}

/**
 * Your plugin's own tables, in your plugin's own database. Each migration runs in a transaction with its record, so one
 * that fails leaves nothing behind. The lock keeps two instances starting at once from running the same one twice.
 */
export async function migrateUp(db: SqlClient, migrations: Migration[]): Promise<string[]> {
  const ran: string[] = []
  await db.query('SELECT pg_advisory_lock(hashtext($1))', [TABLE])
  try {
    const done = new Set(await applied(db))
    for (const migration of ordered(migrations)) {
      if (done.has(migration.id)) continue
      await db.query('BEGIN')
      try {
        await db.query(migration.up)
        await db.query(`INSERT INTO ${TABLE} (id) VALUES ($1)`, [migration.id])
        await db.query('COMMIT')
      } catch (error) {
        await db.query('ROLLBACK')
        throw new Error(`Migration ${migration.id} failed: ${(error as Error).message}`)
      }
      ran.push(migration.id)
    }
  } finally {
    await db.query('SELECT pg_advisory_unlock(hashtext($1))', [TABLE])
  }
  return ran
}

/** Rolls back the newest applied migrations, one unless `steps` says more. */
export async function migrateDown(db: SqlClient, migrations: Migration[], steps = 1): Promise<string[]> {
  const ran: string[] = []
  const byId = new Map(migrations.map((migration) => [migration.id, migration]))
  await db.query('SELECT pg_advisory_lock(hashtext($1))', [TABLE])
  try {
    for (const id of (await applied(db)).reverse().slice(0, steps)) {
      const migration = byId.get(id)
      if (!migration) throw new Error(`Migration ${id} is applied but no longer defined, so it cannot be rolled back`)
      await db.query('BEGIN')
      try {
        await db.query(migration.down)
        await db.query(`DELETE FROM ${TABLE} WHERE id = $1`, [id])
        await db.query('COMMIT')
      } catch (error) {
        await db.query('ROLLBACK')
        throw new Error(`Rolling back ${id} failed: ${(error as Error).message}`)
      }
      ran.push(id)
    }
  } finally {
    await db.query('SELECT pg_advisory_unlock(hashtext($1))', [TABLE])
  }
  return ran
}
