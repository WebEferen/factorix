import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { RunnerLink } from './link'
import { createTunnelHub } from './tunnel'

const GRANT_CACHE_MS = 30_000
const MAX_BODY = 64 * 1024

interface StoreOptions {
  link: Pick<RunnerLink, 'request' | 'send' | 'onFrame'>
  /** Shared with the egress proxy. An agent that learned its own run token must not be able to ask what model key it maps to. */
  secret: string
  now?: () => number
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = ''
  for await (const chunk of request) {
    text += chunk
    if (text.length > MAX_BODY) throw new Error('too large')
  }
  return JSON.parse(text || '{}') as Record<string, unknown>
}

/**
 * What the runner's egress proxy asks in place of Redis: what a run token allows, and where to report a refusal. Answers come from
 * Factorix over the runner's own connection and are kept for a moment, since the proxy asks on every request.
 */
export function createGrantStore(options: StoreOptions): Server {
  const now = options.now ?? Date.now
  const cache = new Map<string, { grant: unknown; at: number }>()
  const secret = Buffer.from(options.secret)

  const allowed = (request: IncomingMessage): boolean => {
    const given = Buffer.from(String(request.headers['x-factorix-store'] ?? ''))
    return given.length === secret.length && timingSafeEqual(given, secret)
  }

  const tunnel = createTunnelHub({ link: options.link, secret: options.secret })

  return createServer((request, response) => {
    if (tunnel(request, response)) return
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.method !== 'POST' || !allowed(request)) return send(403, { error: 'forbidden' })
    void (async () => {
      const body = await readJson(request)
      const token = typeof body.token === 'string' ? body.token : ''
      if (request.url === '/grant') {
        const cached = cache.get(token)
        if (cached && now() - cached.at < GRANT_CACHE_MS) return send(200, { grant: cached.grant })
        const { grant } = await options.link.request<{ grant: unknown }>('/api/runner/grant', { token })
        if (grant) cache.set(token, { grant, at: now() })
        else cache.delete(token)
        for (const [key, entry] of cache) if (now() - entry.at >= GRANT_CACHE_MS) cache.delete(key)
        return send(200, { grant })
      }
      if (request.url === '/denied') {
        await options.link.request('/api/runner/denied', { token, host: body.host, reason: body.reason })
        return send(200, { ok: true })
      }
      send(404, { error: 'not found' })
    })().catch((error: Error) => send(502, { error: error.message }))
  })
}
