import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createDb, json } from './client'
import { migrate } from './migrate'
import { createTestDatabase, type TestDatabase } from './testing/test-db'
import type { OrganizationRow } from './types'

describe('migrations', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await createTestDatabase(inject('databaseUrl'))
  })

  afterAll(async () => {
    await database.destroy()
  })

  it('are idempotent', async () => {
    expect(await migrate(database.db)).toEqual([])
  })

  it('map rows to camelCase while leaving JSONB contents alone', async () => {
    const [org] = await database.db<OrganizationRow>('organizations').insert({ name: 'A', slug: 'a' }).returning('*')
    expect(org?.createdAt).toBeInstanceOf(Date)
    await database.db('audit_log').insert({
      orgId: org?.id,
      actorKind: 'system',
      action: 'x',
      targetType: 'y',
      metadata: json({ snake_key: [1, 2] }),
    })
    const row = await database.db('audit_log').where({ orgId: org?.id }).first()
    expect(row.actorKind).toBe('system')
    expect(row.metadata).toEqual({ snake_key: [1, 2] })
  })

  it('refuses to rewrite the audit log or run events', async () => {
    const org = await database.db<OrganizationRow>('organizations').first()
    await database.db('audit_log').insert({ orgId: org?.id, actorKind: 'system', action: 'keep', targetType: 'y' })
    await expect(database.db('audit_log').where({ action: 'keep' }).update({ action: 'changed' })).rejects.toThrow(/append-only/)
    await expect(database.db('audit_log').where({ action: 'keep' }).delete()).rejects.toThrow(/append-only/)
  })

  it('turn each person into a user who keeps their password, and each admin into an installation admin', async () => {
    const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
    const before = mkdtempSync(join(tmpdir(), 'fx-migrations-'))
    for (const file of readdirSync(migrations)) if (file < '0027') copyFileSync(join(migrations, file), join(before, file))
    const name = `fx_test_${randomBytes(6).toString('hex')}`
    const admin = createDb(inject('databaseUrl'), { max: 1 })
    await admin.raw(`CREATE DATABASE ${name}`)
    const url = new URL(inject('databaseUrl'))
    url.pathname = `/${name}`
    const db = createDb(url.toString(), { max: 2 })
    try {
      await migrate(db, before)
      const [org] = await db('organizations').insert({ name: 'Acme', slug: 'acme' }).returning('id')
      const person = { orgId: org.id, kind: 'human' }
      await db('accounts').insert([
        { ...person, role: 'admin', handle: 'ada', displayName: 'Ada', email: 'Ada@example.com', passwordHash: 'hash-ada' },
        { ...person, role: 'member', handle: 'bo', displayName: 'Bo', email: 'bo@example.com', passwordHash: 'hash-bo', status: 'disabled' },
        { orgId: org.id, kind: 'agent', handle: 'engineer-1', displayName: 'Engineer' },
      ])

      expect((await migrate(db))[0]).toBe('0027_users.sql')
      const users = await db('users').orderBy('email')
      expect(users).toMatchObject([
        { email: 'Ada@example.com', passwordHash: 'hash-ada', displayName: 'Ada', installationAdmin: true, status: 'active' },
        { email: 'bo@example.com', passwordHash: 'hash-bo', displayName: 'Bo', installationAdmin: false, status: 'disabled' },
      ])
      const accounts = await db('accounts').orderBy('handle')
      expect(accounts.map((account: { userId: string | null }) => account.userId)).toEqual([users[0].id, users[1].id, null])
      expect(accounts[0]).not.toHaveProperty('passwordHash')
    } finally {
      await db.destroy()
      await admin.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.destroy()
      rmSync(before, { recursive: true })
    }
  })

  it('move the Slack block to its own type in drafts, published copies, and runs', async () => {
    const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
    const before = mkdtempSync(join(tmpdir(), 'fx-migrations-'))
    for (const file of readdirSync(migrations)) if (file < '0037') copyFileSync(join(migrations, file), join(before, file))
    const name = `fx_test_${randomBytes(6).toString('hex')}`
    const admin = createDb(inject('databaseUrl'), { max: 1 })
    await admin.raw(`CREATE DATABASE ${name}`)
    const url = new URL(inject('databaseUrl'))
    url.pathname = `/${name}`
    const db = createDb(url.toString(), { max: 2 })
    try {
      await migrate(db, before)
      const [org] = await db('organizations').insert({ name: 'Acme', slug: 'acme' }).returning('id')
      const node = (id: string, type: string) => ({ id, type, position: { x: 0, y: 0 }, config: { message: 'notify.send' } })
      const definition = { nodes: [node('t', 'trigger.manual'), node('s', 'notify.send')], edges: [{ id: 'e', source: 't', target: 's' }] }
      const empty = { nodes: [], edges: [] }
      await db('workflows').insert([
        { orgId: org.id, name: 'Tell', definition: json(definition), publishedDefinition: json(definition) },
        { orgId: org.id, name: 'Empty', definition: json(empty) },
      ])

      expect(await migrate(db)).toContain('0037_slack_block.sql')
      const [tell, untouched] = await db('workflows').orderBy('name', 'desc')
      expect(tell.definition.nodes.map((item: { type: string }) => item.type)).toEqual(['trigger.manual', 'slack.send_message'])
      expect(tell.definition.nodes[1].config).toEqual({ message: 'notify.send' })
      expect(tell.definition.edges).toEqual(definition.edges)
      expect(tell.publishedDefinition.nodes[1].type).toBe('slack.send_message')
      expect(untouched).toMatchObject({ definition: empty, publishedDefinition: null })
    } finally {
      await db.destroy()
      await admin.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.destroy()
      rmSync(before, { recursive: true })
    }
  })
})
