import type { AccountRow, ApiTokenRow, Db } from '@factorix/db'
import { API_TOKEN_SCOPES, type ApiTokenScope } from '@factorix/schemas'
import { hash, verify } from '@node-rs/argon2'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { randomToken, sha256 } from './crypto'
import { HttpError } from './errors'

export const SESSION_COOKIE = 'fx_session'
const SLIDE_AFTER_MS = 3_600_000

export const API_TOKEN_PREFIX = 'fxp_'
const TOKEN_SEEN_AFTER_MS = 60_000

export interface AuthContext {
  account: AccountRow
  /** Null when the request carries an API token. */
  sessionId: string | null
  tokenId: string | null
  /** What a token may change. Empty for a session, which is not limited by scopes. */
  scopes: string[]
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
  sessionDays: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken()
  const expiresAt = new Date(Date.now() + sessionDays * 86_400_000)
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

export async function loadSession(db: Db, token: string, sessionDays: () => Promise<number>): Promise<AuthContext | null> {
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
      .update({ lastSeenAt: db.fn.now(), expiresAt: new Date(Date.now() + (await sessionDays()) * 86_400_000) })
  }
  return { account, sessionId: row.id, tokenId: null, scopes: [] }
}

export async function createApiToken(
  db: Db,
  account: Pick<AccountRow, 'id' | 'orgId'>,
  input: { name: string; scopes: string[]; expiresInDays?: number },
): Promise<{ row: ApiTokenRow; secret: string }> {
  const secret = `${API_TOKEN_PREFIX}${randomToken()}`
  const [row] = await db<ApiTokenRow>('api_tokens')
    .insert({
      orgId: account.orgId,
      accountId: account.id,
      name: input.name,
      scopes: input.scopes,
      tokenHash: sha256(secret),
      prefix: secret.slice(0, API_TOKEN_PREFIX.length + 4),
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
    })
    .returning('*')
  return { row: row as ApiTokenRow, secret }
}

export async function loadApiToken(db: Db, secret: string): Promise<AuthContext | null> {
  const row = await db<ApiTokenRow>('api_tokens')
    .where({ tokenHash: sha256(secret) })
    .andWhere((query) => query.whereNull('expires_at').orWhere('expires_at', '>', db.fn.now()))
    .first()
  if (!row) return null
  const account = await db<AccountRow>('accounts').where({ id: row.accountId, kind: 'human', status: 'active' }).first()
  if (!account) return null
  if (!row.lastUsedAt || Date.now() - new Date(row.lastUsedAt).getTime() > TOKEN_SEEN_AFTER_MS) {
    await db('api_tokens').where({ id: row.id }).update({ lastUsedAt: db.fn.now() })
  }
  return { account, sessionId: null, tokenId: row.id, scopes: row.scopes }
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure, expires: expiresAt })
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null
  }
  interface FastifyContextConfig {
    /** The token scope that allows this route. A route that changes something and has none is closed to every API token. */
    scope?: ApiTokenScope
  }
}

const SESSION_ONLY = 'Sign in to Factorix in a browser to do this. An API token cannot.'

/** Tokens are refused by default: reading is open, and a change goes through only on a route that names a scope the token holds. */
export function checkTokenScope(request: FastifyRequest): void {
  const auth = request.auth
  if (!auth?.tokenId || request.method === 'GET' || request.method === 'HEAD') return
  const scope = request.routeOptions.config.scope
  if (!scope) throw new HttpError(403, 'session_required', SESSION_ONLY)
  if (auth.scopes.includes(scope)) return
  const label = API_TOKEN_SCOPES.find((candidate) => candidate.id === scope)?.label ?? scope
  throw new HttpError(
    403,
    'scope_required',
    `This token is not allowed to do that. Make one with the ${label} permission under Settings, API tokens.`,
  )
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new HttpError(401, 'unauthenticated', 'Sign in to continue')
  return request.auth
}

/** For what a leaked API token must not be able to do, such as minting another token. */
export function requireSession(request: FastifyRequest): AuthContext {
  const auth = requireAuth(request)
  if (auth.tokenId) throw new HttpError(403, 'session_required', SESSION_ONLY)
  return auth
}

export function requireAdmin(request: FastifyRequest): AuthContext {
  const auth = requireSession(request)
  if (auth.account.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins can do this')
  return auth
}
