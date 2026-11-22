import { randomUUID } from 'node:crypto'
import { migrateDown, migrateUp } from '@moxxylabs/factorix-plugin-sdk'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { DEFAULT_SCHEDULE, type Digest, MIGRATIONS, pgStore, type Store } from './store'

// The integration project's setup provides it. A plugin never imports Factorix's packages, so the type is declared here.
declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
  }
}

const NAME = `digest_store_${randomUUID().slice(0, 8)}`

describe('the Postgres store', () => {
  let admin: pg.Client
  let pool: pg.Pool
  let store: Store

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: inject('databaseUrl') })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${NAME}`)
    const url = new URL(inject('databaseUrl'))
    url.pathname = `/${NAME}`
    pool = new pg.Pool({ connectionString: url.toString() })
    const client = await pool.connect()
    expect(await migrateUp(client, MIGRATIONS)).toEqual(['0001_digests'])
    client.release()
    store = pgStore(pool)
  })
  afterAll(async () => {
    await pool?.end()
    await admin?.query(`DROP DATABASE IF EXISTS ${NAME}`)
    await admin?.end()
  })

  const digest = (fields: Partial<Digest>): Digest => ({
    id: randomUUID(),
    orgId: 'org-1',
    status: 'writing',
    runId: null,
    runUrl: null,
    periodStart: new Date('2026-11-17T16:00:00Z'),
    periodEnd: new Date('2026-11-18T16:00:00Z'),
    facts: { members: [] },
    content: null,
    error: null,
    createdAt: new Date('2026-11-18T16:00:00Z'),
    ...fields,
  })

  it('remembers the plugin id without touching a saved schedule, and claims a due one once', async () => {
    await store.rememberPlugin('org-1', 'plugin-1')
    expect(await store.schedule('org-1')).toMatchObject({ ...DEFAULT_SCHEDULE, orgId: 'org-1', pluginId: 'plugin-1' })
    const due = new Date('2026-11-18T15:00:00Z')
    await store.saveSchedule({ ...DEFAULT_SCHEDULE, orgId: 'org-1', pluginId: 'plugin-1', enabled: true, agentId: 'a1', nextAt: due })
    await store.rememberPlugin('org-1', 'plugin-2')
    expect(await store.schedule('org-1')).toMatchObject({ enabled: true, agentId: 'a1', pluginId: 'plugin-2' })
    expect((await store.dueSchedules(new Date('2026-11-18T16:00:00Z'))).map((s) => s.orgId)).toEqual(['org-1'])
    expect(await store.dueSchedules(new Date('2026-11-18T14:00:00Z'))).toEqual([])
    const later = new Date('2026-11-19T15:00:00Z')
    expect(await Promise.all([store.claim('org-1', due, later), store.claim('org-1', due, later)])).toEqual(expect.arrayContaining([true, false]))
    expect((await store.schedule('org-1'))?.nextAt).toEqual(later)
  })

  it('keeps digests per organization, newest first, and updates them in place', async () => {
    const older = digest({ status: 'ready', content: { summary: 'old', members: [] }, createdAt: new Date('2026-11-17T16:00:00Z') })
    const newer = digest({})
    await store.insertDigest(older)
    await store.insertDigest(newer)
    await store.insertDigest(digest({ orgId: 'org-2' }))
    expect((await store.digests('org-1', 10)).map((row) => row.id)).toEqual([newer.id, older.id])
    expect((await store.writing('org-1')).map((row) => row.id)).toEqual([newer.id])
    expect(await store.writing()).toHaveLength(2)
    expect((await store.lastWritten('org-1'))?.id).toBe(older.id)
    expect(await store.digest('org-2', newer.id)).toBeNull()
    expect(await store.digest('org-1', 'not-an-id')).toBeNull()

    await store.updateDigest(newer.id, { status: 'ready', content: { summary: 'new', members: [] }, runId: 'run-1' })
    expect(await store.digest('org-1', newer.id)).toMatchObject({ status: 'ready', runId: 'run-1', content: { summary: 'new' }, error: null })
    expect((await store.lastWritten('org-1'))?.id).toBe(newer.id)
  })

  it('rolls its tables back', async () => {
    const client = await pool.connect()
    try {
      expect(await migrateDown(client, MIGRATIONS)).toEqual(['0001_digests'])
      expect((await client.query("SELECT to_regclass('digests') AS name")).rows[0]?.name).toBeNull()
    } finally {
      client.release()
    }
  })
})
