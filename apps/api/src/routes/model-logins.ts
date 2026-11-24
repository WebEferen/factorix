import type { ModelLoginRow, OrganizationRow } from '@factorix/db'
import { modelPlanCodeInput, modelPlanCompleteInput, modelPlanSettingsInput, modelPlanStartInput } from '@factorix/schemas'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../deps'
import { modelLoginDto } from '../dto'
import { writeAudit } from '../lib/audit'
import { requireAdmin, requireAuth } from '../lib/auth'
import { notFound, parseBody } from '../lib/errors'
import { emit } from '../lib/outbox'
import {
  claudeLoginAttempt,
  completeChatgptLogin,
  disconnectModelLogin,
  plansAllowed,
  sendClaudeLoginCode,
  startChatgptLogin,
  startClaudeLogin,
} from '../services/model-logins'

/** A person's own model plans. Each person sees and changes only their own, and no token ever leaves the API. */
export function modelLoginRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps

  app.get('/api/model-plans', async (request) => {
    const { account } = requireAuth(request)
    const logins = await db<ModelLoginRow>('model_logins').where({ accountId: account.id }).orderBy('created_at')
    return { enabled: await plansAllowed(db, account.orgId), logins: logins.map(modelLoginDto) }
  })

  app.put('/api/settings/model-plans', async (request) => {
    const { account } = requireAdmin(request)
    const { enabled } = parseBody(modelPlanSettingsInput, request.body)
    await db.transaction(async (trx) => {
      const updated = await trx<OrganizationRow>('organizations').where({ id: account.orgId }).update({ personalModelLogins: enabled })
      if (updated === 0) throw notFound('Organization')
      await writeAudit(trx, {
        orgId: account.orgId,
        actorAccountId: account.id,
        actorKind: 'human',
        action: 'model_plans.updated',
        targetType: 'organization',
        targetId: account.orgId,
        metadata: { enabled },
      })
      await emit(trx, account.orgId, { type: 'notify', kind: 'settings', id: account.orgId })
    })
    return { enabled }
  })

  app.post('/api/model-plans/chatgpt/start', { config: { scope: 'plans' } }, async (request) => {
    const { account } = requireAuth(request)
    return startChatgptLogin(deps, account, parseBody(modelPlanStartInput, request.body ?? {}))
  })

  app.post('/api/model-plans/chatgpt/complete', { config: { scope: 'plans' } }, async (request) => {
    const { account } = requireAuth(request)
    const { callbackUrl } = parseBody(modelPlanCompleteInput, request.body)
    return { login: modelLoginDto(await completeChatgptLogin(deps, account, callbackUrl)) }
  })

  app.post('/api/model-plans/claude/start', { config: { scope: 'plans' } }, async (request) => {
    const { account } = requireAuth(request)
    return startClaudeLogin(deps, account)
  })

  app.get('/api/model-plans/claude/attempts/:id', async (request) => {
    const { account } = requireAuth(request)
    return { attempt: await claudeLoginAttempt(deps, account, (request.params as { id: string }).id) }
  })

  app.post('/api/model-plans/claude/attempts/:id/code', { config: { scope: 'plans' } }, async (request) => {
    const { account } = requireAuth(request)
    const { code } = parseBody(modelPlanCodeInput, request.body)
    await sendClaudeLoginCode(deps, account, (request.params as { id: string }).id, code)
    return { ok: true }
  })

  app.delete('/api/model-plans/:id', { config: { scope: 'plans' } }, async (request) => {
    const { account } = requireAuth(request)
    await disconnectModelLogin(deps, account, (request.params as { id: string }).id)
    return { ok: true }
  })
}
