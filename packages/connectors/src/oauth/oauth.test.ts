import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CHATGPT_OAUTH, chatgptAuthorizeUrl, parseChatgptCallback, verifyChatgptIdToken } from './chatgpt'
import { OAuthError, pkcePair, tokenRequest, verifyIdToken } from './oauth'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }

function idToken(claims: Record<string, unknown>, kid = 'k1'): string {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`
}

function fetcher(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (!(url in routes)) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(routes[url]), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

const now = Date.now()
const claims = { iss: 'https://auth.example', aud: 'oaiapp_1', sub: 'user-1', nonce: 'n1', exp: Math.floor(now / 1000) + 600, email: 'a@b.c' }

describe('pkcePair', () => {
  it('sends the S256 digest of the verifier', () => {
    const { verifier, challenge } = pkcePair()
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(verifier).not.toBe(pkcePair().verifier)
  })
})

describe('verifyIdToken', () => {
  const expected = { jwksUri: 'https://auth.example/jwks', issuer: 'https://auth.example', audience: 'oaiapp_1', nonce: 'n1', now }
  const keys = fetcher({ 'https://auth.example/jwks': { keys: [jwk] } })

  it('accepts a token signed by the published key', async () => {
    expect((await verifyIdToken(idToken(claims), expected, keys)).sub).toBe('user-1')
  })

  it('refuses a forged signature, another audience, another nonce, and an expired token', async () => {
    const forged = `${idToken(claims).split('.').slice(0, 2).join('.')}.${Buffer.from('nope').toString('base64url')}`
    await expect(verifyIdToken(forged, expected, keys)).rejects.toThrow('signature')
    await expect(verifyIdToken(idToken({ ...claims, aud: 'oaiapp_2' }), expected, keys)).rejects.toThrow('another client')
    await expect(verifyIdToken(idToken({ ...claims, nonce: 'n2' }), expected, keys)).rejects.toThrow('another sign-in')
    await expect(verifyIdToken(idToken({ ...claims, exp: Math.floor(now / 1000) - 3600 }), expected, keys)).rejects.toThrow('expired')
  })

  it('refuses a key the issuer does not publish', async () => {
    await expect(verifyIdToken(idToken(claims, 'other'), expected, keys)).rejects.toThrow('unknown key')
  })
})

describe('tokenRequest', () => {
  it('raises the OAuth error code so a spent refresh token can be told apart from an outage', async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token reused' }), { status: 400 })) as unknown as typeof fetch
    const error = await tokenRequest('https://auth.example/token', { grant_type: 'refresh_token' }, failing).catch((caught) => caught)
    expect(error).toBeInstanceOf(OAuthError)
    expect(error).toMatchObject({ code: 'invalid_grant', message: 'Token reused' })
  })
})

describe('Sign in with ChatGPT', () => {
  const base = { appName: 'Factorix', hostId: 'host-1', redirectUri: 'http://127.0.0.1:1455/auth/callback', state: 's', nonce: 'n', challenge: 'c' }

  it('registers a client on the first sign-in and reuses it after', () => {
    const first = new URL(chatgptAuthorizeUrl({ ...base, clientId: null }))
    expect(first.searchParams.get('client_id')).toBe(CHATGPT_OAUTH.registration)
    expect(first.searchParams.get('agent_name_hint')).toBe('Factorix')
    expect(first.searchParams.get('scope')).toContain(CHATGPT_OAUTH.planScope)
    expect(first.searchParams.get('resource')).toBe('https://api.openai.com/v1')
    const again = new URL(chatgptAuthorizeUrl({ ...base, clientId: 'oaiapp_1', idTokenHint: 'old', loginHint: 'a@b.c' }))
    expect(again.searchParams.get('client_id')).toBe('oaiapp_1')
    expect(again.searchParams.has('agent_name_hint')).toBe(false)
    expect(again.searchParams.get('id_token_hint')).toBe('old')
  })

  it('reads the address the browser landed on, or only its query', () => {
    const full = parseChatgptCallback('http://127.0.0.1:1455/auth/callback?code=abc&state=s&client_id=oaiapp_1&scope=openid')
    expect(full).toEqual({ code: 'abc', state: 's', clientId: 'oaiapp_1', scope: 'openid' })
    expect(parseChatgptCallback('code=abc&state=s').code).toBe('abc')
    expect(() => parseChatgptCallback('http://127.0.0.1:1455/auth/callback?error=access_denied&state=s')).toThrow('not approved')
    expect(() => parseChatgptCallback('http://127.0.0.1:1455/auth/callback')).toThrow('no code')
  })

  it('reads the person and their plan from a verified ID token', async () => {
    const routes = fetcher({
      'https://auth.openai.com/.well-known/openid-configuration': { issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks' },
      'https://auth.openai.com/jwks': { keys: [jwk] },
    })
    const token = idToken({ ...claims, iss: 'https://auth.openai.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } })
    expect(await verifyChatgptIdToken(token, { clientId: 'oaiapp_1', nonce: 'n1' }, routes)).toEqual({
      subject: 'user-1',
      email: 'a@b.c',
      plan: 'pro',
    })
  })
})
