import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import { type AddressInfo, connect } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { COOKIE, createGateway, frameHeaders, type PreviewRoute, pickTarget, signCookie, slugOf, stripCookie, verifyCookie } from './gateway'

const BASE = 'http://preview.localhost:4102'
const key = Buffer.alloc(32, 7)
const listen = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

describe('slugOf', () => {
  it.each([
    ['abcdefghij.preview.localhost:4102', 'abcdefghij'],
    ['ABCDEFGHIJ.preview.localhost', 'abcdefghij'],
    ['preview.localhost:4102', null],
    ['x.abcdefghij.preview.localhost', null],
    ['abcdefghij.preview.localhost.evil.test', null],
    ['abc.preview.localhost', null],
    [undefined, null],
  ])('%s is %s', (host, slug) => {
    expect(slugOf(host, BASE)).toBe(slug)
  })
})

describe('cookies', () => {
  it('opens only the preview it was signed for, until it expires', () => {
    const value = signCookie(key, 'abcdefghij', 2000)
    expect(verifyCookie(key, value, 'abcdefghij', 1000)).toBe(true)
    expect(verifyCookie(key, value, 'zzzzzzzzzz', 1000)).toBe(false)
    expect(verifyCookie(key, value, 'abcdefghij', 2000)).toBe(false)
    expect(verifyCookie(Buffer.alloc(32, 8), value, 'abcdefghij', 1000)).toBe(false)
    expect(verifyCookie(key, value.replace('2000', '9999'), 'abcdefghij', 1000)).toBe(false)
    expect(verifyCookie(key, undefined, 'abcdefghij', 1000)).toBe(false)
  })

  it('strips its own cookie and keeps the app’s', () => {
    expect(stripCookie(`a=1; ${COOKIE}=secret; b=2`, COOKIE)).toBe('a=1; b=2')
    expect(stripCookie(`${COOKIE}=secret`, COOKIE)).toBeUndefined()
  })
})

describe('pickTarget', () => {
  const route: PreviewRoute = {
    instanceId: 'i',
    state: 'ready',
    upstream: { host: 'web', port: 3000 },
    paths: [
      { prefix: '/api', strip: false, host: 'api', port: 4000 },
      { prefix: '/api/admin', strip: true, host: 'admin', port: 5000 },
    ],
    frameAncestors: [],
    issueUrl: null,
  }

  it('takes the longest matching prefix on a path boundary', () => {
    expect(pickTarget(route, '/api/users?x=1')).toEqual({ target: { host: 'api', port: 4000 }, path: '/api/users?x=1' })
    expect(pickTarget(route, '/api')).toEqual({ target: { host: 'api', port: 4000 }, path: '/api' })
    expect(pickTarget(route, '/apiary')).toEqual({ target: { host: 'web', port: 3000 }, path: '/apiary' })
    expect(pickTarget(route, '/api/admin/users')).toEqual({ target: { host: 'admin', port: 5000 }, path: '/users' })
    expect(pickTarget(route, '/api/admin')).toEqual({ target: { host: 'admin', port: 5000 }, path: '/' })
  })
})

describe('frameHeaders', () => {
  it('replaces the app’s framing rules with Factorix only and keeps the rest of its policy', () => {
    const headers = frameHeaders(
      { 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'content-type': 'text/html' },
      ['http://localhost:4101'],
    )
    expect(headers['x-frame-options']).toBeUndefined()
    expect(headers['content-security-policy']).toEqual(["default-src 'self'", "frame-ancestors 'self' http://localhost:4101"])
    expect(headers['content-type']).toBe('text/html')
  })
})

