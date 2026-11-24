import { randomBytes } from 'node:crypto'
import { Redis } from 'ioredis'
import { createGateway, type PreviewRoute, type PreviewTarget } from './gateway'
import { createPackageGateway } from './packages'
import { createRunnerDialer } from './runners'

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:56379', { maxRetriesPerRequest: 3 })
const port = Number(process.env.PORT ?? 4102)
/** Only the internal network reaches this one. Nothing routes a public address to it. */
const packagePort = Number(process.env.PACKAGE_PORT ?? 4103)
const baseUrl = process.env.FACTORIX_PREVIEW_URL ?? 'http://preview.localhost:4102'
const SEEN_EVERY_MS = 30_000
const lastSeen = new Map<string, number>()
const runners = createRunnerDialer(redis)

const server = createGateway({
  baseUrl,
  dial: runners.dial,
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

const packages = createPackageGateway({
  dial: runners.dial,
  async route(slug) {
    const raw = await redis.get(`plugin:route:${slug}`)
    return raw ? (JSON.parse(raw) as PreviewTarget) : null
  },
  log: (message) => console.error(`[preview-gateway] ${message}`),
})
packages.listen(packagePort, '0.0.0.0', () => console.error(`[preview-gateway] serving plugin packages on ${packagePort}`))

const shutdown = () => {
  server.close()
  packages.close()
  runners.close()
  redis.disconnect()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
