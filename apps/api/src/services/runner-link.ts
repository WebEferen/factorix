import type { Db, RunnerRow } from '@factorix/db'
import { type FrameTransport, RemoteSandboxProvider, type RunnerFrame, type SandboxProvider, type SandboxRoutes } from '@factorix/sandbox'
import type { Redis } from 'ioredis'

export const RUNNER_TOKEN_PREFIX = 'fxr_'
/** A runner counts as online while its stream keeps renewing this. */
export const RUNNER_PRESENCE_SECONDS = 45
const DOWN_TTL_SECONDS = 3600
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Frames for a runner wait in a list its stream pops, so a short disconnect loses nothing. Frames from it are published to the workers. */
export const runnerKeys = {
  down: (runnerId: string) => `runner:${runnerId}:down`,
  up: (runnerId: string) => `runner:${runnerId}:up`,
  online: (runnerId: string) => `runner:${runnerId}:online`,
  /** Preview traffic coming back from a runner. Only the preview gateway listens, so it never sees what agents say. */
  tunnel: (runnerId: string) => `runner:${runnerId}:tun`,
}

export async function isRunnerOnline(redis: Redis, runnerId: string): Promise<boolean> {
  return (await redis.exists(runnerKeys.online(runnerId))) === 1
}

/** The worker's side of every runner: one remote provider each, and the rules for which machine holds what. */
export class RunnerLinks {
  private readonly subscriber: Redis
  private readonly listeners = new Map<string, Set<(frame: RunnerFrame) => void>>()
  private readonly providers = new Map<string, RemoteSandboxProvider>()

  constructor(private readonly deps: { db: Db; redis: Redis; stack?: string }) {
    this.subscriber = deps.redis.duplicate({ maxRetriesPerRequest: null })
    this.subscriber.on('message', (channel: string, message: string) => {
      const listeners = this.listeners.get(channel)
      if (!listeners) return
      const frame = JSON.parse(message) as RunnerFrame
      for (const listener of listeners) listener(frame)
    })
  }

  private transport(runnerId: string): FrameTransport {
    const { redis } = this.deps
    const channel = runnerKeys.up(runnerId)
    return {
      send: (frame) => {
        void redis
          .multi()
          .rpush(runnerKeys.down(runnerId), JSON.stringify(frame))
          .expire(runnerKeys.down(runnerId), DOWN_TTL_SECONDS)
          .exec()
          .catch(() => undefined)
      },
      onFrame: (listener) => {
        let set = this.listeners.get(channel)
        if (!set) {
          set = new Set()
          this.listeners.set(channel, set)
          void this.subscriber.subscribe(channel).catch(() => undefined)
        }
        set.add(listener)
        return () => set.delete(listener)
      },
    }
  }

  async provider(runnerId: string): Promise<SandboxProvider> {
    const existing = this.providers.get(runnerId)
    if (existing) return existing
    const row = await this.deps.db<RunnerRow>('runners').where({ id: runnerId }).first()
    if (!row) throw new Error('The runner this work belongs to was removed.')
    const provider = new RemoteSandboxProvider(this.transport(runnerId), {
      runnerId,
      name: row.name,
      stack: this.deps.stack,
      online: () => isRunnerOnline(this.deps.redis, runnerId),
    })
    this.providers.set(runnerId, provider)
    return provider
  }

  private async runnerOfWorkspace(key: string): Promise<string | null> {
    const { db } = this.deps
    const pinned = await db('workspace_runners').where({ workspaceKey: key }).first()
    if (pinned) return pinned.runnerId
    let runnerId: string | null = null
    if (UUID.test(key)) {
      // A workspace from before runners existed, or before its project moved to one, is on this machine.
      const local = await db('workspaces').where({ issueId: key }).whereNot({ state: 'expired' }).first()
      if (!local) {
        const project = await db('issues')
          .join('projects', 'issues.project_id', 'projects.id')
          .where({ 'issues.id': key })
          .first('projects.runner_id')
        runnerId = project?.runnerId ?? null
      }
    }
    await db('workspace_runners').insert({ workspaceKey: key, runnerId }).onConflict('workspace_key').ignore()
    return (await db('workspace_runners').where({ workspaceKey: key }).first())?.runnerId ?? null
  }

  routes(): SandboxRoutes {
    const { db, redis } = this.deps
    return {
      runnerOfWorkspace: (key) => this.runnerOfWorkspace(key),
      runnerOfEnvironment: async (key) => {
        const instance = await db('environment_instances').where({ slug: key }).first()
        if (!instance) return undefined
        const workspaceKey = instance.issueId ?? instance.runId
        if (workspaceKey) return this.runnerOfWorkspace(workspaceKey)
        return (await db('projects').where({ id: instance.projectId }).first('runner_id'))?.runnerId ?? null
      },
      provider: (runnerId) => this.provider(runnerId),
      onlineRunners: async () => {
        const ids = (await db('runners').pluck('id')) as string[]
        const online = await Promise.all(ids.map((id) => isRunnerOnline(redis, id)))
        return ids.filter((_, index) => online[index])
      },
      workspaceDestroyed: async (key) => {
        await db('workspace_runners').where({ workspaceKey: key }).delete()
      },
    }
  }

  close(): void {
    for (const provider of this.providers.values()) provider.close()
    this.providers.clear()
    this.subscriber.disconnect()
  }
}
