import {
  type ConnectionRow,
  type EnvironmentInstanceRow,
  type EnvironmentServiceStatus,
  type IssueRow,
  json,
  type ProjectRepoRow,
  type ProjectRow,
  type WorkspaceRow,
} from '@factorix/db'
import { type Environment, type SandboxProvider, serviceContainerName, type Workspace } from '@factorix/sandbox'
import { type EnvironmentDefinition, maskSecrets, type PreviewLogDto, startOrder } from '@factorix/schemas'
import type { Redis } from 'ioredis'
import type { AppDeps } from '../deps'
import { previewKeys, proxyTokenKey } from '../lib/channels'
import { randomToken } from '../lib/crypto'
import { type EnvironmentAction, emit } from '../lib/outbox'
import { scmFor } from './connections'
import { restrictedHosts } from './egress'
import { Aborted, environmentProxyEnv, PREVIEW_DOMAIN, ServiceNotReady, waitUntilReady } from './environment-runtime'
import { resolveSecretSets } from './environments'
import { previewAddress, readySeconds, reposUsed, serviceSpec, templateValues } from './preview-spec'
import { LIVE_STATES, requestPreview } from './previews'
import { projectRepos } from './repos'
import { readSettings } from './settings'
import { resolveBranch } from './workspace'

export interface PreviewRunnerDeps extends AppDeps {
  sandbox: SandboxProvider
  owner: string
}

export const GATEWAY_ALIAS = 'factorix-gateway'
const LOG_LIMIT = 2000
const LOG_TTL_SECONDS = 7 * 86_400
const LOCK_MS = 60_000
const LOCK_WAIT_MS = 30 * 60_000
const PUMP_TTL_SECONDS = 90
const STUCK_MS = 60_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Buffers log lines briefly so a chatty dev server costs a few Redis round trips a second, not one per line. */
class LogWriter {
  private pending: PreviewLogDto[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly redis: Redis,
    private readonly slug: string,
    private readonly secrets: () => string[],
  ) {}

  add(service: string, text: string, error = false, ts = Date.now()): void {
    this.pending.push({ seq: 0, ts, service, text: maskSecrets(text, this.secrets()), ...(error ? { error: true } : {}) })
    if (!this.timer) this.timer = setTimeout(() => void this.flush().catch(() => undefined), 200)
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const batch = this.pending.splice(0)
    if (batch.length === 0) return
    const key = previewKeys.logs(this.slug)
    const last = await this.redis.incrby(previewKeys.logSeq(this.slug), batch.length)
    batch.forEach((entry, index) => {
      entry.seq = last - batch.length + index + 1
    })
    await this.redis
      .multi()
      .rpush(key, ...batch.map((entry) => JSON.stringify(entry)))
      .ltrim(key, -LOG_LIMIT, -1)
      .expire(key, LOG_TTL_SECONDS)
      .expire(previewKeys.logSeq(this.slug), LOG_TTL_SECONDS)
      .publish(previewKeys.logChannel(this.slug), JSON.stringify(batch))
      .exec()
  }
}

const pumps = new Map<string, AbortController>()
/** Secret values per preview, kept only in this process, so its logs can be masked. */
const masks = new Map<string, string[]>()
const writers = new Map<string, LogWriter>()

function writerFor(redis: Redis, row: EnvironmentInstanceRow): LogWriter {
  let writer = writers.get(row.slug)
  if (!writer) {
    writer = new LogWriter(redis, row.slug, () => masks.get(row.id) ?? [])
    writers.set(row.slug, writer)
  }
  return writer
}

function pump(deps: PreviewRunnerDeps, row: EnvironmentInstanceRow, service: string, containerId: string, since?: number): void {
  if (pumps.has(containerId)) return
  const controller = new AbortController()
  pumps.set(containerId, controller)
  void deps.redis.set(previewKeys.pump(containerId), deps.owner, 'EX', PUMP_TTL_SECONDS).catch(() => undefined)
  const log = writerFor(deps.redis, row)
  void deps.sandbox
    .followLogs(containerId, { since, signal: controller.signal }, (line) => log.add(service, line.text, line.stream === 'stderr', line.ts))
    .catch(() => undefined)
    .finally(() => {
      if (pumps.get(containerId) === controller) pumps.delete(containerId)
      void log.flush().catch(() => undefined)
    })
}

