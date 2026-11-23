import type { Migration } from '@moxxy/factorix-plugin-sdk'
import type { DigestContent } from './content'
import type { DigestFacts } from './facts'
import type { ScheduleTime } from './schedule'

export interface Schedule extends ScheduleTime {
  orgId: string
  /** The plugin's id in Factorix. Pages say it, and the sweep, which has no page, reads it from here. */
  pluginId: string
  enabled: boolean
  agentId: string | null
  /** When the next digest is written, or null while the schedule is off. */
  nextAt: Date | null
}

export type DigestStatus = 'writing' | 'ready' | 'failed'

export interface Digest {
  id: string
  orgId: string
  status: DigestStatus
  runId: string | null
  runUrl: string | null
  periodStart: Date
  periodEnd: Date
  facts: DigestFacts
  content: DigestContent | null
  error: string | null
  createdAt: Date
}

export type DigestChange = Partial<Pick<Digest, 'status' | 'runId' | 'runUrl' | 'content' | 'error'>>

/** Everything the plugin keeps. One plugin serves every organization that turned it on, so every row has its organization. */
export interface Store {
  schedule(orgId: string): Promise<Schedule | null>
  saveSchedule(schedule: Schedule): Promise<void>
  /** Records the plugin id an organization's pages came with, keeping the rest of its schedule. */
  rememberPlugin(orgId: string, pluginId: string): Promise<void>
  dueSchedules(now: Date): Promise<Schedule[]>
  /** Moves a due schedule on to `to`, only if it still says `from`, so two instances never write the same digest. */
  claim(orgId: string, from: Date, to: Date | null): Promise<boolean>
  digests(orgId: string, limit: number): Promise<Digest[]>
  digest(orgId: string, id: string): Promise<Digest | null>
  /** The newest digest with content, which the next one starts after. */
  lastWritten(orgId: string): Promise<Digest | null>
  /** Digests still being written, of one organization or of all. */
  writing(orgId?: string): Promise<Digest[]>
  insertDigest(digest: Digest): Promise<void>
  updateDigest(id: string, change: DigestChange): Promise<void>
}

export const DEFAULT_SCHEDULE = { enabled: false, days: 'weekdays', time: '17:00', timezone: 'UTC', agentId: null, nextAt: null } as const

export const MIGRATIONS: Migration[] = [
  {
    id: '0001_digests',
    up: `
CREATE TABLE digest_schedules (
  org_id text PRIMARY KEY,
  plugin_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  days text NOT NULL DEFAULT 'weekdays' CHECK (days IN ('daily', 'weekdays')),
  time text NOT NULL DEFAULT '17:00',
  timezone text NOT NULL DEFAULT 'UTC',
  agent_id text,
  next_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX digest_schedules_due ON digest_schedules (next_at) WHERE enabled;
CREATE TABLE digests (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('writing', 'ready', 'failed')),
  run_id text,
  run_url text,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  facts jsonb NOT NULL,
  content jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX digests_org_created ON digests (org_id, created_at DESC);
CREATE INDEX digests_writing ON digests (org_id) WHERE status = 'writing';`,
    down: 'DROP TABLE digests; DROP TABLE digest_schedules;',
  },
]