describe('gateway', () => {
  const routes = new Map<string, PreviewRoute>()
  const tickets = new Map<string, { slug: string }>()
  const seen: string[] = []
  let upstream: Server
  let upstreamPort: number
  let gateway: Server
  let gatewayPort: number

  const route = (overrides: Partial<PreviewRoute> = {}): PreviewRoute => ({
    instanceId: 'i',
    state: 'ready',
    upstream: { host: '127.0.0.1', port: upstreamPort },
    paths: [{ prefix: '/api', strip: true, host: '127.0.0.1', port: upstreamPort }],
    frameAncestors: ['http://localhost:4101'],
    issueUrl: 'http://localhost:4101/issues/1',
    ...overrides,
  })

  const get = (host: string, path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const outbound = httpRequest({ host: '127.0.0.1', port: gatewayPort, path, headers: { host, ...headers } }, (response) => {
        let body = ''
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
      })
      outbound.on('error', reject)
      outbound.end()
    })

  const host = (slug: string) => `${slug}.preview.localhost:4102`
  const signedIn = (slug: string) => ({ cookie: `app=1; ${COOKIE}=${signCookie(key, slug, Math.floor(Date.now() / 1000) + 60)}` })

  beforeAll(async () => {
    upstream = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'x-frame-options': 'DENY' })
      response.end(JSON.stringify({ path: request.url, cookie: request.headers.cookie ?? null, host: request.headers.host }))
    })
    upstream.on('upgrade', (request, socket) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Cookie: ${request.headers.cookie ?? ''}\r\n\r\n`,
      )
      socket.on('data', (chunk) => socket.write(chunk))
    })
    upstreamPort = await listen(upstream)
    gateway = createGateway({
      baseUrl: BASE,
      store: {
        route: async (slug) => routes.get(slug) ?? null,
        consumeTicket: async (token) => {
          const ticket = tickets.get(token) ?? null
          tickets.delete(token)
          return ticket
        },
        cookieKey: async () => key,
        seen: (slug) => seen.push(slug),
      },
    })
    gatewayPort = await listen(gateway)
  })

  afterAll(() => {
    upstream.close()
    gateway.close()
  })

  beforeEach(() => {
    routes.clear()
    seen.length = 0
    routes.set('aaaaaaaaaa', route())
  })

  it('turns a ticket into a cookie once, and the cookie into access', async () => {
    tickets.set('t1', { slug: 'aaaaaaaaaa' })
    const entered = await get(host('aaaaaaaaaa'), '/__factorix/enter?ticket=t1&to=/dashboard')
    expect(entered.status).toBe(303)
    expect(entered.headers.location).toBe('/dashboard')
    const setCookie = (entered.headers['set-cookie'] ?? [])[0] as string
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/Secure; SameSite=None; Partitioned/)
    expect((await get(host('aaaaaaaaaa'), '/__factorix/enter?ticket=t1')).status).toBe(403)

    const cookie = setCookie.split(';')[0] as string
    const page = await get(host('aaaaaaaaaa'), '/hello', { cookie })
    expect(page.status).toBe(200)
    expect(JSON.parse(page.body)).toMatchObject({ path: '/hello', host: host('aaaaaaaaaa') })
    expect(seen).toEqual(['aaaaaaaaaa'])
  })

  it('refuses a ticket made for another preview, and an outside redirect', async () => {
    tickets.set('t2', { slug: 'bbbbbbbbbb' })
    expect((await get(host('aaaaaaaaaa'), '/__factorix/enter?ticket=t2')).status).toBe(403)
    tickets.set('t3', { slug: 'aaaaaaaaaa' })
    expect((await get(host('aaaaaaaaaa'), '/__factorix/enter?ticket=t3&to=//evil.example')).headers.location).toBe('/')
  })

  it('asks for a sign-in without the cookie, and never takes another preview’s', async () => {
    const anonymous = await get(host('aaaaaaaaaa'), '/')
    expect(anonymous.status).toBe(401)
    expect(anonymous.body).toContain('http://localhost:4101/issues/1')
    routes.set('bbbbbbbbbb', route())
    expect((await get(host('bbbbbbbbbb'), '/', signedIn('aaaaaaaaaa'))).status).toBe(401)
  })

  it('hides its cookie from the app and lets only Factorix frame the page', async () => {
    const response = await get(host('aaaaaaaaaa'), '/x', signedIn('aaaaaaaaaa'))
    expect(JSON.parse(response.body).cookie).toBe('app=1')
    expect(response.headers['x-frame-options']).toBeUndefined()
    expect(response.headers['content-security-policy']).toBe("frame-ancestors 'self' http://localhost:4101")
  })

  it('sends path rules to their service, stripping the prefix when asked', async () => {
    const response = await get(host('aaaaaaaaaa'), '/api/users?page=2', signedIn('aaaaaaaaaa'))
    expect(JSON.parse(response.body).path).toBe('/users?page=2')
  })

  it('shows a page that reloads while the preview starts or the app does not answer', async () => {
    routes.set('aaaaaaaaaa', route({ state: 'starting' }))
    const starting = await get(host('aaaaaaaaaa'), '/', signedIn('aaaaaaaaaa'))
    expect(starting.status).toBe(503)
    expect(starting.body).toContain('http-equiv="refresh"')
    routes.set('aaaaaaaaaa', route({ upstream: { host: '127.0.0.1', port: 1 } }))
    expect((await get(host('aaaaaaaaaa'), '/', signedIn('aaaaaaaaaa'))).status).toBe(502)
  })

  it('says so when the preview is not running, and answers health checks on any host', async () => {
    expect((await get(host('cccccccccc'), '/', signedIn('cccccccccc'))).status).toBe(404)
    expect((await get('localhost:4102', '/__factorix/health')).status).toBe(200)
    expect((await get('example.com', '/')).status).toBe(404)
  })

  const upgrade = (headers: string) =>
    new Promise<string>((resolve) => {
      const socket = connect(gatewayPort, '127.0.0.1', () => {
        socket.write(`GET /socket HTTP/1.1\r\nHost: ${host('aaaaaaaaaa')}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${headers}\r\n`)
      })
      let received = ''
      socket.on('data', (chunk) => {
        received += chunk.toString()
        if (received.includes('\r\n\r\n') && !received.includes('ping') && received.startsWith('HTTP/1.1 101')) socket.write('ping')
        if (received.includes('ping') || !received.startsWith('HTTP/1.1 101')) {
          socket.end()
          resolve(received)
        }
      })
    })

  it('carries WebSocket upgrades for signed-in viewers only, without its cookie', async () => {
    const accepted = await upgrade(`Cookie: ${signedIn('aaaaaaaaaa').cookie}\r\n`)
    expect(accepted).toMatch(/^HTTP\/1.1 101/)
    expect(accepted).toContain('X-Cookie: app=1\r\n')
    expect(accepted).toContain('ping')
    expect(await upgrade('')).toMatch(/^HTTP\/1.1 401/)
  })
})
