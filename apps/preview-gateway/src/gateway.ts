import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'

export interface PreviewTarget {
  host: string
  port: number
  /** Set when the service is on a runner's machine, which only `dial` can reach. */
  runner?: string
}

export interface PreviewRoute {
  instanceId: string
  state: 'starting' | 'ready'
  upstream: PreviewTarget
  paths: (PreviewTarget & { prefix: string; strip: boolean })[]
  frameAncestors: string[]
  issueUrl: string | null
}

export interface GatewayStore {
  route(slug: string): Promise<PreviewRoute | null>
  /** Single use: a ticket is gone once read. */
  consumeTicket(token: string): Promise<{ slug: string } | null>
  cookieKey(): Promise<Buffer>
  seen(slug: string): void
}

export interface GatewayOptions {
  store: GatewayStore
  /** The address previews hang off, such as http://preview.localhost:4102. Each preview is a subdomain of it. */
  baseUrl: string
  /** Opens a connection to a service on a runner's machine. Without it, previews on runners do not open. */
  dial?: (runnerId: string, target: PreviewTarget) => Promise<Duplex>
  log?: (message: string) => void
  now?: () => number
}

export const COOKIE = 'fxp'
const COOKIE_SECONDS = 12 * 3600
const SLUG = /^[a-z0-9]{10}$/
const OWN_PREFIX = '/__factorix/'
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

export function slugOf(hostHeader: string | undefined, baseUrl: string): string | null {
  if (!hostHeader) return null
  const hostname = hostHeader.replace(/:\d+$/, '').toLowerCase()
  const suffix = `.${new URL(baseUrl).hostname.toLowerCase()}`
  if (!hostname.endsWith(suffix)) return null
  const slug = hostname.slice(0, -suffix.length)
  return SLUG.test(slug) ? slug : null
}

function signature(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url')
}

export function signCookie(key: Buffer, slug: string, expiresAt: number): string {
  const payload = `${slug}.${expiresAt}`
  return `${payload}.${signature(key, payload)}`
}

/** A cookie only opens the preview it was made for, so one preview's code cannot use it on another. */
export function verifyCookie(key: Buffer, value: string | undefined, slug: string, now: number): boolean {
  if (!value) return false
  const [cookieSlug, expires, mac] = value.split('.')
  if (!cookieSlug || !expires || !mac || cookieSlug !== slug || Number(expires) <= now) return false
  const expected = Buffer.from(signature(key, `${cookieSlug}.${expires}`))
  const actual = Buffer.from(mac)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function cookies(header: string | undefined): [string, string][] {
  if (!header) return []
  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=')
      return index < 0 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)]
    })
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  return cookies(header).find(([key]) => key === name)?.[1]
}

/** The app never sees the gateway's cookie. */
export function stripCookie(header: string | undefined, name: string): string | undefined {
  const kept = cookies(header).filter(([key]) => key !== name)
  return kept.length > 0 ? kept.map(([key, value]) => (value ? `${key}=${value}` : key)).join('; ') : undefined
}

export function pickTarget(route: PreviewRoute, path: string): { target: PreviewTarget; path: string } {
  const pathname = path.split('?')[0] ?? '/'
  let best: PreviewRoute['paths'][number] | undefined
  for (const rule of route.paths) {
    const prefix = rule.prefix.replace(/\/+$/, '') || '/'
    const matches = prefix === '/' || pathname === prefix || pathname.startsWith(`${prefix}/`)
    if (matches && (!best || prefix.length > best.prefix.replace(/\/+$/, '').length)) best = rule
  }
  if (!best) return { target: route.upstream, path }
  const prefix = best.prefix.replace(/\/+$/, '')
  const rest = best.strip && prefix ? path.slice(prefix.length) : path
  return { target: { host: best.host, port: best.port, runner: best.runner }, path: rest.startsWith('/') ? rest : `/${rest}` }
}

/** Framing is allowed from Factorix only, whatever the app itself says, so no other site can embed a signed-in preview. */
export function frameHeaders(headers: IncomingHttpHeaders, frameAncestors: string[]): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name === 'x-frame-options') continue
    if (name === 'content-security-policy') {
      const policies = (Array.isArray(value) ? value : [value])
        .map((policy) =>
          policy
            .split(';')
            .map((directive) => directive.trim())
            .filter((directive) => directive && !/^frame-ancestors(\s|$)/i.test(directive))
            .join('; '),
        )
        .filter(Boolean)
      if (policies.length > 0) result[name] = policies
      continue
    }
    result[name] = value
  }
  const own = `frame-ancestors 'self' ${frameAncestors.join(' ')}`.trim()
  const existing = result['content-security-policy']
  result['content-security-policy'] = existing ? [...(existing as string[]), own] : own
  return result
}

