import type { AccountRow, OrganizationRow } from '@factorix/db'
import { createMemberInput, loginInput, setupInput } from '@factorix/schemas'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../deps'
import { accountDto } from '../dto'
import { writeAudit } from '../lib/audit'
import { createSession, hashPassword, passwordProvider, requireAdmin, requireAuth, SESSION_COOKIE, setSessionCookie } from '../lib/auth'
import { conflict, HttpError, isUniqueViolation, parseBody } from '../lib/errors'
import { bootstrapOrg, isSetUp } from '../services/setup'

export function authRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, env } = deps

  const login = async (
    account: AccountRow,
    request: { ip: string; headers: Record<string, unknown> },
    reply: Parameters<typeof setSessionCookie>[0],
  ) => {
    const { token, expiresAt } = await createSession(db, account, { ip: request.ip, userAgent: request.headers['user-agent'] as string | undefined })
    setSessionCookie(reply, token, expiresAt, env.COOKIE_SECURE)
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
    if (request.auth) await db('auth_sessions').where({ id: request.auth.sessionId }).delete()
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/api/auth/me', async (request) => {
    const { account } = requireAuth(request)
    const org = await db<OrganizationRow>('organizations').where({ id: account.orgId }).first()
    return { account: accountDto(account), org: { id: org?.id, name: org?.name, slug: org?.slug } }
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
