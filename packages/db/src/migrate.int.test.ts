import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { json } from './client'
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
})
