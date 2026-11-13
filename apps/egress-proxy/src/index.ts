import { Redis } from 'ioredis'
import { createEgressProxy, type ProxyGrant, type ProxyStore } from './proxy'

const port = Number(process.env.PORT ?? 8080)

function redisStore(url: string): { store: ProxyStore; close(): void } {
  const redis = new Redis(url, { maxRetriesPerRequest: 3 })
  return {
    store: {
      async grant(token) {
        const raw = await redis.get(`proxy:token:${token}`)
        return raw ? (JSON.parse(raw) as ProxyGrant) : null
      },
      denied(grant, denial) {
        void redis.publish(grant.channel ?? `run:${grant.runId}:proxy`, JSON.stringify(denial)).catch(() => undefined)
      },
    },
    close: () => redis.disconnect(),
  }
}

/** On a runner there is no Redis of ours. The runner process answers in its place, from Factorix. */
function runnerStore(url: string, secret: string): { store: ProxyStore; close(): void } {
  const tokens = new WeakMap<ProxyGrant, string>()
  const ask = async (path: string, body: unknown) => {
    const response = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-factorix-store': secret },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`The runner answered ${response.status}`)
    return (await response.json()) as { grant?: ProxyGrant | null }
  }
  return {
    store: {
      async grant(token) {
        const { grant } = await ask('/grant', { token })
        if (grant) tokens.set(grant, token)
        return grant ?? null
      },
      denied(grant, denial) {
        void ask('/denied', { token: tokens.get(grant), ...denial }).catch(() => undefined)
      },
    },
    close: () => undefined,
  }
}

const storeUrl = process.env.FACTORIX_STORE_URL
const backing = storeUrl
  ? runnerStore(storeUrl, process.env.FACTORIX_STORE_SECRET ?? '')
  : redisStore(process.env.REDIS_URL ?? 'redis://localhost:56379')

const server = createEgressProxy({
  store: backing.store,
  anthropicUpstream: process.env.FACTORIX_ANTHROPIC_UPSTREAM,
  openaiUpstream: process.env.FACTORIX_OPENAI_UPSTREAM,
  protectedHosts: (process.env.FACTORIX_PROXY_PROTECTED_HOSTS ?? 'postgres,redis,migrate,api,worker,web,preview-gateway')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean),
  log: (message) => console.error(`[egress-proxy] ${message}`),
})

server.listen(port, '0.0.0.0', () => console.error(`[egress-proxy] listening on ${port}`))

const shutdown = () => {
  server.close()
  backing.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
