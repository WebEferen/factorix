import { randomBytes } from 'node:crypto'
import { Redis } from 'ioredis'
import { createGateway, type PreviewRoute } from './gateway'

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:56379', { maxRetriesPerRequest: 3 })
const port = Number(process.env.PORT ?? 4102)
const baseUrl = process.env.FACTORIX_PREVIEW_URL ?? 'http://preview.localhost:4102'
const SEEN_EVERY_MS = 30_000
const lastSeen = new Map<string, number>()

const server = createGateway({
  baseUrl,
  store: {
    async route(slug) {
      const raw = await redis.get(`preview:route:${slug}`)
      return raw ? (JSON.parse(raw) as PreviewRoute) : null
    },
    async consumeTicket(token) {
      const raw = await redis.getdel(`preview:ticket:${token}`)
      return raw ? (JSON.parse(raw) as { slug: string }) : null
    },
    // Only the gateway signs and checks its cookies, so its key never needs to leave Redis or this process.
    async cookieKey() {
      await redis.set('preview:cookie-key', randomBytes(32).toString('base64'), 'NX')
      return Buffer.from((await redis.get('preview:cookie-key')) as string, 'base64')
    },
    seen(slug) {
      const now = Date.now()
      if (now - (lastSeen.get(slug) ?? 0) < SEEN_EVERY_MS) return
      lastSeen.set(slug, now)
      void redis.set(`preview:seen:${slug}`, String(now), 'EX', 7 * 86_400).catch(() => undefined)
    },
  },
  log: (message) => console.error(`[preview-gateway] ${message}`),
})

server.listen(port, '0.0.0.0', () => console.error(`[preview-gateway] listening on ${port} for ${baseUrl}`))

const shutdown = () => {
  server.close()
  redis.disconnect()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
