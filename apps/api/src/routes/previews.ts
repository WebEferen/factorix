import type { IssueRow } from '@factorix/db'
import { type PreviewLogDto, previewOpenInput } from '@factorix/schemas'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../deps'
import { requireAuth } from '../lib/auth'
import { previewKeys } from '../lib/channels'
import { notFound, parseBody } from '../lib/errors'
import type { EnvironmentAction } from '../lib/outbox'
import { openPreview, previewDto, previewOf, requestPreview } from '../services/previews'
import type { RedisFanout } from '../sse'
import { openSse } from '../sse'

const ACTIONS: EnvironmentAction[] = ['start', 'reset', 'refresh', 'stop']

export function previewRoutes(app: FastifyInstance, deps: AppDeps, fanout: RedisFanout): void {
  const { db, redis } = deps

  const load = async (orgId: string, id: string): Promise<IssueRow> => {
    const issue = await db<IssueRow>('issues').where({ id, orgId }).first()
    if (!issue) throw notFound('Issue')
    return issue
  }

  app.get('/api/issues/:id/preview', async (request) => {
    const { account } = requireAuth(request)
    return { preview: await previewDto(deps, await load(account.orgId, (request.params as { id: string }).id)) }
  })

  app.post('/api/issues/:id/preview/open', async (request) => {
    const { account } = requireAuth(request)
    const issue = await load(account.orgId, (request.params as { id: string }).id)
    const { path } = parseBody(previewOpenInput, request.body)
    return openPreview(deps, issue, account.id, path)
  })

  app.post('/api/issues/:id/preview/:action', async (request, reply) => {
    const { account } = requireAuth(request)
    const params = request.params as { id: string; action: string }
    const action = ACTIONS.find((candidate) => candidate === params.action)
    if (!action) throw notFound('Preview action')
    const issue = await load(account.orgId, params.id)
    await requestPreview(deps, issue, action, { kind: 'human', accountId: account.id })
    return reply.status(202).send({ preview: await previewDto(deps, issue) })
  })

  app.get('/api/issues/:id/preview/logs', async (request, reply) => {
    const { account } = requireAuth(request)
    const issue = await load(account.orgId, (request.params as { id: string }).id)
    const row = await previewOf(db, issue.id)
    if (!row) throw notFound('Preview')
    let lastSent = Number(request.headers['last-event-id'] ?? 0) || 0
    const sse = openSse(request, reply)

    const send = (entries: PreviewLogDto[]) => {
      const fresh = entries.filter((entry) => entry.seq === 0 || entry.seq > lastSent)
      if (fresh.length === 0) return
      lastSent = Math.max(lastSent, ...fresh.map((entry) => entry.seq))
      sse.send(JSON.stringify(fresh), lastSent || undefined)
    }
    // Subscribe before reading the backlog, so nothing falls in the gap. Sequence numbers drop the overlap.
    const queued: PreviewLogDto[][] = []
    let replayed = false
    const receive = (entries: PreviewLogDto[]) => (replayed ? send(entries) : queued.push(entries))
    const unsubscribeLogs = await fanout.subscribe(previewKeys.logChannel(row.slug), (raw) => receive(JSON.parse(raw) as PreviewLogDto[]))
    const unsubscribeProxy = await fanout.subscribe(previewKeys.proxyChannel(row.slug), (raw) => {
      const denial = JSON.parse(raw) as { host?: string; reason?: string }
      const text = `Blocked a request to ${denial.host ?? 'a host'}${denial.reason ? `: ${denial.reason}` : ''}. Add the host under the project's network settings if the preview needs it.`
      receive([{ seq: 0, ts: Date.now(), service: 'egress-proxy', text, error: true }])
    })
    sse.onClose(() => {
      unsubscribeLogs()
      unsubscribeProxy()
    })
    const backlog = (await redis.lrange(previewKeys.logs(row.slug), 0, -1)).map((raw) => JSON.parse(raw) as PreviewLogDto)
    send(backlog)
    replayed = true
    for (const entries of queued) send(entries)
  })
}