/** A `pg` Pool, or anything else that runs one statement with numbered parameters. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
}

const date = (value: unknown) => (value instanceof Date ? value : new Date(String(value)))
const orNull = <T>(value: unknown) => (value ?? null) as T | null

function scheduleOf(row: Record<string, unknown>): Schedule {
  return {
    orgId: String(row.org_id),
    pluginId: String(row.plugin_id),
    enabled: Boolean(row.enabled),
    days: row.days === 'daily' ? 'daily' : 'weekdays',
    time: String(row.time),
    timezone: String(row.timezone),
    agentId: orNull<string>(row.agent_id),
    nextAt: row.next_at ? date(row.next_at) : null,
  }
}

function digestOf(row: Record<string, unknown>): Digest {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    status: row.status as Digest['status'],
    runId: orNull<string>(row.run_id),
    runUrl: orNull<string>(row.run_url),
    periodStart: date(row.period_start),
    periodEnd: date(row.period_end),
    facts: row.facts as DigestFacts,
    content: orNull<DigestContent>(row.content),
    error: orNull<string>(row.error),
    createdAt: date(row.created_at),
  }
}

const COLUMNS: Record<keyof DigestChange, string> = { status: 'status', runId: 'run_id', runUrl: 'run_url', content: 'content', error: 'error' }

export function pgStore(db: Queryable): Store {
  const one = async <T>(sql: string, params: unknown[], map: (row: Record<string, unknown>) => T) => {
    const row = (await db.query(sql, params)).rows[0]
    return row ? map(row) : null
  }
  return {
    schedule: (orgId) => one('SELECT * FROM digest_schedules WHERE org_id = $1', [orgId], scheduleOf),
    async saveSchedule(s) {
      await db.query(
        `INSERT INTO digest_schedules (org_id, plugin_id, enabled, days, time, timezone, agent_id, next_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (org_id) DO UPDATE SET plugin_id = $2, enabled = $3, days = $4, time = $5, timezone = $6, agent_id = $7, next_at = $8, updated_at = now()`,
        [s.orgId, s.pluginId, s.enabled, s.days, s.time, s.timezone, s.agentId, s.nextAt],
      )
    },
    async rememberPlugin(orgId, pluginId) {
      await db.query(
        `INSERT INTO digest_schedules (org_id, plugin_id) VALUES ($1, $2)
         ON CONFLICT (org_id) DO UPDATE SET plugin_id = $2 WHERE digest_schedules.plugin_id IS DISTINCT FROM $2`,
        [orgId, pluginId],
      )
    },
    async dueSchedules(now) {
      return (await db.query('SELECT * FROM digest_schedules WHERE enabled AND next_at <= $1', [now])).rows.map(scheduleOf)
    },
    async claim(orgId, from, to) {
      return ((await db.query('UPDATE digest_schedules SET next_at = $3 WHERE org_id = $1 AND next_at = $2', [orgId, from, to])).rowCount ?? 0) > 0
    },
    async digests(orgId, limit) {
      return (await db.query('SELECT * FROM digests WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2', [orgId, limit])).rows.map(digestOf)
    },
    digest: (orgId, id) =>
      /^[0-9a-f-]{36}$/i.test(id) ? one('SELECT * FROM digests WHERE org_id = $1 AND id = $2', [orgId, id], digestOf) : Promise.resolve(null),
    lastWritten: (orgId) =>
      one('SELECT * FROM digests WHERE org_id = $1 AND content IS NOT NULL ORDER BY created_at DESC LIMIT 1', [orgId], digestOf),
    async writing(orgId) {
      const sql = orgId ? "SELECT * FROM digests WHERE status = 'writing' AND org_id = $1" : "SELECT * FROM digests WHERE status = 'writing'"
      return (await db.query(sql, orgId ? [orgId] : [])).rows.map(digestOf)
    },
    async insertDigest(d) {
      await db.query(
        `INSERT INTO digests (id, org_id, status, run_id, run_url, period_start, period_end, facts, content, error, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          d.id,
          d.orgId,
          d.status,
          d.runId,
          d.runUrl,
          d.periodStart,
          d.periodEnd,
          JSON.stringify(d.facts),
          d.content ? JSON.stringify(d.content) : null,
          d.error,
          d.createdAt,
        ],
      )
    },
    async updateDigest(id, change) {
      const entries = Object.entries(change).filter(([, value]) => value !== undefined) as [keyof DigestChange, unknown][]
      if (entries.length === 0) return
      const sets = entries.map(([key], index) => `${COLUMNS[key]} = $${index + 2}`)
      const values = entries.map(([key, value]) => (key === 'content' && value ? JSON.stringify(value) : value))
      await db.query(`UPDATE digests SET ${sets.join(', ')} WHERE id = $1`, [id, ...values])
    },
  }
}

/** The same store in memory, for tests and for trying the plugin without a database. */
export function memoryStore(): Store & { schedules: Map<string, Schedule>; rows: Digest[] } {
  const schedules = new Map<string, Schedule>()
  const rows: Digest[] = []
  const newestFirst = (list: Digest[]) => [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  return {
    schedules,
    rows,
    async schedule(orgId) {
      const found = schedules.get(orgId)
      return found ? { ...found } : null
    },
    async saveSchedule(schedule) {
      schedules.set(schedule.orgId, { ...schedule })
    },
    async rememberPlugin(orgId, pluginId) {
      schedules.set(orgId, { ...DEFAULT_SCHEDULE, orgId, ...schedules.get(orgId), pluginId })
    },
    async dueSchedules(now) {
      return [...schedules.values()].filter((s) => s.enabled && s.nextAt && s.nextAt <= now).map((s) => ({ ...s }))
    },
    async claim(orgId, from, to) {
      const found = schedules.get(orgId)
      if (!found || found.nextAt?.getTime() !== from.getTime()) return false
      found.nextAt = to
      return true
    },
    async digests(orgId, limit) {
      return newestFirst(rows.filter((row) => row.orgId === orgId)).slice(0, limit)
    },
    async digest(orgId, id) {
      return rows.find((row) => row.orgId === orgId && row.id === id) ?? null
    },
    async lastWritten(orgId) {
      return newestFirst(rows.filter((row) => row.orgId === orgId && row.content))[0] ?? null
    },
    async writing(orgId) {
      return rows.filter((row) => row.status === 'writing' && (!orgId || row.orgId === orgId))
    },
    async insertDigest(digest) {
      rows.push({ ...digest })
    },
    async updateDigest(id, change) {
      const found = rows.find((row) => row.id === id)
      if (found) Object.assign(found, Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)))
    },
  }
}
