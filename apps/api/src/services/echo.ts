import { fingerprint } from '@factorix/core'
import type { Db } from '@factorix/db'

const ECHO_WINDOW = '10 minutes'

/** With a personal API key, the factory's own writes look like a human's, so each write leaves a marker to recognize its echo. */
export async function recordEcho(db: Db, source: string, entityType: string, entityId: string, field: string, value: unknown): Promise<void> {
  await db('echo_markers').insert({ source, entityType, entityId, fingerprint: fingerprint(field, value) })
}

export async function isEcho(db: Db, source: string, entityType: string, entityId: string, field: string, value: unknown): Promise<boolean> {
  const row = await db('echo_markers')
    .where({ source, entityType, entityId, fingerprint: fingerprint(field, value) })
    .andWhere('created_at', '>', db.raw(`now() - interval '${ECHO_WINDOW}'`))
    .first()
  return Boolean(row)
}