function stopPumps(row: EnvironmentInstanceRow, services?: string[]): void {
  for (const [name, status] of Object.entries(row.services)) {
    if (services && !services.includes(name)) continue
    if (!status.containerId) continue
    pumps.get(status.containerId)?.abort()
    pumps.delete(status.containerId)
  }
}

export function stopAllPumps(): void {
  for (const controller of pumps.values()) controller.abort()
  pumps.clear()
}

async function withLock(redis: Redis, instanceId: string, work: () => Promise<void>): Promise<void> {
  const key = previewKeys.lock(instanceId)
  const token = randomToken(12)
  const deadline = Date.now() + LOCK_WAIT_MS
  while (!(await redis.set(key, token, 'PX', LOCK_MS, 'NX'))) {
    if (Date.now() > deadline) throw new Error('Another job has held this preview for too long')
    await sleep(500)
  }
  const renew = setInterval(() => void redis.pexpire(key, LOCK_MS).catch(() => undefined), LOCK_MS / 3)
  try {
    await work()
  } finally {
    clearInterval(renew)
    if ((await redis.get(key)) === token) await redis.del(key)
  }
}

const EXPECTED: Record<EnvironmentAction, EnvironmentInstanceRow['state']> = {
  start: 'starting',
  reset: 'starting',
  refresh: 'refreshing',
  stop: 'stopping',
}

/** One job at a time per preview. A job whose state moved on, such as a start that was stopped, does nothing. */
export async function runPreviewAction(deps: PreviewRunnerDeps, instanceId: string, action: EnvironmentAction): Promise<void> {
  await withLock(deps.redis, instanceId, async () => {
    const row = await deps.db<EnvironmentInstanceRow>('environment_instances').where({ id: instanceId }).first()
    if (!row || row.state !== EXPECTED[action]) return
    const run = new PreviewRun(deps, row)
    if (action === 'stop') await run.stop()
    else if (action === 'refresh') await run.refresh()
    else await run.start(action === 'reset')
  })
}

interface Context {
  issue: IssueRow
  project: ProjectRow
  repos: ProjectRepoRow[]
}

class PreviewRun {
  private readonly definition: EnvironmentDefinition
  private readonly log: LogWriter
  private environment: Environment | null = null

  constructor(
    private readonly deps: PreviewRunnerDeps,
    private row: EnvironmentInstanceRow,
  ) {
    this.definition = row.definition as EnvironmentDefinition
    this.log = writerFor(deps.redis, row)
  }

  async start(wipeData: boolean): Promise<void> {
    const { sandbox } = this.deps
    try {
      this.log.add('factorix', wipeData ? 'Clearing data and starting the preview.' : 'Starting the preview.')
      stopPumps(this.row)
      // Whatever an earlier start left behind goes, so a crashed start can simply run again.
      await sandbox.stopEnvironment(this.row.slug)
      if (wipeData) await sandbox.removeEnvironmentVolumes(this.row.slug, { source: false })
      const context = await this.context()
      this.environment = await this.ensureEnvironment()
      await this.copyCode(context)
      await this.stillWanted('starting')
      await this.launch(context, Object.keys(this.definition.services), 'starting')
    } catch (error) {
      await this.handleFailure(error)
    } finally {
      await this.log.flush().catch(() => undefined)
    }
  }

  /** New code, then the services that run it start again. Images keep running, and so does their data. */
  async refresh(): Promise<void> {
    const { sandbox } = this.deps
    const repoServices = Object.entries(this.definition.services)
      .filter(([, entry]) => entry.repo)
      .map(([name]) => name)
    try {
      this.log.add('factorix', 'Refreshing the code.')
      const context = await this.context()
      this.environment = await this.ensureEnvironment()
      stopPumps(this.row, repoServices)
      await sandbox.stopEnvironment(this.row.slug, repoServices)
      for (const name of repoServices) await this.setService(name, { state: 'waiting' })
      await this.copyCode(context)
      await this.stillWanted('refreshing')
      await this.launch(context, repoServices, 'refreshing')
    } catch (error) {
      await this.handleFailure(error)
    } finally {
      await this.log.flush().catch(() => undefined)
    }
  }

