import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { Duplex } from 'node:stream'
import { PACKAGE_PAGES, PACKAGE_SLUG, PAGE_POLICY, PAGE_REQUEST_DROPS, PAGE_RESPONSE_DROPS } from '@factorix/connectors'
import type { PreviewTarget } from './gateway'

export interface PackageGatewayOptions {
  /** Where a package's server answers, written by the worker once it started. */
  route(slug: string): Promise<PreviewTarget | null>
  dial?: (runnerId: string, target: PreviewTarget) => Promise<Duplex>
  log?: (message: string) => void
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

export function packageRouteOf(method: string, url: string): { slug: string; path: string; page: boolean } | null {
  const queryAt = url.indexOf('?')
  const pathname = queryAt === -1 ? url : url.slice(0, queryAt)
  const page = pathname.startsWith(`${PACKAGE_PAGES}/`)
  if (!page && method !== 'POST') return null
  const match = /^\/([^/]+)(\/.*)?$/.exec(page ? pathname.slice(PACKAGE_PAGES.length) : pathname)
  if (!match?.[1] || !PACKAGE_SLUG.test(match[1])) return null
  return { slug: match[1], path: `${match[2] ?? '/'}${queryAt === -1 ? '' : url.slice(queryAt)}`, page }
}

function answer(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ error: { message } }))
}

/**
 * Factorix's way in to uploaded plugin packages, on a port only the internal network reaches. Its signed calls arrive as
 * POST /<slug>/..., and people's page requests, which the web passes on from Factorix's own address, as
 * /_package/<slug>/..., served under the same policy the plugin host gives bundled pages.
 */
export function createPackageGateway(options: PackageGatewayOptions): Server {
  const log = options.log ?? (() => undefined)

  const forward = async (request: IncomingMessage, response: ServerResponse) => {
    const route = packageRouteOf(request.method ?? 'GET', request.url ?? '/')
    if (!route) return answer(response, 404, 'Not found')
    const target = await options.route(route.slug)
    if (!target) return answer(response, 502, 'This plugin is not running')
    const headers: IncomingHttpHeaders = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(name) && !(route.page && PAGE_REQUEST_DROPS.includes(name))) headers[name] = value
    }
    if (!headers['x-forwarded-host'] && request.headers.host) headers['x-forwarded-host'] = request.headers.host
    if (!headers['x-forwarded-proto']) headers['x-forwarded-proto'] = 'http'
    let agent: Agent | undefined
    if (target.runner) {
      if (!options.dial) return answer(response, 502, 'This gateway cannot reach runners')
      let tunnel: Duplex
      try {
        tunnel = await options.dial(target.runner, target)
      } catch (error) {
        log(`runner ${target.runner} could not be reached: ${(error as Error).message}`)
        return answer(response, 502, 'The runner this plugin is on cannot be reached')
      }
      agent = new Agent({ keepAlive: false })
      agent.createConnection = () => tunnel
    }
    const outbound = httpRequest({ host: target.host, port: target.port, method: request.method, path: route.path, headers, agent }, (upstream) => {
      const kept: IncomingHttpHeaders = {}
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name) && !(route.page && PAGE_RESPONSE_DROPS.includes(name))) kept[name] = value
      }
      if (route.page) {
        const own = kept['content-security-policy']
        kept['content-security-policy'] = [...(own === undefined ? [] : [own].flat()), PAGE_POLICY]
        kept['referrer-policy'] = 'no-referrer'
        kept['x-content-type-options'] = 'nosniff'
      }
      response.writeHead(upstream.statusCode ?? 502, kept)
      upstream.pipe(response)
    })
    outbound.on('error', (error) => {
      log(`package ${route.slug} failed: ${error.message}`)
      if (response.headersSent) return void response.destroy()
      answer(response, 502, 'This plugin is not answering')
    })
    request.pipe(outbound)
    response.on('close', () => outbound.destroy())
  }

  return createServer((request, response) => {
    forward(request, response).catch((error: Error) => {
      log(`package request failed: ${error.message}`)
      if (!response.headersSent) answer(response, 500, 'The gateway failed')
      else response.destroy()
    })
  })
}
