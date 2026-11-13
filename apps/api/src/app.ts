import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppDeps } from './deps'
import { API_TOKEN_PREFIX, checkTokenScope, loadApiToken, loadSession, requireAuth, SESSION_COOKIE } from './lib/auth'
import { orgChannel } from './lib/channels'
import { HttpError } from './lib/errors'
import { authRoutes } from './routes/auth'
import { catalogRoutes } from './routes/catalog'
import { connectionRoutes } from './routes/connections'
import { environmentRoutes } from './routes/environments'
import { issueRoutes } from './routes/issues'
import { previewRoutes } from './routes/previews'
import { projectRoutes } from './routes/projects'
import { runnerRoutes } from './routes/runners'
import { runRoutes } from './routes/runs'
import { settingsRoutes } from './routes/settings'
import { webhookRoutes } from './routes/webhooks'
import { workflowRoutes } from './routes/workflows'
import { readSettings } from './services/settings'
import { openSse, RedisFanout } from './sse'

export function buildApp(deps: AppDeps, options: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ? { level: 'info' } : false, trustProxy: true, bodyLimit: 5 * 1024 * 1024 })
  const fanout = new RedisFanout(deps.redis)
  app.addHook('onClose', async () => fanout.close())

  void app.register(cookie)
  app.decorateRequest('auth', null)

  app.addHook('onRequest', async (request) => {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1]
    if (bearer?.startsWith(API_TOKEN_PREFIX)) {
      request.auth = await loadApiToken(deps.db, bearer)
      return
    }
    const token = request.cookies[SESSION_COOKIE]
    request.auth = token ? await loadSession(deps.db, token, async () => (await readSettings(deps)).sessionDays) : null
  })
  app.addHook('onRequest', async (request) => checkTokenScope(request))

  // SameSite=Lax already blocks cross-site POSTs in browsers. This also refuses them from anything that sends Origin.
  app.addHook('onRequest', async (request) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.url.startsWith('/webhooks/')) return
    const origin = request.headers.origin
    if (!origin) return
    const host = request.headers['x-forwarded-host'] ?? request.headers.host
    if (new URL(origin).host === host) return
    // The environment's address stays allowed, so a wrong override cannot lock anyone out of fixing it.
    const allowed = [deps.env.FACTORIX_PUBLIC_URL, (await readSettings(deps)).publicUrl].map((url) => new URL(url).origin)
    if (!allowed.includes(origin)) throw new HttpError(403, 'bad_origin', 'Cross-origin requests are not allowed')
  })

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } })
    }
    const status = error.statusCode ?? 500
    if (status >= 500) request.log.error(error)
    return reply.status(status).send({
      error: { code: status >= 500 ? 'internal' : 'bad_request', message: status >= 500 ? 'Something went wrong on our side' : error.message },
    })
  })

  app.get('/healthz', async () => {
    await deps.db.raw('SELECT 1')
    await deps.redis.ping()
    return { ok: true }
  })

  app.get('/api/stream', async (request, reply) => {
    const { account } = requireAuth(request)
    const sse = openSse(request, reply)
    const unsubscribe = await fanout.subscribe(orgChannel(account.orgId), (message) => sse.send(message))
    sse.onClose(unsubscribe)
  })

  authRoutes(app, deps)
  catalogRoutes(app, deps)
  connectionRoutes(app, deps)
  environmentRoutes(app, deps)
  projectRoutes(app, deps)
  issueRoutes(app, deps)
  previewRoutes(app, deps, fanout)
  runRoutes(app, deps, fanout)
  runnerRoutes(app, deps)
  settingsRoutes(app, deps)
  webhookRoutes(app, deps)
  workflowRoutes(app, deps)
  return app
}