  async stop(): Promise<void> {
    await this.teardown()
    await this.deps.db.transaction(async (trx) => {
      const services = Object.fromEntries(Object.keys(this.row.services).map((name) => [name, { state: 'stopped' }]))
      await trx('environment_instances')
        .where({ id: this.row.id })
        .update({ state: 'stopped', stoppedAt: trx.fn.now(), services: json(services), updatedAt: trx.fn.now() })
      await this.notify(trx)
    })
    this.log.add('factorix', 'Stopped.')
    await this.log.flush().catch(() => undefined)
    writers.delete(this.row.slug)
  }

  private async teardown(): Promise<void> {
    const { redis, sandbox } = this.deps
    stopPumps(this.row)
    await sandbox.stopEnvironment(this.row.slug)
    const token = await redis.get(previewKeys.grant(this.row.slug))
    await redis.del(previewKeys.route(this.row.slug), previewKeys.grant(this.row.slug), ...(token ? [proxyTokenKey(token)] : []))
    masks.delete(this.row.id)
  }

  private async handleFailure(error: unknown): Promise<void> {
    if (error instanceof Aborted) {
      this.log.add('factorix', 'Stopped before it was ready.')
      return
    }
    const message = (error as Error).message
    this.log.add('factorix', message, true)
    await this.teardown().catch(() => undefined)
    await this.deps.db.transaction(async (trx) => {
      const updated = await trx('environment_instances')
        .where({ id: this.row.id })
        .whereIn('state', ['starting', 'refreshing'])
        .update({ state: 'failed', error: message.slice(0, 2000), stoppedAt: trx.fn.now(), updatedAt: trx.fn.now() })
      if (updated) await this.notify(trx)
    })
  }

  private async notify(trx: Parameters<typeof emit>[0]): Promise<void> {
    if (this.row.issueId) await emit(trx, this.row.orgId, { type: 'notify', kind: 'issue', id: this.row.issueId, projectId: this.row.projectId })
  }

  private async stillWanted(expected: EnvironmentInstanceRow['state']): Promise<void> {
    const current = await this.deps.db<EnvironmentInstanceRow>('environment_instances').where({ id: this.row.id }).first('state')
    if (current?.state !== expected) throw new Aborted()
  }

  private async context(): Promise<Context> {
    const { db } = this.deps
    const issue = await db<IssueRow>('issues')
      .where({ id: this.row.issueId as string })
      .first()
    const project = await db<ProjectRow>('projects').where({ id: this.row.projectId }).first()
    if (!issue || !project) throw new Error('The issue or its project no longer exists.')
    return { issue, project, repos: await projectRepos(db, project.id) }
  }

  private async ensureEnvironment(): Promise<Environment> {
    return this.deps.sandbox.ensureEnvironment(this.row.slug, {
      internal: Boolean(this.deps.env.FACTORIX_PROXY_URL),
      labels: { 'factorix.issue': this.row.issueId ?? '', 'factorix.instance': this.row.id },
    })
  }

