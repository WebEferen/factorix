import type { AccountRow, Db } from '@factorix/db'
import { hash, verify } from '@node-rs/argon2'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { randomToken, sha256 } from './crypto'
import { HttpError } from './errors'

export const SESSION_COOKIE = 'fx_session'
const SESSION_DAYS = 30
const SLIDE_AFTER_MS = 3_600_000

export interface AuthContext {
  account: AccountRow
  sessionId: string
}

export interface AuthProvider {
  id: string
  authenticate(db: Db, input: { email: string; password: string }): Promise<AccountRow | null>
}

// Hashing a throwaway value keeps timing the same whether or not the account exists.
const DUMMY_HASH = hash('factorix-dummy-password')

export const passwordProvider: AuthProvider = {
  id: 'password',
  async authenticate(db, { email, password }) {
    const account = await db<AccountRow>('accounts').whereRaw('lower(email) = lower(?)', [email]).where({ kind: 'human', status: 'active' }).first()
    const valid = await verify(account?.passwordHash ?? (await DUMMY_HASH), password)
    return account?.passwordHash && valid ? account : null
  },
}

export function hashPassword(password: string): Promise<string> {
  return hash(password)
}

export async function createSession(
  db: Db,
  account: Pick<AccountRow, 'id' | 'orgId'>,
  meta: { ip?: string; userAgent?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken()
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000)
  await db('auth_sessions').insert({
    orgId: account.orgId,
    accountId: account.id,
    tokenHash: sha256(token),
    expiresAt,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
  return { token, expiresAt }
}

export async function loadSession(db: Db, token: string): Promise<AuthContext | null> {
  const row = await db('auth_sessions')
    .where({ tokenHash: sha256(token) })
    .andWhere('expires_at', '>', db.fn.now())
    .first()
  if (!row) return null
  const account = await db<AccountRow>('accounts').where({ id: row.accountId, status: 'active' }).first()
  if (!account) return null
  if (Date.now() - new Date(row.lastSeenAt).getTime() > SLIDE_AFTER_MS) {
    await db('auth_sessions')
      .where({ id: row.id })
      .update({ lastSeenAt: db.fn.now(), expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) })
  }
  return { account, sessionId: row.id }
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure, expires: expiresAt })
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null
  }
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new HttpError(401, 'unauthenticated', 'Sign in to continue')
  return request.auth
}

export function requireAdmin(request: FastifyRequest): AuthContext {
  const auth = requireAuth(request)
  if (auth.account.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins can do this')
  return auth
}
