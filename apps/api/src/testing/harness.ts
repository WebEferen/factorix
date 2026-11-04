import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createTestDatabase, type TestDatabase } from '@factorix/db/testing'
import type { dockerClientFromEnv } from '@factorix/sandbox'
import type { FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import { buildApp } from '../app'
import type { AppDeps } from '../deps'
import { loadEnv } from '../env'
import { createSecretBox } from '../lib/crypto'
import { createQueues } from '../queues'
import { FakeWorld } from './fakes'

export interface Harness {
  world: FakeWorld
  deps: AppDeps
  database: TestDatabase
  app: FastifyInstance
  prefix: string
  destroy(): Promise<void>
}

export async function createHarness(urls: { databaseUrl: string; redisUrl: string }, overrides: Partial<AppDeps> = {}): Promise<Harness> {
  const database = await createTestDatabase(urls.databaseUrl)
  const redis = new Redis(urls.redisUrl, { maxRetriesPerRequest: null })
  const prefix = `fxtest-${randomUUID().slice(0, 8)}`
  const queues = createQueues(redis, prefix)
  const world = new FakeWorld()
  const env = loadEnv({
    FACTORIX_SECRET_KEY: randomBytes(32).toString('base64'),
    FACTORIX_ALLOW_SCRIPTED_RUNTIME: 'true',
    FACTORIX_PUBLIC_URL: 'http://localhost:4101',
    DATABASE_URL: database.url,
    REDIS_URL: urls.redisUrl,
  })
  const deps: AppDeps = {
    db: database.db,
    redis,
    env,
    secrets: createSecretBox(env.FACTORIX_SECRET_KEY),
    connectors: world.factory(),
    queues,
    ...overrides,
  }
  const app = buildApp(deps)
  await app.ready()
  return {
    world,
    deps,
    database,
    app,
    prefix,
    async destroy() {
      await app.close()
      await queues.close()
      redis.disconnect()
      await database.destroy()
    },
  }
}

/** Docker is shared with a live factory that uses the same labels, so this removes only what this harness's own database knows about. */
export async function removeOwnSandboxes(harness: Harness, docker: ReturnType<typeof dockerClientFromEnv>): Promise<void> {
  const managed = await harness.deps.sandbox?.listManaged()
  if (!managed) return
  const own = new Set<string>([...(await harness.deps.db('runs').pluck('id')), ...(await harness.deps.db('issues').pluck('id'))])
  for (const container of managed.containers) {
    if (own.has(container.runId ?? '') || own.has(container.issueKey ?? '')) await harness.deps.sandbox?.remove(container.id).catch(() => undefined)
  }
  for (const volume of managed.volumes) {
    if (own.has(volume.workspaceKey))
      await docker
        .getVolume(volume.name)
        .remove({ force: true })
        .catch(() => undefined)
  }
}

export class ApiClient {
  cookie = ''

  constructor(private readonly app: FastifyInstance) {}

  async request<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
  ): Promise<{ status: number; body: T; cookies: { name: string; value: string; httpOnly?: boolean }[] }> {
    const response = await this.app.inject({ method, url, payload: body as never, headers: this.cookie ? { cookie: this.cookie } : {} })
    const session = response.cookies.find((cookie) => cookie.name === 'fx_session')
    if (session?.value) this.cookie = `fx_session=${session.value}`
    return {
      status: response.statusCode,
      body: response.body ? (JSON.parse(response.body) as T) : (undefined as T),
      cookies: response.cookies as never,
    }
  }

  async ok<T = any>(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<T> {
    const response = await this.request<T>(method, url, body)
    if (response.status >= 300) throw new Error(`${method} ${url} returned ${response.status}: ${JSON.stringify(response.body)}`)
    return response.body
  }
}

export async function sendLinearWebhook(
  app: FastifyInstance,
  connectionId: string,
  secret: string,
  payload: Record<string, unknown>,
  deliveryId: string = randomUUID(),
) {
  const body = JSON.stringify({ webhookTimestamp: Date.now(), ...payload })
  return app.inject({
    method: 'POST',
    url: `/webhooks/linear/${connectionId}`,
    payload: body,
    headers: {
      'content-type': 'application/json',
      'linear-signature': createHmac('sha256', secret).update(body).digest('hex'),
      'linear-delivery': deliveryId,
    },
  })
}

export async function sendGitlabWebhook(
  app: FastifyInstance,
  connectionId: string,
  secret: string,
  event: string,
  payload: Record<string, unknown>,
  deliveryId: string = randomUUID(),
) {
  return app.inject({
    method: 'POST',
    url: `/webhooks/gitlab/${connectionId}`,
    payload: JSON.stringify(payload),
    headers: { 'content-type': 'application/json', 'x-gitlab-token': secret, 'x-gitlab-event': event, 'x-gitlab-event-uuid': deliveryId },
  })
}

export function issuePayload(
  issue: {
    id: string
    identifier: string
    title: string
    description: string | null
    url: string | null
    priority: number
    teamId: string
    projectId: string | null
    stateId: string
    stateName: string
    stateType: string
    labels: { id: string; name: string; parentId: string | null }[]
    updatedAt: string
  },
  action = 'update',
) {
  return {
    type: 'Issue',
    action,
    data: { ...issue, state: { id: issue.stateId, name: issue.stateName, type: issue.stateType } },
  }
}

export async function waitFor<T>(check: () => Promise<T | false | null | undefined>, description: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${description}${last ? `: ${String(last)}` : ''}`)
}