  /** Fetching holds the git token and never touches preview files. The copy runs without it, and without network. */
  private async copyCode({ issue, project, repos }: Context): Promise<void> {
    const { db, sandbox } = this.deps
    const workspace = await sandbox.ensureWorkspace(issue.id)
    await this.touchWorkspace(issue, workspace)
    const connection = project.scmConnectionId ? await db<ConnectionRow>('connections').where({ id: project.scmConnectionId }).first() : undefined
    const gitToken = connection ? scmFor(this.deps, connection).gitAuth().token : undefined
    const source: Workspace = { key: issue.id, volume: (this.environment as Environment).sourceVolume, mirrorVolume: workspace.mirrorVolume }
    const branch = resolveBranch(issue)
    const commits: EnvironmentInstanceRow['commits'] = {}
    for (const name of reposUsed(this.definition)) {
      const repo = repos.find((candidate) => candidate.name === name)
      if (!repo) throw new Error(`The project has no repository named ${name} any more.`)
      const env = { FX_REPO_NAME: name, FX_REPO_URL: repo.scmCloneUrl, FX_BRANCH: branch, FX_BASE_BRANCH: repo.defaultBranch }
      this.log.add('factorix', `Fetching ${name}.`)
      const labels = { 'factorix.env': this.row.slug }
      const fetched = await sandbox.runStep(workspace, { op: 'mirror-fetch', env, gitToken, timeoutSeconds: 900, labels })
      if (fetched.exitCode !== 0) throw new Error(`Fetching ${name} failed: ${fetched.stderr.trim().slice(-500) || `exit code ${fetched.exitCode}`}`)
      const worktree = this.row.source === 'worktree'
      const exported = await sandbox.runStep(source, {
        op: 'export',
        env: worktree ? { ...env, FX_SOURCE: 'worktree' } : env,
        sourceVolume: worktree ? workspace.volume : undefined,
        timeoutSeconds: 900,
        labels,
      })
      if (exported.exitCode !== 0)
        throw new Error(`Copying ${name} into the preview failed: ${exported.stderr.trim().slice(-500) || `exit code ${exported.exitCode}`}`)
      commits[name] = { ref: exported.values.REF ?? '', sha: exported.values.HEAD ?? '' }
      this.log.add('factorix', `${name} is at ${commits[name].ref} (${commits[name].sha.slice(0, 8)}).`)
    }
    await db('environment_instances')
      .where({ id: this.row.id })
      .update({ commits: json(commits), updatedAt: db.fn.now() })
    this.row.commits = commits
  }

  /** The preview shares the issue's mirror, so the issue's workspace row keeps it from being cleaned up as unused. */
  private async touchWorkspace(issue: IssueRow, workspace: Workspace): Promise<void> {
    const { db } = this.deps
    const existing = await db<WorkspaceRow>('workspaces').where({ issueId: issue.id }).first()
    if (existing) {
      await db('workspaces')
        .where({ id: existing.id })
        .update({ lastUsedAt: db.fn.now(), ...(existing.state === 'expired' ? { state: 'ready' } : {}) })
      return
    }
    await db('workspaces')
      .insert({ orgId: issue.orgId, issueId: issue.id, volumeName: workspace.volume, mirrorVolumeName: workspace.mirrorVolume, state: 'ready' })
      .onConflict('issue_id')
      .ignore()
  }

  private async launch(context: Context, names: string[], expected: 'starting' | 'refreshing'): Promise<void> {
    const environment = this.environment as Environment
    const secrets = await this.secrets()
    const platformEnv = await this.platformEnv(context.project)
    const joined = await this.deps.sandbox.joinEnvironment(environment, 'gateway', GATEWAY_ALIAS)
    if (!joined)
      this.log.add(
        'factorix',
        environment.runner
          ? 'This runner has no preview tunnel, so nobody can open this preview. Update the runner with docker compose -f docker-compose.runner.yml up -d --build.'
          : 'No preview gateway is running, so nobody can open this preview. Start the preview-gateway service.',
        true,
      )
    await this.writeRoute('starting')
    const address = previewAddress(this.deps.env.FACTORIX_PREVIEW_URL, this.row.slug)
    const serviceContext = {
      environment,
      values: templateValues(
        this.definition,
        address,
        context.repos.map((repo) => repo.name),
      ),
      secrets,
      platformEnv,
      dataGeneration: this.row.dataGeneration,
      labels: { 'factorix.issue': this.row.issueId ?? '', 'factorix.instance': this.row.id },
    }
    for (const wave of startOrder(this.definition, names)) {
      const controller = new AbortController()
      const results = await Promise.allSettled(
        wave.map((name) =>
          this.startService(
            name,
            { ...serviceSpec(this.definition, name, serviceContext), aliases: [`${name}.${PREVIEW_DOMAIN}`] },
            controller.signal,
            expected,
          ).catch((error) => {
            controller.abort()
            throw error
          }),
        ),
      )
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected' && !(result.reason instanceof Aborted))
      if (failed) throw failed.reason
      if (results.some((result) => result.status === 'rejected')) throw new Aborted()
    }
    await this.writeRoute('ready')
    await this.deps.db.transaction(async (trx) => {
      const updated = await trx('environment_instances')
        .where({ id: this.row.id, state: expected })
        .update({ state: 'ready', readyAt: trx.fn.now(), error: null, updatedAt: trx.fn.now() })
      if (!updated) throw new Aborted()
      await this.notify(trx)
    })
    this.log.add('factorix', `Ready at ${address.url}.`)
  }

