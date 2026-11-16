import type { AccountRow, ApiTokenRow, OrganizationRow, UserRow } from '@factorix/db'
import { createApiTokenInput, createMemberInput, createOrgInput, loginInput, setupInput, switchOrgInput, updateMemberInput } from '@factorix/schemas'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../deps'
import { accountDto, apiTokenDto } from '../dto'
import { writeAudit } from '../lib/audit'
import {
  accountsOf,
  createApiToken,
  createSession,
  hashPassword,
  passwordProvider,
  requireAdmin,
  requireAuth,
  requireInstallationAdmin,
  requireSession,
  SESSION_COOKIE,
  setSessionCookie,
} from '../lib/auth'
import { badRequest, conflict, HttpError, isUniqueViolation, notFound, parseBody } from '../lib/errors'
import { readSettings } from '../services/settings'
import { addMember, bootstrapOrg, createOrg, isSetUp } from '../services/setup'

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
    const { account } = await bootstrapOrg(db, parseBody(setupInput, request.body))
    await login(account, request, reply)
    return { account: accountDto(account) }
  })

  app.post('/api/auth/login', async (request, reply) => {
    const input = parseBody(loginInput, request.body)
    const user = await passwordProvider.authenticate(db, input)
    // Someone removed from every organization gets the same answer as a wrong password, so an address is never confirmed.
    const [account] = user ? await accountsOf(db, user) : []
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
    const { account, user } = requireAuth(request)
    const accounts = await accountsOf(db, user)
    const rows = await db<OrganizationRow>('organizations').whereIn(
      'id',
      accounts.map((row) => row.orgId),
    )
    const orgs = rows
      .map((org) => ({ id: org.id, name: org.name, slug: org.slug, role: accounts.find((row) => row.orgId === org.id)?.role ?? 'member' }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const org = orgs.find((candidate) => candidate.id === account.orgId)
    return {
      account: accountDto(account),
      org: { id: org?.id, name: org?.name, slug: org?.slug },
      orgs,
      installationAdmin: user.installationAdmin,
    }
  })

  /** Moves this session to another organization the person belongs to. An API token stays in the one it was made in. */
  app.post('/api/auth/switch', async (request) => {
    const { user, sessionId } = requireSession(request)
    const { orgId } = parseBody(switchOrgInput, request.body)
    const account = (await accountsOf(db, user)).find((row) => row.orgId === orgId)
    if (!account) throw notFound('Organization')
    await db.transaction(async (trx) => {
      await trx('auth_sessions').where({ id: sessionId }).update({ accountId: account.id, orgId })
      await trx('users').where({ id: user.id }).update({ lastAccountId: account.id })
    })
    return { account: accountDto(account) }
  })

  app.get('/api/orgs', async (request) => {
    requireInstallationAdmin(request)
    const rows = await db('organizations')
      .select('organizations.*')
      .select(db.raw("(SELECT count(*) FROM accounts WHERE accounts.org_id = organizations.id AND kind = 'human') AS member_count"))
      .select(db.raw('(SELECT count(*) FROM projects WHERE projects.org_id = organizations.id) AS project_count'))
      .orderBy('name')
    return {
      orgs: rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        memberCount: Number(row.memberCount),
        projectCount: Number(row.projectCount),
        createdAt: new Date(row.createdAt).toISOString(),
      })),
    }
  })

  /** The new organization starts with the person who made it as its admin. They add everyone else from inside it. */
  app.post('/api/orgs', async (request) => {
    const { user } = requireInstallationAdmin(request)
    const input = parseBody(createOrgInput, request.body)
    const account = await db.transaction((trx) => createOrg(trx, input.name, user))
    const org = await db<OrganizationRow>('organizations').where({ id: account.orgId }).first()
    return { org: { id: org?.id, name: org?.name, slug: org?.slug } }
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
    const rows = await db<AccountRow>('accounts').where({ orgId: account.orgId, kind: 'human', status: 'active' }).orderBy('created_at')
    return { members: rows.map(accountDto) }
  })

  app.post('/api/members', async (request) => {
    const { account } = requireAdmin(request)
    const input = parseBody(createMemberInput, request.body)
    const known = await db<UserRow>('users').whereRaw('lower(email) = lower(?)', [input.email]).first()
    if (!known && !input.password) throw badRequest('Give a password for someone who has not signed in to this installation before')
    const passwordHash = !known && input.password ? await hashPassword(input.password) : null
    try {
      // Someone who already signs in here keeps their own name and password: an admin of one organization must not change them.
      const { row, existing } = await db.transaction(async (trx) => {
        const user =
          known ?? ((await trx<UserRow>('users').insert({ email: input.email, passwordHash, displayName: input.name }).returning('*'))[0] as UserRow)
        // Someone removed earlier comes back as the same account, so what they did before stays theirs.
        const [back] = await trx<AccountRow>('accounts')
          .where({ orgId: account.orgId, userId: user.id, status: 'disabled' })
          .update({ status: 'active', role: input.role, updatedAt: trx.fn.now() })
          .returning('*')
        const row = back ?? (await addMember(trx, account.orgId, user, input.role))
        await writeAudit(trx, {
          orgId: account.orgId,
          actorAccountId: account.id,
          actorKind: 'human',
          action: 'member.created',
          targetType: 'account',
          targetId: row.id,
          metadata: { email: input.email, role: input.role, existing: Boolean(known) },
        })
        return { row, existing: Boolean(known) }
      })
      return { member: accountDto(row), existing }
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('Someone with that email is already a member')
      throw error
    }
  })

  /** The member an admin is about to change. Nobody changes themselves, so an organization cannot lose its last admin this way. */
  const otherMember = async (request: Parameters<typeof requireAdmin>[0]) => {
    const { account } = requireAdmin(request)
    const { id } = request.params as { id: string }
    const member = /^[0-9a-f-]{36}$/.test(id)
      ? await db<AccountRow>('accounts').where({ id, orgId: account.orgId, kind: 'human', status: 'active' }).first()
      : undefined
    if (!member) throw notFound('Member')
    if (member.id === account.id) throw badRequest('Ask another admin to change your own membership')
    return { account, member }
  }

  app.put('/api/members/:id', async (request) => {
    const { account, member } = await otherMember(request)
    const { role } = parseBody(updateMemberInput, request.body)
    const [row] = await db.transaction(async (trx) => {
      await writeAudit(trx, {
        orgId: account.orgId,
        actorAccountId: account.id,
        actorKind: 'human',
        action: 'member.updated',
        targetType: 'account',
        targetId: member.id,
        metadata: { email: member.email, from: member.role, to: role },
      })
      return trx<AccountRow>('accounts').where({ id: member.id }).update({ role, updatedAt: trx.fn.now() }).returning('*')
    })
    return { member: accountDto(row as AccountRow) }
  })

  /**
   * Takes someone out of this organization. Their account stays, disabled, because runs and the audit log name it.
   * Their sessions here and their API tokens end now, and they keep signing in to any other organization they are in.
   */
  app.delete('/api/members/:id', async (request) => {
    const { account, member } = await otherMember(request)
    await db.transaction(async (trx) => {
      await trx('accounts').where({ id: member.id }).update({ status: 'disabled', updatedAt: trx.fn.now() })
      await trx('auth_sessions').where({ accountId: member.id }).delete()
      await trx('api_tokens').where({ accountId: member.id }).delete()
      await trx('users').where({ lastAccountId: member.id }).update({ lastAccountId: null })
      await writeAudit(trx, {
        orgId: account.orgId,
        actorAccountId: account.id,
        actorKind: 'human',
        action: 'member.removed',
        targetType: 'account',
        targetId: member.id,
        metadata: { email: member.email, role: member.role },
      })
    })
    return { ok: true }
  })
}
