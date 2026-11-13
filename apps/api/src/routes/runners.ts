import type { RunnerRow } from '@factorix/db'
import { isTunnelFrame } from '@factorix/runtime'
import type { RunnerFrame } from '@factorix/sandbox'
import { createRunnerInput, type RunnerDto } from '@factorix/schemas'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppDeps } from '../deps'
import { writeAudit } from '../lib/audit'
import { requireAdmin, requireAuth } from '../lib/auth'
import { proxyTokenKey, runProxyChannel } from '../lib/channels'
import { randomToken, sha256 } from '../lib/crypto'
import { conflict, HttpError, isUniqueViolation, notFound, parseBody } from '../lib/errors'
import { isRunnerOnline, RUNNER_PRESENCE_SECONDS, RUNNER_TOKEN_PREFIX, runnerKeys } from '../services/runner-link'
import { openSse } from '../sse'

const POP_SECONDS = 5
const SEEN_EVERY_MS = 60_000
/** A step can return 16 MB of output, and a batch can carry several. */
const FRAME_BODY_LIMIT = 64 * 1024 * 1024

export function runnerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, redis } = deps

  const dto = async (row: RunnerRow, projectCount: number): Promise<RunnerDto> => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    online: await isRunnerOnline(redis, row.id),
    lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null,
    projectCount,
    createdAt: new Date(row.createdAt).toISOString(),
  })

  app.get('/api/runners', async (request) => {
    const { account } = requireAuth(request)
    const rows = await db<RunnerRow>('runners').where({ orgId: account.orgId }).orderBy('created_at')
    const counts = (await db('projects')
      .where({ orgId: account.orgId })
      .whereNotNull('runner_id')
      .groupBy('runner_id')
      .select('runner_id')
      .count('* as count')) as {
      runnerId: string
      count: string
    }[]
    const byRunner = new Map(counts.map((row) => [row.runnerId, Number(row.count)]))
    return { runners: await Promise.all(rows.map((row) => dto(row, byRunner.get(row.id) ?? 0))) }
  })

  app.post('/api/runners', async (request) => {
    const { account } = requireAdmin(request)
    const input = parseBody(createRunnerInput, request.body)
    const secret = `${RUNNER_TOKEN_PREFIX}${randomToken()}`
    try {
      const [row] = await db<RunnerRow>('runners')
        .insert({
          orgId: account.orgId,
          name: input.name,
          tokenHash: sha256(secret),
          prefix: secret.slice(0, RUNNER_TOKEN_PREFIX.length + 4),
          createdBy: account.id,
        })
        .returning('*')
      await writeAudit(db, {
        orgId: account.orgId,
        actorAccountId: account.id,
        actorKind: 'human',
        action: 'runner.created',
        targetType: 'runner',
        targetId: row?.id,
        metadata: { name: input.name },
      })
      return { runner: await dto(row as RunnerRow, 0), secret }
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('A runner with that name already exists')
      throw error
    }
  })

  app.delete('/api/runners/:id', async (request) => {
    const { account } = requireAdmin(request)
    const [row] = await db<RunnerRow>('runners')
      .where({ id: (request.params as { id: string }).id, orgId: account.orgId })
      .delete()
      .returning('*')
    if (!row) throw notFound('Runner')
    await redis.del(runnerKeys.down(row.id), runnerKeys.online(row.id))
    await writeAudit(db, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'runner.removed',
      targetType: 'runner',
      targetId: row.id,
      metadata: { name: row.name },
    })
    return { ok: true }
  })

  const requireRunner = async (request: FastifyRequest): Promise<RunnerRow> => {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1]
    const row = bearer?.startsWith(RUNNER_TOKEN_PREFIX)
      ? await db<RunnerRow>('runners')
          .where({ tokenHash: sha256(bearer) })
          .first()
      : undefined
    if (!row) throw new HttpError(401, 'unauthenticated', 'This runner token is not valid')
    return row
  }

  /** What workers send the runner. One stream per runner: a newer one takes over and this one ends. */
  app.get('/api/runner/stream', async (request, reply) => {
    const runner = await requireRunner(request)
    const session = randomToken(8)
    const presence = runnerKeys.online(runner.id)
    const queue = runnerKeys.down(runner.id)
    const blocking = redis.duplicate({ maxRetriesPerRequest: null })
    const sse = openSse(request, reply)
    let open = true
    sse.onClose(() => {
      open = false
      blocking.disconnect()
    })
    await redis.set(presence, session, 'EX', RUNNER_PRESENCE_SECONDS)
    await db('runners').where({ id: runner.id }).update({ lastSeenAt: db.fn.now() })
    let seenAt = Date.now()
    void (async () => {
      try {
        while (open) {
          const popped = await blocking.blpop(queue, POP_SECONDS)
          if (!open || (await redis.get(presence)) !== session) {
            if (popped) await redis.lpush(queue, popped[1])
            break
          }
          await redis.expire(presence, RUNNER_PRESENCE_SECONDS)
          if (popped) {
            const frame = JSON.parse(popped[1]) as RunnerFrame
            if (frame.t !== 'call' || frame.exp > Date.now()) sse.send(popped[1])
          }
          if (Date.now() - seenAt > SEEN_EVERY_MS) {
            seenAt = Date.now()
            await db('runners').where({ id: runner.id }).update({ lastSeenAt: db.fn.now() })
          }
        }
      } catch {
        // The connection used for popping closes with the stream.
      } finally {
        if ((await redis.get(presence).catch(() => null)) === session) await redis.del(presence).catch(() => undefined)
        if (open) reply.raw.end()
      }
    })()
  })

  app.post('/api/runner/frames', { bodyLimit: FRAME_BODY_LIMIT }, async (request) => {
    const runner = await requireRunner(request)
    const { frames } = (request.body ?? {}) as { frames?: RunnerFrame[] }
    for (const frame of Array.isArray(frames) ? frames : []) {
      const channel = isTunnelFrame(frame) ? runnerKeys.tunnel(runner.id) : runnerKeys.up(runner.id)
      await redis.publish(channel, JSON.stringify(frame))
    }
    return { ok: true }
  })

  /** The runner's egress proxy has no Redis of ours, so it asks here what a run token allows. */
  app.post('/api/runner/grant', async (request) => {
    await requireRunner(request)
    const { token } = (request.body ?? {}) as { token?: string }
    const raw = typeof token === 'string' && token ? await redis.get(proxyTokenKey(token)) : null
    return { grant: raw ? JSON.parse(raw) : null }
  })

  app.post('/api/runner/denied', async (request) => {
    await requireRunner(request)
    const { token, host, reason } = (request.body ?? {}) as { token?: string; host?: string; reason?: string }
    const raw = typeof token === 'string' && token ? await redis.get(proxyTokenKey(token)) : null
    if (!raw) return { ok: true }
    const grant = JSON.parse(raw) as { runId?: string; channel?: string }
    const channel = grant.channel ?? (grant.runId ? runProxyChannel(grant.runId) : null)
    if (channel) await redis.publish(channel, JSON.stringify({ host: String(host ?? ''), reason: String(reason ?? '') }))
    return { ok: true }
  })
}
