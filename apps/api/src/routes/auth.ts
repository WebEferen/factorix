import type { AccountRow, ApiTokenRow, OrganizationRow } from '@factorix/db'
import { createApiTokenInput, createMemberInput, loginInput, setupInput } from '@factorix/schemas'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../deps'
import { accountDto, apiTokenDto } from '../dto'
import { writeAudit } from '../lib/audit'
import {
  createApiToken,
  createSession,
  hashPassword,
  passwordProvider,
  requireAdmin,
  requireAuth,
  requireSession,
  SESSION_COOKIE,
  setSessionCookie,
} from '../lib/auth'
import { conflict, HttpError, isUniqueViolation, notFound, parseBody } from '../lib/errors'
import { readSettings } from '../services/settings'
import { bootstrapOrg, isSetUp } from '../services/setup'

const MAX_TOKENS_PER_ACCOUNT = 20

export function authRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps

  const login = async (
    account: AccountRow,
    request: { ip: string; headers: Record<string, unknown> },
    reply: Parameters<typeof setSessionCookie>[0],
  ) => {
    const settings = await readSettings(deps)
    const { token, expiresAt } = await createSession(
      db,
      account,
      { ip: request.ip, userAgent: request.headers['user-agent'] as string | undefined },
      settings.sessionDays,
    )
    setSessionCookie(reply, token, expiresAt, settings.cookieSecure)
  }

  app.get('/api/auth/status', async () => ({ setUp: await isSetUp(db) }))

  app.post('/api/auth/setup', async (request, reply) => {
    const account = await bootstrapOrg(db, parseBody(setupInput, request.body))
    await login(account, request, reply)
    return { account: accountDto(account) }
  })

  app.post('/api/auth/login', async (request, reply) => {
    const input = parseBody(loginInput, request.body)
    const account = await passwordProvider.authenticate(db, input)
    if (!account) throw new HttpError(401, 'invalid_credentials', 'That email and password do not match')
    await login(account, request, reply)
    await writeAudit(db, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'auth.login',
      targetType: 'account',
      targetId: account.id,
      metadata: { ip: request.ip },
    })
    return { account: accountDto(account) }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.auth?.sessionId) await db('auth_sessions').where({ id: request.auth.sessionId }).delete()
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/api/auth/me', async (request) => {
    const { account } = requireAuth(request)
    const org = await db<OrganizationRow>('organizations').where({ id: account.orgId }).first()
    return { account: accountDto(account), org: { id: org?.id, name: org?.name, slug: org?.slug } }
  })

  app.get('/api/tokens', async (request) => {
    const { account } = requireAuth(request)
    const rows = await db<ApiTokenRow>('api_tokens').where({ accountId: account.id }).orderBy('created_at', 'desc')
    return { tokens: rows.map(apiTokenDto) }
  })

  app.post('/api/tokens', async (request) => {
    const { account } = requireSession(request)
    const input = parseBody(createApiTokenInput, request.body)
    const [{ count }] = (await db('api_tokens').where({ accountId: account.id }).count('* as count')) as [{ count: string }]
    if (Number(count) >= MAX_TOKENS_PER_ACCOUNT) throw conflict(`You already have ${MAX_TOKENS_PER_ACCOUNT} tokens. Revoke one first.`)
    const { row, secret } = await createApiToken(db, account, input)
    await writeAudit(db, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'token.created',
      targetType: 'api_token',
      targetId: row.id,
      metadata: { name: row.name, scopes: row.scopes, expiresAt: row.expiresAt },
    })
    return { token: apiTokenDto(row), secret }
  })

  app.delete('/api/tokens/:id', async (request) => {
    const { account } = requireSession(request)
    const [row] = await db<ApiTokenRow>('api_tokens')
      .where({ id: (request.params as { id: string }).id, accountId: account.id })
      .delete()
      .returning('*')
    if (!row) throw notFound('Token')
    await writeAudit(db, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'token.revoked',
      targetType: 'api_token',
      targetId: row.id,
      metadata: { name: row.name },
    })
    return { ok: true }
  })

  app.get('/api/members', async (request) => {
    const { account } = requireAuth(request)
    const rows = await db<AccountRow>('accounts').where({ orgId: account.orgId, kind: 'human' }).orderBy('created_at')
    return { members: rows.map(accountDto) }
  })

  app.post('/api/members', async (request) => {
    const { account } = requireAdmin(request)
    const input = parseBody(createMemberInput, request.body)
    const handle = (input.email.split('@')[0] ?? 'member').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    try {
      const [row] = await db<AccountRow>('accounts')
        .insert({
          orgId: account.orgId,
          kind: 'human',
          role: input.role,
          handle,
          displayName: input.name,
          email: input.email,
          passwordHash: await hashPassword(input.password),
        })
        .returning('*')
      await writeAudit(db, {
        orgId: account.orgId,
        actorAccountId: account.id,
        actorKind: 'human',
        action: 'member.created',
        targetType: 'account',
        targetId: row?.id,
        metadata: { email: input.email, role: input.role },
      })
      return { member: accountDto(row as AccountRow) }
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('Someone with that email or handle is already a member')
      throw error
    }
  })
}