  private async startService(
    name: string,
    spec: ReturnType<typeof serviceSpec>,
    signal: AbortSignal,
    expected: 'starting' | 'refreshing',
  ): Promise<void> {
    const { sandbox } = this.deps
    await this.setService(name, { state: 'starting' })
    this.log.add('factorix', `Starting ${name}.`)
    let containerId: string
    try {
      containerId = await sandbox.startService(this.environment as Environment, spec)
    } catch (error) {
      await this.setService(name, { state: 'failed', message: 'Could not start' })
      throw new Error(`${name} could not start: ${(error as Error).message}`)
    }
    await this.setService(name, { state: 'starting', containerId })
    pump(this.deps, this.row, name, containerId)
    try {
      await waitUntilReady(sandbox, containerId, {
        name,
        timeoutSeconds: readySeconds(this.definition, name),
        signal,
        everyFewPolls: () => this.stillWanted(expected),
      })
    } catch (error) {
      if (error instanceof ServiceNotReady) await this.setService(name, { state: 'failed', containerId, message: error.message })
      throw error
    }
    await this.setService(name, { state: 'ready', containerId })
    this.log.add('factorix', `${name} is ready.`)
  }

  private async setService(name: string, status: EnvironmentServiceStatus): Promise<void> {
    this.row.services = { ...this.row.services, [name]: status }
    await this.deps.db.transaction(async (trx) => {
      await trx('environment_instances')
        .where({ id: this.row.id })
        .update({ services: trx.raw('services || jsonb_build_object(?::text, ?::jsonb)', [name, JSON.stringify(status)]), updatedAt: trx.fn.now() })
      await this.notify(trx)
    })
  }

  private async secrets(): Promise<Map<string, Record<string, string>>> {
    const used = new Set(Object.values(this.definition.services).flatMap((entry) => entry.secrets))
    const sets = this.row.secretSets.filter((set) => used.has(set.name))
    const resolved = await resolveSecretSets(this.deps, this.row.orgId, sets)
    masks.set(
      this.row.id,
      [...resolved.values()].flatMap((values) => Object.values(values)),
    )
    return resolved
  }

  /** The project's network policy, enforced by the egress proxy as it is for agent runs. Nothing here holds a model key. */
  private async platformEnv(project: ProjectRow): Promise<Record<string, string>> {
    const policy = project.networkPolicy ?? 'restricted'
    const allow =
      policy === 'open'
        ? ['*']
        : policy === 'none'
          ? []
          : await restrictedHosts(
              this.deps.db,
              this.row.orgId,
              project,
              [project.trackerConnectionId, project.scmConnectionId].filter((id): id is string => Boolean(id)),
            )
    const ttl = Math.max(3600, Math.ceil(((this.row.expiresAt?.getTime() ?? Date.now()) - Date.now()) / 1000) + 3600)
    return environmentProxyEnv(this.deps, {
      environment: this.environment as Environment,
      services: Object.keys(this.definition.services),
      bypass: project.networkBypass,
      grant: { channel: previewKeys.proxyChannel(this.row.slug) },
      allow,
      ttlSeconds: ttl,
    })
  }

