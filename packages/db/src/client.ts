import knex, { type Knex } from 'knex'
import pg from 'pg'

pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number.parseFloat(value))

const snakeCache = new Map<string, string>()
const camelCache = new Map<string, string>()

function toSnake(value: string): string {
  let cached = snakeCache.get(value)
  if (cached === undefined) {
    cached = value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
    snakeCache.set(value, cached)
  }
  return cached
}

function toCamel(value: string): string {
  let cached = camelCache.get(value)
  if (cached === undefined) {
    cached = value.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
    camelCache.set(value, cached)
  }
  return cached
}

/** Only the top-level row keys are converted. JSONB column contents stay exactly as stored. */
function camelizeRow(row: unknown): unknown {
  if (row === null || typeof row !== 'object' || Array.isArray(row) || row instanceof Date || Buffer.isBuffer(row)) return row
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) out[toCamel(key)] = value
  return out
}

function postProcess(result: unknown): unknown {
  if (Array.isArray(result)) return result.map(camelizeRow)
  if (result !== null && typeof result === 'object' && 'rows' in result && Array.isArray((result as { rows: unknown[] }).rows)) {
    const raw = result as { rows: unknown[] }
    raw.rows = raw.rows.map(camelizeRow)
    return raw
  }
  return camelizeRow(result)
}

export type Db = Knex

export function createDb(connectionString: string, options: { max?: number } = {}): Db {
  return knex({
    client: 'pg',
    connection: connectionString,
    pool: { min: 0, max: options.max ?? 10 },
    wrapIdentifier: (value, origImpl) => (value === '*' ? value : origImpl(toSnake(value))),
    postProcessResponse: postProcess,
  })
}

/** pg serializes JS arrays as Postgres arrays, so JSONB values must go through this on write. */
export function json(value: unknown): string {
  return JSON.stringify(value)
}
