import { discover, type Fetcher, OAuthError, revokeToken, type TokenResponse, tokenRequest, verifyIdToken } from './oauth'

/**
 * Sign in with ChatGPT for plan usage, as OpenAI documents it for open-source and self-hosted apps
 * (developers.openai.com/siwc/token-sharing-open-source). The first sign-in registers a client bound to that person and
 * workspace, and later ones reuse it. The access token is a bearer for the Responses API at api.openai.com.
 */
export const CHATGPT_OAUTH = {
  issuer: 'https://auth.openai.com',
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  resource: 'https://api.openai.com/v1',
  registration: 'dynamic_agent_client',
  scopes: ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
  planScope: 'chatgpt.tokens.use.direct',
  defaultPort: 1455,
} as const

/** Only the port may change between sign-ins. OpenAI accepts nothing but this loopback address, never `localhost`. */
export function chatgptRedirectUri(port: number = CHATGPT_OAUTH.defaultPort): string {
  return `http://127.0.0.1:${port}/auth/callback`
}

export function chatgptAuthorizeUrl(input: {
  /** The client an earlier sign-in registered. Null registers one. */
  clientId: string | null
  appName: string
  hostId: string
  redirectUri: string
  state: string
  nonce: string
  challenge: string
  idTokenHint?: string | null
  loginHint?: string | null
}): string {
  const params = new URLSearchParams({ client_id: input.clientId ?? CHATGPT_OAUTH.registration })
  if (!input.clientId) params.set('agent_name_hint', input.appName)
  params.set('ext_agent_host_id', input.hostId)
  if (input.clientId && input.idTokenHint) params.set('id_token_hint', input.idTokenHint)
  if (input.loginHint) params.set('login_hint', input.loginHint)
  params.set('response_type', 'code')
  params.set('redirect_uri', input.redirectUri)
  params.set('scope', CHATGPT_OAUTH.scopes.join(' '))
  params.set('resource', CHATGPT_OAUTH.resource)
  params.set('state', input.state)
  params.set('nonce', input.nonce)
  params.set('code_challenge_method', 'S256')
  params.set('code_challenge', input.challenge)
  return `${CHATGPT_OAUTH.authorize}?${params}`
}

export interface ChatgptCallback {
  code: string
  state: string
  /** The registered client, sent on a first sign-in. */
  clientId: string | null
  scope: string | null
}

/** What the browser landed on after consent: the whole address, or only its query. */
export function parseChatgptCallback(pasted: string): ChatgptCallback {
  const text = pasted.trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    url = new URL(text.startsWith('?') ? text : `?${text}`, 'http://127.0.0.1/')
  }
  const query = url.searchParams
  const error = query.get('error')
  if (error) throw new OAuthError(error, query.get('error_description') || (error === 'access_denied' ? 'The sign-in was not approved' : error))
  const code = query.get('code')
  const state = query.get('state')
  if (!code || !state)
    throw new OAuthError('invalid_callback', 'That address has no code. Paste the whole address the browser opened after you approved.')
  return { code, state, clientId: query.get('client_id'), scope: query.get('scope') }
}

export function exchangeChatgptCode(
  input: { clientId: string; code: string; verifier: string; redirectUri: string },
  fetcher?: Fetcher,
): Promise<TokenResponse> {
  return tokenRequest(
    CHATGPT_OAUTH.token,
    {
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      resource: CHATGPT_OAUTH.resource,
    },
    fetcher,
  )
}

/** Each refresh returns a new refresh token and spends the old one, so refreshes of one login must never overlap. */
export function refreshChatgptTokens(input: { clientId: string; refreshToken: string }, fetcher?: Fetcher): Promise<TokenResponse> {
  return tokenRequest(
    CHATGPT_OAUTH.token,
    { grant_type: 'refresh_token', client_id: input.clientId, refresh_token: input.refreshToken, resource: CHATGPT_OAUTH.resource },
    fetcher,
  )
}

export async function verifyChatgptIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string },
  fetcher?: Fetcher,
): Promise<{ subject: string; email: string | null; plan: string | null }> {
  const config = await discover(CHATGPT_OAUTH.issuer, fetcher)
  const claims = await verifyIdToken(
    idToken,
    { jwksUri: config.jwks_uri, issuer: config.issuer, audience: expected.clientId, nonce: expected.nonce },
    fetcher,
  )
  const auth = claims['https://api.openai.com/auth'] as { chatgpt_plan_type?: unknown } | undefined
  return {
    subject: claims.sub as string,
    email: typeof claims.email === 'string' ? claims.email : null,
    plan: typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : null,
  }
}

export async function revokeChatgptToken(input: { clientId: string; refreshToken: string }, fetcher?: Fetcher): Promise<void> {
  const config = await discover(CHATGPT_OAUTH.issuer, fetcher)
  if (!config.revocation_endpoint) return
  await revokeToken(config.revocation_endpoint, { token: input.refreshToken, clientId: input.clientId, hint: 'refresh_token' }, fetcher)
}

export function grantedScopes(token: TokenResponse, callback: ChatgptCallback): string[] {
  return (token.scope ?? callback.scope ?? '').split(/\s+/).filter(Boolean)
}