  private async writeRoute(state: 'starting' | 'ready'): Promise<void> {
    const { redis, env } = this.deps
    const expose = this.definition.expose
    if (!expose) return
    const settings = await readSettings(this.deps)
    const target = (service: string, port?: number) => ({
      host: serviceContainerName(this.row.slug, service),
      runner: this.environment?.runner,
      port: port ?? (this.definition.services[service]?.port as number),
    })
    const route = {
      instanceId: this.row.id,
      state,
      upstream: target(expose.service, expose.port),
      paths: expose.paths.map((rule) => ({ prefix: rule.prefix, strip: rule.strip ?? false, ...target(rule.service, rule.port) })),
      frameAncestors: [...new Set([settings.publicUrl, env.FACTORIX_PUBLIC_URL].map((url) => new URL(url).origin))],
      issueUrl: this.row.issueId ? new URL(`/issues/${this.row.issueId}`, settings.publicUrl).toString() : null,
    }
    const ttl = Math.max(3600, Math.ceil(((this.row.expiresAt?.getTime() ?? Date.now()) - Date.now()) / 1000) + 3600)
    await redis.set(previewKeys.route(this.row.slug), JSON.stringify(route), 'EX', ttl)
  }
}

/** Takes over log streaming for services whose pump died with another worker. */
async function adoptPumps(deps: PreviewRunnerDeps, row: EnvironmentInstanceRow): Promise<void> {
  const orphans = Object.entries(row.services).filter(([, status]) => status.containerId && !pumps.has(status.containerId))
  if (orphans.length === 0) return
  if (!masks.has(row.id)) {
    const used = new Set(Object.values((row.definition as EnvironmentDefinition).services).flatMap((entry) => entry.secrets))
    try {
      const resolved = await resolveSecretSets(
        deps,
        row.orgId,
        row.secretSets.filter((set) => used.has(set.name)),
      )
      masks.set(
        row.id,
        [...resolved.values()].flatMap((values) => Object.values(values)),
      )
    } catch {
      return
    }
  }
  for (const [name, status] of orphans) {
    const containerId = status.containerId as string
    if (!(await deps.redis.set(previewKeys.pump(containerId), deps.owner, 'EX', PUMP_TTL_SECONDS, 'NX'))) continue
    pump(deps, row, name, containerId, Math.floor(Date.now() / 1000))
  }
}

const RECOVER_ACTION: Partial<Record<EnvironmentInstanceRow['state'], EnvironmentAction>> = {
  starting: 'start',
  refreshing: 'refresh',
  stopping: 'stop',
}

/** Stops idle and expired previews, picks up jobs a dead worker left, and keeps log streams alive. */
export async function sweepPreviews(deps: PreviewRunnerDeps): Promise<void> {
  const { db, redis } = deps
  for (const containerId of pumps.keys()) await redis.expire(previewKeys.pump(containerId), PUMP_TTL_SECONDS)
  const settings = await readSettings(deps)
  const rows = await db<EnvironmentInstanceRow>('environment_instances').where({ kind: 'preview' }).whereIn('state', LIVE_STATES)
  const now = Date.now()
  for (const row of rows) {
    if (row.state !== 'ready') {
      const action = RECOVER_ACTION[row.state]
      if (action && now - row.updatedAt.getTime() > STUCK_MS && !(await redis.exists(previewKeys.lock(row.id)))) {
        await deps.queues.environments.add(action, { instanceId: row.id, action }, { jobId: `recover-${row.id}-${Math.floor(now / STUCK_MS)}` })
      }
      continue
    }
    const seen = Number(await redis.get(previewKeys.seen(row.slug))) || 0
    if (seen > (row.lastSeenAt?.getTime() ?? 0) + 30_000)
      await db('environment_instances')
        .where({ id: row.id })
        .update({ lastSeenAt: new Date(seen) })
    const lastActive = Math.max(seen, row.readyAt?.getTime() ?? 0)
    const expired = row.expiresAt !== null && row.expiresAt.getTime() <= now
    const idle = settings.previewIdleMinutes > 0 && now - lastActive > settings.previewIdleMinutes * 60_000
    if (expired || idle) {
      const issue = await db<IssueRow>('issues')
        .where({ id: row.issueId as string })
        .first()
      if (!issue) continue
      const reason = expired ? `Ran for its ${settings.previewMaxHours} hour limit.` : `Nobody opened it for ${settings.previewIdleMinutes} minutes.`
      try {
        await requestPreview(deps, issue, 'stop', { kind: 'system', reason })
        writerFor(redis, row).add('factorix', `Stopping: ${reason}`)
      } catch {}
      continue
    }
    await adoptPumps(deps, row)
  }
  for (const writer of writers.values()) await writer.flush().catch(() => undefined)
}
