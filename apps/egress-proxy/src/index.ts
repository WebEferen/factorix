import { Redis } from 'ioredis'
import { createEgressProxy, type ProxyGrant } from './proxy'

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:56379', { maxRetriesPerRequest: 3 })
const port = Number(process.env.PORT ?? 8080)

const server = createEgressProxy({
  store: {
    async grant(token) {
      const raw = await redis.get(`proxy:token:${token}`)
      return raw ? (JSON.parse(raw) as ProxyGrant) : null
    },
    denied(grant, denial) {
      void redis.publish(grant.channel ?? `run:${grant.runId}:proxy`, JSON.stringify(denial)).catch(() => undefined)
    },
  },
  anthropicUpstream: process.env.FACTORIX_ANTHROPIC_UPSTREAM,
  openaiUpstream: process.env.FACTORIX_OPENAI_UPSTREAM,
  log: (message) => console.error(`[egress-proxy] ${message}`),
})

server.listen(port, '0.0.0.0', () => console.error(`[egress-proxy] listening on ${port}`))

const shutdown = () => {
  server.close()
  redis.disconnect()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