function page(title: string, body: string, refresh = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${
    refresh ? '<meta http-equiv="refresh" content="3">' : ''
  }<title>${title}</title><style>
:root{color-scheme:light dark;--bg:#fafaf9;--ink:#1c1917;--muted:#78716c}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--ink:#f5f5f4;--muted:#a8a29e}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{max-width:28rem;padding:24px}h1{font-size:17px;margin:0 0 6px}p{margin:0;color:var(--muted)}a{color:inherit}
</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

function safeRedirect(to: string | null): string {
  return to?.startsWith('/') && !to.startsWith('//') && !to.startsWith('/\\') ? to : '/'
}

export function createGateway(options: GatewayOptions): Server {
  const { store } = options
  const log = options.log ?? (() => undefined)
  const now = options.now ?? Date.now
  let key: Promise<Buffer> | null = null
  const cookieKey = () => {
    key ??= store.cookieKey().catch((error) => {
      key = null
      throw error
    })
    return key
  }

  const secureContext = (request: IncomingMessage) => {
    const hostname = (request.headers.host ?? '').replace(/:\d+$/, '')
    return request.headers['x-forwarded-proto'] === 'https' || hostname === 'localhost' || hostname.endsWith('.localhost')
  }

  const respond = (response: ServerResponse, status: number, html: string, extra: Record<string, string> = {}) => {
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra })
    response.end(html)
  }

  const frameOnly = (route: PreviewRoute | null): Record<string, string> =>
    route ? { 'content-security-policy': `frame-ancestors 'self' ${route.frameAncestors.join(' ')}`.trim() } : {}

  const signIn = async (request: IncomingMessage, response: ServerResponse, slug: string, url: URL) => {
    const ticket = url.searchParams.get('ticket')
    const claim = ticket ? await store.consumeTicket(ticket) : null
    if (!claim || claim.slug !== slug) {
      return respond(response, 403, page('This link has expired', 'Open the preview again from its issue in Factorix.'))
    }
    const expiresAt = Math.floor(now() / 1000) + COOKIE_SECONDS
    const attributes = secureContext(request) ? 'Secure; SameSite=None; Partitioned' : 'SameSite=Lax'
    response.writeHead(303, {
      location: safeRedirect(url.searchParams.get('to')),
      'set-cookie': `${COOKIE}=${signCookie(await cookieKey(), slug, expiresAt)}; Path=/; HttpOnly; Max-Age=${COOKIE_SECONDS}; ${attributes}`,
      'cache-control': 'no-store',
    })
    response.end()
  }

  /** Everything both plain requests and WebSocket upgrades need before they may reach the app. */
  const admit = async (
    request: IncomingMessage,
  ): Promise<
    { ok: true; slug: string; route: PreviewRoute } | { ok: false; status: number; title: string; body: string; route: PreviewRoute | null }
  > => {
    const slug = slugOf(request.headers.host, options.baseUrl)
    if (!slug) return { ok: false, status: 404, title: 'Not a preview address', body: 'Previews open from their issue in Factorix.', route: null }
    const route = await store.route(slug)
    const signedIn = verifyCookie(await cookieKey(), readCookie(request.headers.cookie, COOKIE), slug, Math.floor(now() / 1000))
    if (!signedIn) {
      const link = route?.issueUrl ? ` <a href="${escapeHtml(route.issueUrl)}" target="_top">Go to the issue</a>.` : ''
      return {
        ok: false,
        status: 401,
        title: 'Open this preview from Factorix',
        body: `Previews open from their issue, which signs you in.${link}`,
        route,
      }
    }
    if (!route)
      return { ok: false, status: 404, title: 'This preview is not running', body: 'Start it again from its issue in Factorix.', route: null }
    store.seen(slug)
    return { ok: true, slug, route }
  }

  const dialRunner = (target: PreviewTarget): Promise<Duplex> => {
    if (!options.dial) throw new Error('this gateway cannot reach runners')
    return options.dial(target.runner as string, target)
  }

  const forward = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://gateway')
    if (url.pathname === `${OWN_PREFIX}health`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      return void response.end('{"ok":true}')
    }
    const slug = slugOf(request.headers.host, options.baseUrl)
    // Caddy's on-demand TLS asks this before it requests a certificate, so only running previews get one. A preview's own host never reaches it.
    if (!slug && url.pathname === `${OWN_PREFIX}tls`) {
      const asked = slugOf(url.searchParams.get('domain') ?? undefined, options.baseUrl)
      response.writeHead(asked && (await store.route(asked)) ? 200 : 404, { 'cache-control': 'no-store' })
      return void response.end()
    }
    if (slug && url.pathname === `${OWN_PREFIX}enter`) return signIn(request, response, slug, url)
    const admission = await admit(request)
    if (!admission.ok) return respond(response, admission.status, page(admission.title, admission.body), frameOnly(admission.route))
    const { route } = admission
    if (route.state !== 'ready') {
      return respond(response, 503, page('Starting the preview', 'This page reloads by itself once the app answers.', true), frameOnly(route))
    }
    const { target, path } = pickTarget(route, request.url ?? '/')
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value
    const cookie = stripCookie(request.headers.cookie, COOKIE)
    if (cookie) headers.cookie = cookie
    else delete headers.cookie
    headers['x-forwarded-host'] = request.headers.host ?? ''
    headers['x-forwarded-proto'] = (request.headers['x-forwarded-proto'] as string | undefined) ?? 'http'
    headers['x-forwarded-for'] = request.socket.remoteAddress ?? ''
    const notAnswering = () =>
      respond(
        response,
        502,
        page('The app is not answering', 'It may still be starting or have stopped. This page reloads by itself.', true),
        frameOnly(route),
      )
    let agent: Agent | undefined
    if (target.runner) {
      let tunnel: Duplex
      try {
        tunnel = await dialRunner(target)
      } catch (error) {
        log(`runner ${target.runner} could not be reached: ${(error as Error).message}`)
        return notAnswering()
      }
      agent = new Agent({ keepAlive: false })
      agent.createConnection = () => tunnel
    }
    const outbound = httpRequest({ host: target.host, port: target.port, method: request.method, path, headers, agent }, (upstream) => {
      response.writeHead(upstream.statusCode ?? 502, frameHeaders(upstream.headers, route.frameAncestors))
      upstream.pipe(response)
    })
    outbound.on('error', (error) => {
      log(`upstream ${target.host}:${target.port} failed: ${error.message}`)
      if (response.headersSent) return void response.destroy()
      notAnswering()
    })
    request.pipe(outbound)
    response.on('close', () => outbound.destroy())
  }

  const upgrade = async (request: IncomingMessage, client: Duplex, head: Buffer) => {
    const refuse = (status: string) => client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
    const admission = await admit(request)
    if (!admission.ok) return refuse(admission.status === 401 ? '401 Unauthorized' : '404 Not Found')
    if (admission.route.state !== 'ready') return refuse('503 Service Unavailable')
    const { target, path } = pickTarget(admission.route, request.url ?? '/')
    const lines = [`${request.method} ${path} HTTP/1.1`]
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index] as string
      const value = request.rawHeaders[index + 1] as string
      if (name.toLowerCase() === 'cookie') {
        const kept = stripCookie(value, COOKIE)
        if (kept) lines.push(`${name}: ${kept}`)
      } else lines.push(`${name}: ${value}`)
    }
    const begin = (upstream: Duplex) => {
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    }
    let upstream: Duplex
    if (target.runner) {
      try {
        upstream = await dialRunner(target)
      } catch {
        return refuse('502 Bad Gateway')
      }
      begin(upstream)
    } else {
      const socket = connect({ host: target.host, port: target.port }, () => begin(socket))
      upstream = socket
    }
    upstream.on('error', () => refuse('502 Bad Gateway'))
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  }

  const server = createServer((request, response) => {
    forward(request, response).catch((error: Error) => {
      log(`request failed: ${error.message}`)
      if (!response.headersSent) respond(response, 500, page('The gateway failed', 'Try again in a moment.'))
      else response.destroy()
    })
  })
  server.on('upgrade', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => undefined)
    upgrade(request, client, head).catch((error: Error) => {
      log(`upgrade failed: ${error.message}`)
      client.destroy()
    })
  })
  return server
}
