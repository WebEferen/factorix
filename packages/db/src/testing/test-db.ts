import { randomBytes } from 'node:crypto'
import type { Db } from '../client'
import { createDb } from '../client'
import { migrate } from '../migrate'

export interface TestDatabase {
  db: Db
  url: string
  destroy(): Promise<void>
}

export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `fx_test_${randomBytes(6).toString('hex')}`
  const admin = createDb(adminUrl, { max: 1 })
  await admin.raw(`CREATE DATABASE ${name}`)
  const parsed = new URL(adminUrl)
  parsed.pathname = `/${name}`
  const url = parsed.toString()
  const db = createDb(url, { max: 8 })
  await migrate(db)
  return {
    db,
    url,
    async destroy() {
      await db.destroy()
      await admin.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.destroy()
    },
  }
}
