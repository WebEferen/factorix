import { json, type OrganizationRow } from '@factorix/db'
import { networkSettingsInput } from '@factorix/schemas'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../deps'
import { networkSettingsDto } from '../dto'
import { writeAudit } from '../lib/audit'
import { requireAdmin, requireAuth } from '../lib/auth'
import { notFound, parseBody } from '../lib/errors'
import { emit } from '../lib/outbox'

export function settingsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps

  app.get('/api/settings/network', async (request) => {
    const { account } = requireAuth(request)
    const org = await db<OrganizationRow>('organizations').where({ id: account.orgId }).first()
    if (!org) throw notFound('Organization')
    return { network: networkSettingsDto(org) }
  })

  app.put('/api/settings/network', async (request) => {
    const { account } = requireAdmin(request)
    const input = parseBody(networkSettingsInput, request.body)
    const org = await db.transaction(async (trx) => {
      const [updated] = await trx<OrganizationRow>('organizations')
        .where({ id: account.orgId })
        .update({ networkMode: input.mode, networkAllowlist: json(input.hosts) as never })
        .returning('*')
      if (!updated) throw notFound('Organization')
      await writeAudit(trx, {
        orgId: account.orgId,
        actorAccountId: account.id,
        actorKind: 'human',
        action: 'network.updated',
        targetType: 'organization',
        targetId: account.orgId,
        metadata: input,
      })
      await emit(trx, account.orgId, { type: 'notify', kind: 'network', id: account.orgId })
      return updated
    })
    return { network: networkSettingsDto(org) }
  })
}
