import { createHash, createPublicKey, type JsonWebKey, randomBytes, verify } from 'node:crypto'

export type Fetcher = typeof fetch

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** PKCE with S256: the verifier stays with Factorix, and only its digest goes to the authorization server. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function oauthNonce(): string {
  return randomBytes(24).toString('base64url')
}

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

export async function tokenRequest(url: string, form: Record<string, string>, fetcher: Fetcher = fetch): Promise<TokenResponse> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form),
  })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {}
  if (!response.ok || typeof body.access_token !== 'string') {
    const code = typeof body.error === 'string' ? body.error : `http_${response.status}`
    const description = typeof body.error_description === 'string' ? body.error_description : ''
    throw new OAuthError(code, description || `The token endpoint answered ${response.status}`, response.status)
  }
  return body as unknown as TokenResponse
}

export interface OpenIdConfiguration {
  issuer: string
  jwks_uri: string
  revocation_endpoint?: string
}

const CACHE_MS = 3_600_000
const configurations = new Map<string, { value: OpenIdConfiguration; at: number }>()
const keySets = new Map<string, { keys: (JsonWebKey & { kid?: string })[]; at: number }>()

export async function discover(issuer: string, fetcher: Fetcher = fetch): Promise<OpenIdConfiguration> {
  const cached = configurations.get(issuer)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const response = await fetcher(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`)
  if (!response.ok) throw new OAuthError('discovery_failed', `${issuer} did not describe itself (${response.status})`)
  const value = (await response.json()) as OpenIdConfiguration
  if (typeof value.issuer !== 'string' || typeof value.jwks_uri !== 'string') throw new OAuthError('discovery_failed', `${issuer} sent no keys`)
  configurations.set(issuer, { value, at: Date.now() })
  return value
}

async function signingKey(jwksUri: string, kid: string | undefined, fetcher: Fetcher): Promise<JsonWebKey> {
  const find = (keys: (JsonWebKey & { kid?: string })[]) => (kid ? keys.find((key) => key.kid === kid) : keys.length === 1 ? keys[0] : undefined)
  const cached = keySets.get(jwksUri)
  const hit = cached && Date.now() - cached.at < CACHE_MS ? find(cached.keys) : undefined
  if (hit) return hit
  // A key the cache does not know may be a rotation, so the set is fetched again before giving up.
  const response = await fetcher(jwksUri)
  if (!response.ok) throw new OAuthError('invalid_id_token', `The signing keys could not be read (${response.status})`)
  const { keys } = (await response.json()) as { keys?: (JsonWebKey & { kid?: string })[] }
  keySets.set(jwksUri, { keys: keys ?? [], at: Date.now() })
  const key = find(keys ?? [])
  if (!key) throw new OAuthError('invalid_id_token', 'The ID token was signed with an unknown key')
  return key
}

export function decodeJwt(token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [head, payload] = token.split('.')
  try {
    return {
      header: JSON.parse(Buffer.from(head ?? '', 'base64url').toString('utf8')) as Record<string, unknown>,
      claims: JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<string, unknown>,
    }
  } catch {
    throw new OAuthError('invalid_id_token', 'The ID token is not a JWT')
  }
}

/** Checks an ID token's RS256 signature against the issuer's published keys, then its issuer, audience, expiry, and nonce. */
export async function verifyIdToken(
  token: string,
  expected: { jwksUri: string; issuer: string; audience: string; nonce?: string; now?: number },
  fetcher: Fetcher = fetch,
): Promise<Record<string, unknown>> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new OAuthError('invalid_id_token', 'The ID token is not a JWT')
  const { header, claims } = decodeJwt(token)
  if (header.alg !== 'RS256') throw new OAuthError('invalid_id_token', `The ID token uses ${String(header.alg)}, not RS256`)
  const key = await signingKey(expected.jwksUri, typeof header.kid === 'string' ? header.kid : undefined, fetcher)
  const signed = verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key, format: 'jwk' }),
    Buffer.from(parts[2] ?? '', 'base64url'),
  )
  if (!signed) throw new OAuthError('invalid_id_token', 'The ID token signature does not match')
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  const now = (expected.now ?? Date.now()) / 1000
  if (claims.iss !== expected.issuer) throw new OAuthError('invalid_id_token', 'The ID token comes from another issuer')
  if (!audience.includes(expected.audience)) throw new OAuthError('invalid_id_token', 'The ID token was issued to another client')
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new OAuthError('invalid_id_token', 'The ID token has expired')
  if (expected.nonce !== undefined && claims.nonce !== expected.nonce)
    throw new OAuthError('invalid_id_token', 'The ID token answers another sign-in')
  if (typeof claims.sub !== 'string' || !claims.sub) throw new OAuthError('invalid_id_token', 'The ID token names nobody')
  return claims
}

export async function revokeToken(
  endpoint: string,
  input: { token: string; clientId: string; hint?: 'refresh_token' | 'access_token' },
  fetcher: Fetcher = fetch,
): Promise<void> {
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: input.token, client_id: input.clientId, ...(input.hint ? { token_type_hint: input.hint } : {}) }),
  })
  if (!response.ok) throw new OAuthError('revoke_failed', `Revoking the token failed (${response.status})`, response.status)
}
