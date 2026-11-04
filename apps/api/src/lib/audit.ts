import { type Db, json } from '@factorix/db'
import type { Knex } from 'knex'

export interface AuditInput {
  orgId: string
  actorAccountId?: string | null
  actorKind: 'human' | 'agent' | 'system'
  action: string
  targetType: string
  targetId?: string | null
  metadata?: Record<string, unknown>
}

export async function writeAudit(db: Db | Knex.Transaction, input: AuditInput): Promise<void> {
  await db('audit_log').insert({
    orgId: input.orgId,
    actorAccountId: input.actorAccountId ?? null,
    actorKind: input.actorKind,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    metadata: json(input.metadata ?? {}),
  })
}
