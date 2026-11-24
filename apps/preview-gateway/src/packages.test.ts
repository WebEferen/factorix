import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import { type AddressInfo, connect } from 'node:net'
import { PAGE_POLICY } from '@factorix/connectors'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PreviewTarget } from './gateway'
import { createPackageGateway, packageRouteOf } from './packages'

const SLUG = 'abcde12345'

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body = '') {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      let text = ''
      response.on('data', (chunk) => (text += chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

describe('packageRouteOf', () => {
  it('tells a page from a signed call, and refuses anything else', () => {
    expect(packageRouteOf('GET', `/_package/${SLUG}/factorix/pages/a?factorix=x`)).toEqual({
      slug: SLUG,
      path: '/factorix/pages/a?factorix=x',
      page: true,
    })
    expect(packageRouteOf('POST', `/_package/${SLUG}/factorix/pages/a`)).toMatchObject({ page: true })
    expect(packageRouteOf('POST', `/${SLUG}/factorix`)).toEqual({ slug: SLUG, path: '/factorix', page: false })
    expect(packageRouteOf('GET', `/${SLUG}/factorix`)).toBeNull()
    expect(packageRouteOf('POST', '/not-a-slug/factorix')).toBeNull()
    expect(packageRouteOf('GET', `/_package/../${SLUG}`)).toBeNull()
  })
})

describe('the package gateway', () => {
  let app: Server
  let appPort: number
  let gateway: Server
  let port: number
  let dialed: string[] = []
  const routes = new Map<string, PreviewTarget>()

  beforeAll(async () => {
    app = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        response.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'fx_session=stolen',
          'content-security-policy': "default-src 'none'",
        })
        response.end(
          JSON.stringify({
            method: request.method,
            url: request.url,
            cookie: request.headers.cookie ?? null,
            auth: request.headers.authorization ?? null,
            body,
          }),
        )
      })
    })
    appPort = await listen(app)
    gateway = createPackageGateway({
      route: async (slug) => routes.get(slug) ?? null,
      dial: async (runnerId, target) => {
        dialed.push(`${runnerId} ${target.host}:${target.port}`)
        return connect(appPort, '127.0.0.1')
      },
    })
    port = await listen(gateway)
  })

  afterAll(() => {
    gateway.close()
    app.close()
  })

  it('passes a signed call on as it came', async () => {
    routes.set(SLUG, { host: '127.0.0.1', port: appPort })
    const answer = await send(port, 'POST', `/${SLUG}/factorix`, { 'x-factorix-signature': 's' }, '{"method":"manifest"}')
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toMatchObject({ method: 'POST', url: '/factorix', body: '{"method":"manifest"}' })
  })

  it('serves a page without the session, and under the sandbox policy whatever the plugin sends', async () => {
    routes.set(SLUG, { host: '127.0.0.1', port: appPort })
    const answer = await send(port, 'GET', `/_package/${SLUG}/factorix/pages/a?factorix=token`, {
      cookie: 'fx_session=secret',
      authorization: 'Bearer t',
    })
    expect(JSON.parse(answer.body)).toMatchObject({ url: '/factorix/pages/a?factorix=token', cookie: null, auth: null })
    expect(answer.headers['set-cookie']).toBeUndefined()
    expect(answer.headers['content-security-policy']).toBe(`default-src 'none', ${PAGE_POLICY}`)
    expect(answer.headers['referrer-policy']).toBe('no-referrer')
  })

  it('reaches a package on a runner through the runner', async () => {
    dialed = []
    routes.set(SLUG, { host: `fx-env-${SLUG}-app`, port: 8080, runner: 'runner-1' })
    const answer = await send(port, 'POST', `/${SLUG}/factorix`)
    expect(answer.status).toBe(200)
    expect(dialed).toEqual([`runner-1 fx-env-${SLUG}-app:8080`])
  })

  it('says when a package is not running, and knows nothing else', async () => {
    routes.clear()
    expect((await send(port, 'POST', `/${SLUG}/factorix`)).status).toBe(502)
    expect((await send(port, 'GET', `/${SLUG}/factorix`)).status).toBe(404)
    expect((await send(port, 'GET', '/__plugins')).status).toBe(404)
  })
})
