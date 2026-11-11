import { randomUUID } from 'node:crypto'
import type { ScmConnector } from '@factorix/connectors'
import { PHASES } from '@factorix/core'
import { type ConnectionRow, type IssueRow, json, type ProjectRow, type RunRow } from '@factorix/db'
import {
  decodeEvent,
  type ErrorCode,
  encodeLine,
  estimateCostUsd,
  type Phase,
  RUNTIME_CAPABILITIES,
  type RunCommand,
  type RunEvent,
  type RunOutcome,
  type RunSpec,
  type UsageSnapshot,
} from '@factorix/runtime'
import type { AgentHandle, SandboxProvider, StartAgentOptions, Workspace } from '@factorix/sandbox'
import { noProxyHost } from '@factorix/schemas'
import type { Redis } from 'ioredis'
import type { AppDeps } from '../deps'
import { writeAudit } from '../lib/audit'
import { orgChannel, proxyTokenKey, runCommandChannel, runProxyChannel } from '../lib/channels'
import { randomToken } from '../lib/crypto'
import { emit } from '../lib/outbox'
import { decryptConnection, resolveModelKey, scmConnectionFor, scmFor } from './connections'
import { restrictedHosts } from './egress'
import { PREVIEW_DOMAIN } from './environment-runtime'
import { definitionOf, getEnvironmentRow } from './environments'
import { EventBuffer } from './event-buffer'
import { finalizePhase, StepFailed, type WorkRepo } from './finalize'
import { releaseIssueLock } from './pipeline'
import { answerPreviewTool } from './preview-tool'
import { mergeRequestsOf, projectRepos } from './repos'
import { type RunServices, startRunServices, stopRunServices } from './run-services'
import { readSettings } from './settings'
import { buildRunSpec, sessionToResume } from './spec'
import { ensureWorkspaceRow, resolveBranch, workspaceKey } from './workspace'

export const LEASE_SECONDS = 60
const HEARTBEAT_MS = 20_000
const SUSPEND_AFTER_MS = 20 * 60_000
const FORCE_STOP_AFTER_CANCEL_MS = 60_000
const MAX_STDERR_LOG_LINES = 200
const RETRYABLE: readonly ErrorCode[] = ['rate_limit', 'runtime_crash', 'timeout']

export interface ExecutorDeps extends AppDeps {
  sandbox: SandboxProvider
  owner: string
  subscriber: Redis
}

type TerminalState = 'succeeded' | 'failed' | 'cancelled'

async function claimRun(deps: ExecutorDeps, runId: string): Promise<RunRow | null> {
  const leaseSeconds = deps.timings?.leaseSeconds ?? LEASE_SECONDS
  const [row] = (await deps
    .db('runs')
    .where({ id: runId })
    .whereNotIn('state', ['succeeded', 'failed', 'cancelled'])
    .where((builder) => builder.whereNull('lease_owner').orWhere('lease_expires_at', '<', deps.db.fn.now()).orWhere('lease_owner', deps.owner))
    .update({
      leaseOwner: deps.owner,
      leaseExpiresAt: deps.db.raw(`now() + interval '${leaseSeconds} seconds'`),
      state: deps.db.raw(`CASE WHEN state IN ('queued', 'suspended') THEN 'preparing' ELSE state END`),
      startedAt: deps.db.raw('COALESCE(started_at, now())'),
      updatedAt: deps.db.fn.now(),
    })
    .returning('*')) as RunRow[]
  return row ?? null
}

const activeExecutions = new Map<string, RunExecution>()

export async function executeRun(deps: ExecutorDeps, runId: string): Promise<void> {
  // The claim accepts this worker's own lease so it can resume after a restart, so it cannot stop a recovery job for a run still executing here.
  if (activeExecutions.has(runId)) return
  const run = await claimRun(deps, runId)
  if (!run) return
  const execution = new RunExecution(deps, run)
  activeExecutions.set(runId, execution)
  try {
    await execution.execute()
  } finally {
    if (activeExecutions.get(runId) === execution) activeExecutions.delete(runId)
  }
}

export async function abandonActiveRuns(): Promise<void> {
  for (const execution of activeExecutions.values()) execution.abandon()
  activeExecutions.clear()
}

/** For worker shutdown. Containers keep running, and their leases expire now so the next worker reattaches at once. */
export async function releaseActiveRuns(): Promise<void> {
  await Promise.all([...activeExecutions.values()].map((execution) => execution.release().catch(() => undefined)))
}

class RunExecution {
  private run: RunRow
  private readonly events: EventBuffer
  private issue: IssueRow | null = null
  private project: ProjectRow | null = null
  private scm: ScmConnector | null = null
  private gitToken: string | undefined
  private gitIdentity: Record<string, string> = {}
  private repos: WorkRepo[] = []
  private branch = ''
  private workspace: Workspace | null = null
  private handle: AgentHandle | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private forceStop: NodeJS.Timeout | null = null
  private runTimeout: NodeJS.Timeout | null = null
  private proxyToken: string | null = null
  private lostLease = false
  private suspended = false
  private timedOut = false
  private budgetExceeded = false
  private waitingSince: number | null = null
  private lastBudgetCheck = 0
  private stderrLines = 0
  private lastError: { code: ErrorCode; message: string } | null = null
  private doneEvent: Extract<RunEvent, { type: 'done' }> | null = null
  private usage: Partial<UsageSnapshot>

  constructor(
    private readonly deps: ExecutorDeps,
    run: RunRow,
  ) {
    this.run = run
    this.usage = run.usage ?? {}
    this.events = new EventBuffer(deps.db, deps.redis, run.id, run.lastSeq, run.lastRunnerSeq)
  }

  async execute(): Promise<void> {
    this.heartbeat = setInterval(() => void this.beat().catch(() => undefined), this.deps.timings?.heartbeatMs ?? HEARTBEAT_MS)
    this.heartbeat.unref?.()
    const onCommand = (channel: string, message: string) => {
      if (channel === runCommandChannel(this.run.id)) void this.flushCommands().catch(() => undefined)
      else if (channel === runProxyChannel(this.run.id)) this.recordProxyDenial(message)
    }
    this.deps.subscriber.on('message', onCommand)
    await this.deps.subscriber.subscribe(runCommandChannel(this.run.id), runProxyChannel(this.run.id))
    try {
      await this.loadContext()
      if (this.run.state === 'finalizing') {
        await this.finalize(null)
        return
      }
      const handle = await this.attachOrStart()
      if (!handle) return
      this.handle = handle
      await this.flushCommands()
      await this.ingest(handle)
      if (this.lostLease) return
      if (this.suspended) return
      await this.finalize(handle)
    } catch (error) {
      if (!this.lostLease) await this.failUnexpected(error)
    } finally {
      if (this.heartbeat) clearInterval(this.heartbeat)
      if (this.forceStop) clearTimeout(this.forceStop)
      if (this.runTimeout) clearTimeout(this.runTimeout)
      this.deps.subscriber.off('message', onCommand)
      await this.deps.subscriber.unsubscribe(runCommandChannel(this.run.id), runProxyChannel(this.run.id)).catch(() => undefined)
      if (this.proxyToken && !this.suspended) await this.deps.redis.del(proxyTokenKey(this.proxyToken)).catch(() => undefined)
      await this.events.flush().catch(() => undefined)
    }
  }

  abandon(): void {
    this.lostLease = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.handle?.detach()
  }

  /** Shutdown hook: leave the container alone and let the next worker pick the run up right away. */
  async release(): Promise<void> {
    this.lostLease = true
    this.handle?.detach()
    await this.events.flush().catch(() => undefined)
    await this.deps.db('runs').where({ id: this.run.id, leaseOwner: this.deps.owner }).update({ leaseExpiresAt: this.deps.db.fn.now() })
  }

  private async loadContext(): Promise<void> {
    const { db } = this.deps
    if (this.run.issueId) this.issue = (await db<IssueRow>('issues').where({ id: this.run.issueId }).first()) ?? null
    if (this.run.projectId) this.project = (await db<ProjectRow>('projects').where({ id: this.run.projectId }).first()) ?? null
    const connectionId = this.project?.scmConnectionId ?? (this.run.trigger.scmConnectionId as string | undefined)
    if (connectionId) {
      const connection = await scmConnectionFor(db, connectionId, this.run.agentId, (message) => this.log('warn', message))
      if (connection) {
        this.scm = scmFor(this.deps, connection)
        this.gitToken = this.scm.gitAuth().token
        const { botName, botEmail } = connection.config as { botName?: string; botEmail?: string }
        this.gitIdentity = { ...(botName ? { FX_GIT_NAME: botName } : {}), ...(botEmail ? { FX_GIT_EMAIL: botEmail } : {}) }
      }
    }
    const key = workspaceKey(this.run)
    this.workspace = await this.deps.sandbox.ensureWorkspace(key)
    const row = await ensureWorkspaceRow(db, this.run, this.workspace.volume, this.workspace.mirrorVolume)
    if (this.run.workspaceId !== row.id) {
      await db('runs').where({ id: this.run.id }).update({ workspaceId: row.id })
      this.run.workspaceId = row.id
    }

    const branch = this.issue ? resolveBranch(this.issue) : `factorix/adhoc-${this.run.id.slice(0, 8)}`
    if (this.issue && !this.issue.branchName) {
      await db('issues').where({ id: this.issue.id }).update({ branchName: branch })
      this.issue.branchName = branch
    }
    this.branch = branch
    const adHoc = this.run.adHoc
    const targets: Omit<WorkRepo, 'env'>[] = this.project
      ? (await projectRepos(db, this.project.id)).map((repo) => ({
          id: repo.id,
          scmRepoId: repo.scmRepoId,
          name: repo.name,
          path: repo.scmRepoPath,
          url: repo.scmCloneUrl,
          baseBranch: repo.defaultBranch,
          setupCommands: repo.setupCommands,
          checkCommands: repo.checkCommands,
        }))
      : adHoc?.gitUrl
        ? [
            {
              id: null,
              scmRepoId: null,
              name: 'repo',
              path: adHoc.gitUrl,
              url: adHoc.gitUrl,
              baseBranch: adHoc.ref ?? 'main',
              setupCommands: [],
              checkCommands: [],
            },
          ]
        : []
    if (targets.length === 0) throw new Error('This run has no repository to work on')
    this.repos = targets.map((repo) => ({
      ...repo,
      env: {
        FX_REPO_NAME: repo.name,
        FX_REPO_URL: repo.url,
        FX_PUBLIC_URL: repo.url,
        FX_BRANCH: branch,
        FX_BASE_BRANCH: repo.baseBranch,
        FX_RUN: this.run.id,
        FX_AGENT: this.agentHandle,
        ...this.gitIdentity,
        // Keeps files from different repositories apart in the combined diff.
        ...(targets.length > 1 ? { FX_DIFF_PREFIX: repo.name } : {}),
      },
    }))
  }

  private get agentHandle(): string {
    return String((this.run.agentSnapshot as { handle?: string }).handle ?? 'agent')
  }

  private log(level: 'info' | 'warn' | 'error' | 'debug', message: string, source = 'worker'): void {
    this.events.append({ type: 'log', level, source, message })
  }

  private recordProxyDenial(message: string): void {
    try {
      const denial = JSON.parse(message) as { host?: string; reason?: string }
      this.log('warn', `Egress proxy denied ${denial.host ?? 'a request'}${denial.reason ? `: ${denial.reason}` : ''}`, 'egress-proxy')
    } catch {}
  }

  private async attachOrStart(): Promise<AgentHandle | null> {
    if (this.run.containerId) {
      const handle = await this.deps.sandbox.reattach(this.run.containerId)
      if (handle) {
        this.log('info', 'Worker reattached to the running container.')
        return handle
      }
      if (this.run.state !== 'preparing') {
        await this.finish({
          state: 'failed',
          outcome: 'failed',
          result: 'failed',
          error: { code: 'runtime_crash', message: 'The agent container disappeared while the worker was away.' },
          retryable: true,
        })
        return null
      }
    }
    return this.prepareAndStart()
  }

  private async mirrorAndCheckout(repos: WorkRepo[] = this.repos): Promise<{ conflicts: string[]; setupFailures: string[]; head?: string }> {
    const sandbox = this.deps.sandbox
    const workspace = this.workspace as Workspace
    const containerEnv = await this.containerEnv()
    const result: { conflicts: string[]; setupFailures: string[]; head?: string } = { conflicts: [], setupFailures: [] }
    for (const repo of repos) {
      const fetched = await sandbox.runStep(workspace, { op: 'mirror-fetch', env: repo.env, gitToken: this.gitToken, timeoutSeconds: 900 })
      if (fetched.exitCode !== 0) throw new StepFailed('mirror-fetch', fetched)
      if (!this.project && !this.run.adHoc?.ref && fetched.values.DEFAULT_BRANCH) {
        repo.baseBranch = fetched.values.DEFAULT_BRANCH
        repo.env.FX_BASE_BRANCH = fetched.values.DEFAULT_BRANCH
      }
      const checkoutEnv: Record<string, string> = { ...repo.env, ...containerEnv }
      // With several repositories a ticket may touch only one, so setup runs where the agent works, not in all of them.
      if (repo.setupCommands.length > 0 && this.repos.length === 1) checkoutEnv.FX_SETUP = repo.setupCommands.join(' && ')
      const checkout = await sandbox.runStep(workspace, { op: 'checkout', env: checkoutEnv, timeoutSeconds: 1800 })
      if (checkout.stderr.trim()) this.log('debug', checkout.stderr.trim().slice(-4000), 'checkout')
      if (checkout.exitCode !== 0) throw new StepFailed('checkout', checkout)
      if (checkout.values.CONFLICT === '1') result.conflicts.push(repo.name)
      if (checkout.values.SETUP_FAILED) result.setupFailures.push(`${repo.name} (exit code ${checkout.values.SETUP_FAILED})`)
      result.head ??= checkout.values.HEAD
    }
    return result
  }

  /** Env for anything that runs repo or agent code. It holds the egress proxy token, never the git token. */
  private async containerEnv(): Promise<Record<string, string>> {
    const { env, db } = this.deps
    const values: Record<string, string> = {
      FX_AGENT: this.agentHandle,
      FX_RUN: this.run.id,
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }
    const generic = (await db('connections')
      .join('agent_connections', 'connections.id', 'agent_connections.connection_id')
      .where({ 'agent_connections.agent_id': this.run.agentId, 'connections.kind': 'generic', 'connections.agent_visible': true })
      .select('connections.*')) as ConnectionRow[]
    for (const connection of generic) {
      const secret = decryptConnection(this.deps, connection)
      if (secret) Object.assign(values, (JSON.parse(secret) as { env?: Record<string, string> }).env ?? JSON.parse(secret))
    }

    const anthropicKey = await resolveModelKey(this.deps, this.run.orgId, this.run.agentId, 'anthropic')
    const openaiKey = await resolveModelKey(this.deps, this.run.orgId, this.run.agentId, 'openai')
    if (!env.FACTORIX_PROXY_URL) {
      if (anthropicKey) values.ANTHROPIC_API_KEY = anthropicKey
      if (openaiKey) values.CODEX_API_KEY = openaiKey
      return values
    }

    if (!this.proxyToken) {
      this.proxyToken = randomToken(24)
      await this.deps.redis.set(
        proxyTokenKey(this.proxyToken),
        JSON.stringify({ runId: this.run.id, allow: await this.allowlist(), anthropicKey, openaiKey }),
        'EX',
        (this.project?.runTimeoutMinutes ?? 90) * 60 + 3600,
      )
    }
    const proxy = new URL(env.FACTORIX_PROXY_URL)
    const authed = `${proxy.protocol}//${this.proxyToken}:x@${proxy.host}`
    const noProxy = [proxy.hostname, 'localhost', '127.0.0.1', `.${PREVIEW_DOMAIN}`, ...(this.project?.networkBypass ?? []).map(noProxyHost)].join(
      ',',
    )
    Object.assign(values, {
      HTTP_PROXY: authed,
      HTTPS_PROXY: authed,
      http_proxy: authed,
      https_proxy: authed,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      // Node's built-in fetch ignores the variables above without this, and Corepack downloads Yarn with it.
      NODE_USE_ENV_PROXY: '1',
      ANTHROPIC_BASE_URL: `${proxy.origin}/anthropic`,
      ANTHROPIC_API_KEY: this.proxyToken,
      OPENAI_BASE_URL: `${proxy.origin}/openai/v1`,
      CODEX_API_KEY: this.proxyToken,
    })
    return values
  }

  private async allowlist(): Promise<string[]> {
    const policy = this.project?.networkPolicy ?? 'restricted'
    if (policy === 'open') return ['*']
    if (policy === 'none') return []
    const mcpRows = (await this.deps
      .db('connections')
      .join('agent_connections', 'connections.id', 'agent_connections.connection_id')
      .where({ 'agent_connections.agent_id': this.run.agentId, 'connections.kind': 'mcp_http' })
      .select('connections.config')) as { config: { url?: string } }[]
    const mcpHosts = mcpRows.flatMap((row) => {
      try {
        return row.config.url ? [new URL(row.config.url).hostname] : []
      } catch {
        return []
      }
    })
    const connectionIds = this.project
      ? [this.project.trackerConnectionId, this.project.scmConnectionId]
      : [this.run.trigger.scmConnectionId as string | undefined].filter((id) => id !== undefined)
    return [...(await restrictedHosts(this.deps.db, this.run.orgId, this.project, connectionIds)), ...mcpHosts]
  }

  private async ciFailures(): Promise<string[]> {
    if (!this.scm || !this.issue || !this.project) return []
    if (this.run.phase !== 'review' && this.run.phase !== 'address_review') return []
    const scm = this.scm
    const failures: string[] = []
    const mergeRequests = await mergeRequestsOf(this.deps.db, this.issue.id)
    for (const mr of mergeRequests) {
      try {
        const ci = await scm.getCiStatus(mr.repo.scmRepoId, mr.mrIid)
        const prefix = mergeRequests.length > 1 ? `${mr.repo.name}: ` : ''
        failures.push(...ci.failedJobs.map((job) => `${prefix}${job.stage}/${job.name} ${job.webUrl}${job.logTail ? `\n${job.logTail}` : ''}`))
      } catch (error) {
        this.log('warn', `Could not read CI status of ${mr.repoPath}: ${(error as Error).message}`)
      }
    }
    return failures
  }

  private async prepareAndStart(): Promise<AgentHandle | null> {
    const { db, sandbox } = this.deps
    if (this.run.runtime === 'scripted' && !(await readSettings(this.deps)).allowScriptedRuntime)
      throw new Error('The scripted runtime is disabled on this deployment')
    const workspace = this.workspace as Workspace
    const checkout = await this.mirrorAndCheckout()
    if (checkout.head)
      await db('workspaces').where({ id: this.run.workspaceId }).update({ headSha: checkout.head, branch: this.branch, lastUsedAt: db.fn.now() })
    const services = await this.startServices()

    const several = this.repos.length > 1
    const repoDocs: { path: string; content: string }[] = []
    for (const repo of this.repos) {
      const docs = await sandbox.runStep(workspace, { op: 'docs', env: repo.env })
      const parsed = docs.exitCode === 0 ? (JSON.parse(docs.stdout) as { agents: string; claude: string }) : { agents: '', claude: '' }
      const prefix = several ? `${repo.name}/` : ''
      if (parsed.agents.length > 0) repoDocs.push({ path: `${prefix}AGENTS.md`, content: parsed.agents })
      if (parsed.claude.length > 0) repoDocs.push({ path: `${prefix}CLAUDE.md`, content: parsed.claude })
    }

    const notes: string[] = []
    if (services.note) notes.push(services.note)
    const previewTool = await this.offersPreviewTool()
    if (previewTool)
      notes.push(
        'This project can run the issue as a preview. preview_start runs your working copy, uncommitted files included, and preview_status, preview_logs, and preview_stop follow it. Use it to check your change running before you finish.',
      )
    if (checkout.conflicts.length > 0)
      notes.push(
        `The branch ${this.branch} in ${checkout.conflicts.join(', ')} could not be rebased onto its remote copy, so your local commits are not on top of the latest remote work. Reconcile them before you finish.`,
      )
    if (checkout.setupFailures.length > 0)
      notes.push(`The setup command failed in ${checkout.setupFailures.join(', ')}. Some dependencies may be missing.`)

    let resumeSessionRef = await sessionToResume(this.deps, this.run)
    if (this.run.sessionRef) {
      const decided = await this.deps
        .db('approvals')
        .where({ runId: this.run.id })
        .whereNot({ status: 'pending' })
        .orderBy('decided_at', 'desc')
        .first()
      if (decided)
        notes.push(
          `A person answered your earlier request (${decided.kind}): ${decided.status}. ${(decided.decision as { message?: string } | null)?.message ?? ''} Continue from there.`,
        )
    }
    const spec: RunSpec = await buildRunSpec(this.deps, {
      run: this.run,
      issue: this.issue,
      project: this.project,
      repos: this.repos,
      branch: this.branch,
      repoDocs,
      ciFailures: await this.ciFailures(),
      extraNotes: notes,
      resumeSessionRef,
      previewTool,
      scripted: this.deps.scriptFor?.(this.run.phase, this.run.attempt),
    })
    resumeSessionRef = undefined

    const options: StartAgentOptions = {
      runId: this.run.id,
      issueKey: workspaceKey(this.run),
      readOnlyRepo: PHASES[this.run.phase as Phase].readOnlyRepo,
      env: withServices(await this.containerEnv(), services.started),
      networks: services.started?.network ? [services.started.network] : undefined,
      image: this.project?.sandboxImage ?? undefined,
      limits:
        this.project?.limits.memoryMb || this.project?.limits.cpus
          ? { memoryBytes: this.project.limits.memoryMb ? this.project.limits.memoryMb * 1024 * 1024 : undefined, cpus: this.project.limits.cpus }
          : undefined,
    }
    const handle = await sandbox.startAgent(workspace, options)
    await db('runs').where({ id: this.run.id }).update({ containerId: handle.containerId, updatedAt: db.fn.now() })
    this.run.containerId = handle.containerId
    handle.send(encodeLine(spec))
    this.scheduleTimeout()
    return handle
  }

  /** An issue run gets the preview tools when the project's environment has something to open and the runtime can host them. */
  private async offersPreviewTool(): Promise<boolean> {
    if (!this.issue || !this.project || !RUNTIME_CAPABILITIES[this.run.runtime].mcp.stdio) return false
    return Boolean(definitionOf(await getEnvironmentRow(this.deps.db, this.project.id))?.expose)
  }

  /** What the project's environment gives agent runs. If the services fail, the run goes on without them and the agent is told. */
  private async startServices(): Promise<{ started: RunServices | null; note?: string }> {
    if (!this.project) return { started: null }
    try {
      const started = await startRunServices(this.deps, {
        run: this.run,
        project: this.project,
        workspace: this.workspace as Workspace,
        repos: this.repos.map((repo) => repo.name),
        allow: () => this.allowlist(),
        ttlSeconds: (this.project.runTimeoutMinutes ?? 90) * 60 + 3600,
        log: (level, message) => this.log(level, message, 'services'),
      })
      return { started, note: started?.note || undefined }
    } catch (error) {
      const message = (error as Error).message
      this.log('error', `The run's services did not start. ${message}`, 'services')
      return {
        started: null,
        note: `The services this project gives agent runs did not start, so anything that needs them will fail: ${message.split('\n')[0]}`,
      }
    }
  }

  private scheduleTimeout(): void {
    const minutes = this.project?.runTimeoutMinutes ?? 90
    this.runTimeout = setTimeout(() => {
      this.timedOut = true
      this.log('warn', `The run reached its ${minutes} minute limit.`)
      this.handle?.send(encodeLine({ type: 'cancel', reason: 'timeout', graceSeconds: 30 }))
      this.armForceStop()
    }, minutes * 60_000)
    this.runTimeout.unref?.()
  }

  private armForceStop(): void {
    if (this.forceStop || !this.run.containerId) return
    const containerId = this.run.containerId
    this.forceStop = setTimeout(() => void this.deps.sandbox.stop(containerId, 5).catch(() => undefined), FORCE_STOP_AFTER_CANCEL_MS)
    this.forceStop.unref?.()
  }

  private async setState(state: RunRow['state'], extra: Record<string, unknown> = {}): Promise<void> {
    this.run.state = state
    await this.deps
      .db('runs')
      .where({ id: this.run.id })
      .update({ state, updatedAt: this.deps.db.fn.now(), ...extra })
    await this.deps.redis.publish(orgChannel(this.run.orgId), JSON.stringify({ kind: 'run', id: this.run.id, projectId: this.run.projectId }))
  }

  private async ingest(handle: AgentHandle): Promise<void> {
    handle.onStderr((line) => {
      if (this.stderrLines++ < MAX_STDERR_LOG_LINES) this.log('debug', line.slice(0, 2000), 'runner')
    })
    for await (const line of handle.lines) {
      const event = decodeEvent(line)
      if (!event) continue
      if (event.seq === 0) {
        this.events.publishPartial(event)
        continue
      }
      if (!this.events.acceptRunnerSeq(event.seq)) continue
      const { seq: _seq, ts: _ts, runId: _runId, ...body } = event
      this.events.append(body as never)
      await this.onEvent(event)
      if (event.type === 'done') break
    }
    await this.events.flush()
  }

  private async onEvent(event: RunEvent): Promise<void> {
    const { db } = this.deps
    switch (event.type) {
      case 'run.started':
        this.run.sessionRef = event.sessionRef
        await this.setState('running', { sessionRef: event.sessionRef, model: event.model || this.run.model })
        break
      case 'approval.requested': {
        const expiresAt = new Date(Date.now() + 48 * 3_600_000)
        const [approval] = await db('approvals')
          .insert({
            orgId: this.run.orgId,
            runId: this.run.id,
            issueId: this.run.issueId,
            runnerApprovalId: event.approvalId,
            kind: event.kind,
            payload: json({ tool: event.tool, input: event.input, summary: event.summary, options: event.options }),
            expiresAt,
          })
          .returning('id')
        await this.setState('waiting_approval')
        this.waitingSince = Date.now()
        if (approval) await emit(db, this.run.orgId, { type: 'notify', kind: 'approval', id: approval.id, projectId: this.run.projectId })
        break
      }
      case 'approval.resolved':
        this.waitingSince = null
        await this.setState('running')
        break
      case 'usage':
        await this.onUsage(event)
        break
      case 'error':
        this.lastError = { code: event.code, message: event.message }
        break
      case 'done':
        this.doneEvent = event
        if (event.sessionRef) this.run.sessionRef = event.sessionRef
        this.usage = event.usage
        break
      case 'request':
        // A preview can take minutes, and events keep flowing meanwhile.
        void this.answer(event)
        break
    }
  }

  private async answer(event: Extract<RunEvent, { type: 'request' }>): Promise<void> {
    let response: RunCommand
    try {
      const result = await answerPreviewTool(this.deps, { run: this.run, issue: this.issue, op: event.op, input: event.input })
      response = { type: 'response', requestId: event.requestId, ok: true, result }
    } catch (error) {
      response = { type: 'response', requestId: event.requestId, ok: false, error: (error as Error).message }
    }
    this.handle?.send(encodeLine(response))
  }

  private async onUsage(event: Extract<RunEvent, { type: 'usage' }>): Promise<void> {
    const { db } = this.deps
    this.usage = event
    const estimated = event.costUsd === undefined
    const cost = event.costUsd ?? estimateCostUsd(this.run.model ?? undefined, event)
    await db('runs')
      .where({ id: this.run.id })
      .update({
        usage: json({
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheWriteTokens: event.cacheWriteTokens,
          reasoningTokens: event.reasoningTokens,
          turns: event.turns,
          costUsd: event.costUsd,
        }),
        costUsd: cost ?? null,
        costEstimated: estimated,
      })
    if (!this.project?.monthlyBudgetUsd || Date.now() - this.lastBudgetCheck < 10_000) return
    this.lastBudgetCheck = Date.now()
    const { sum } = (await db('runs')
      .where({ projectId: this.project.id })
      .andWhere('created_at', '>=', db.raw(`date_trunc('month', now())`))
      .sum('cost_usd as sum')
      .first()) as { sum: string | null }
    if (Number(sum ?? 0) >= this.project.monthlyBudgetUsd) {
      this.budgetExceeded = true
      this.log('error', `Project ${this.project.name} reached its monthly budget of $${this.project.monthlyBudgetUsd}. Stopping this run.`)
      this.handle?.send(encodeLine({ type: 'cancel', reason: 'budget', graceSeconds: 30 }))
      this.armForceStop()
    }
  }

  private async beat(): Promise<void> {
    const { db } = this.deps
    const updated = await db('runs')
      .where({ id: this.run.id, leaseOwner: this.deps.owner })
      .update({ leaseExpiresAt: db.raw(`now() + interval '${this.deps.timings?.leaseSeconds ?? LEASE_SECONDS} seconds'`) })
    if (updated === 0) {
      this.lostLease = true
      this.handle?.detach()
      return
    }
    await this.flushCommands()
    if (this.waitingSince && Date.now() - this.waitingSince > (this.deps.timings?.suspendAfterMs ?? SUSPEND_AFTER_MS)) await this.suspend()
  }

  private async flushCommands(): Promise<void> {
    const handle = this.handle
    if (!handle) return
    const { db } = this.deps
    const commands = await db('run_commands').where({ runId: this.run.id }).whereNull('deliveredAt').orderBy('id')
    for (const command of commands) {
      handle.send(encodeLine(command.payload))
      await db('run_commands').where({ id: command.id }).update({ deliveredAt: db.fn.now() })
      if (command.payload.type === 'cancel') this.armForceStop()
    }
  }

  /** Nobody answered, so stop paying for an idle container. The session stays on the volume for the resume. */
  private async suspend(): Promise<void> {
    const containerId = this.run.containerId
    this.suspended = true
    this.waitingSince = null
    this.log('info', 'No decision yet, so the container is stopping. The run resumes when someone decides.')
    await this.events.flush()
    await this.setState('suspended', { leaseOwner: null, leaseExpiresAt: null, containerId: null, lastRunnerSeq: this.events.lastRunnerSeq })
    this.run.containerId = null
    if (containerId) await this.deps.sandbox.stop(containerId, 5).catch(() => undefined)
    await stopRunServices(this.deps, this.run.id).catch(() => undefined)
    this.handle?.detach()
  }

  private async finalize(handle: AgentHandle | null): Promise<void> {
    const done = this.doneEvent
    let outcome: RunOutcome = done?.outcome ?? 'failed'
    if (!done && handle) {
      const { exitCode } = await handle.wait().catch(() => ({ exitCode: -1 }))
      this.lastError ??= { code: 'runtime_crash', message: `The agent container exited with code ${exitCode} before finishing.` }
    }
    if (this.timedOut) {
      outcome = 'failed'
      this.lastError = { code: 'timeout', message: 'The run hit its time limit.' }
    } else if (this.budgetExceeded) {
      outcome = 'budget_exceeded'
      this.lastError = { code: 'policy', message: 'The project reached its monthly budget.' }
    }
    if (outcome === 'budget_exceeded') this.lastError ??= { code: 'policy', message: 'The agent reached its budget.' }
    if (outcome === 'max_turns') this.lastError ??= { code: 'policy', message: 'The agent reached its turn limit.' }

    await this.setState('finalizing', { sessionRef: this.run.sessionRef })
    const structuredOutput = done?.structuredOutput ?? this.run.structuredOutput
    let result = 'failed'
    let diff: string | undefined
    try {
      const finalized = await finalizePhase({
        db: this.deps.db,
        sandbox: this.deps.sandbox,
        workspace: this.workspace as Workspace,
        run: this.run,
        issue: this.issue,
        project: this.project,
        scm: this.scm,
        gitToken: this.gitToken,
        repos: this.repos,
        branch: this.branch,
        agentHandle: this.agentHandle,
        outcome,
        structuredOutput,
        log: (body) => this.events.append(body),
        refresh: (repo) => this.mirrorAndCheckout([repo]),
      })
      result = finalized.result
      diff = finalized.diff
    } catch (error) {
      const message = (error as Error).message
      this.log('error', message, 'finalize')
      this.lastError = { code: error instanceof StepFailed ? 'tool' : 'unknown', message }
      result = 'failed'
      outcome = outcome === 'completed' ? 'failed' : outcome
    }

    await this.clearCache()

    const cancelled = outcome === 'cancelled'
    const state: TerminalState = cancelled ? 'cancelled' : result === 'failed' ? 'failed' : 'succeeded'
    const code = this.lastError?.code
    await this.finish({
      state,
      outcome,
      result,
      summary: summaryOf(structuredOutput, done?.finalText),
      structuredOutput,
      diff,
      error: state === 'failed' ? (this.lastError ?? { code: 'unknown', message: done?.finalText || 'The run failed.' }) : null,
      retryable: code ? RETRYABLE.includes(code) : false,
    })
    if (state === 'succeeded' && this.run.containerId) await this.deps.sandbox.remove(this.run.containerId).catch(() => undefined)
    else if (state === 'cancelled' && this.run.containerId) await this.deps.sandbox.remove(this.run.containerId).catch(() => undefined)
  }

  /** Runs before the issue's lock is released, so it cannot pull a cache out from under the next run's install. */
  private async clearCache(): Promise<void> {
    const [repo] = this.repos
    if (!this.workspace || !repo) return
    try {
      if (!(await readSettings(this.deps)).clearRunCache) return
      const result = await this.deps.sandbox.runStep(this.workspace, { op: 'clear-cache', env: repo.env })
      if (result.exitCode !== 0) this.log('warn', `Could not clear the package caches: ${result.stderr.trim().slice(-500)}`)
    } catch (error) {
      this.log('warn', `Could not clear the package caches: ${(error as Error).message}`)
    }
  }

  private async failUnexpected(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    this.log('error', message)
    await this.clearCache()
    const code: ErrorCode =
      error instanceof StepFailed && /auth|403|401|could not read Username/i.test(error.message)
        ? 'auth'
        : error instanceof StepFailed
          ? 'tool'
          : 'runtime_crash'
    await this.finish({ state: 'failed', outcome: 'failed', result: 'failed', error: { code, message }, retryable: code === 'runtime_crash' }).catch(
      () => undefined,
    )
    if (this.run.containerId) await this.deps.sandbox.stop(this.run.containerId, 5).catch(() => undefined)
  }

  private async finish(input: {
    state: TerminalState
    outcome: RunOutcome
    result: string
    summary?: string
    structuredOutput?: unknown
    diff?: string
    error: { code?: string; message: string } | null
    retryable: boolean
  }): Promise<void> {
    await this.events.flush()
    const { db } = this.deps
    const cost =
      this.usage.costUsd ??
      estimateCostUsd(this.run.model ?? undefined, {
        inputTokens: this.usage.inputTokens ?? 0,
        outputTokens: this.usage.outputTokens ?? 0,
        cacheReadTokens: this.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: this.usage.cacheWriteTokens ?? 0,
        turns: this.usage.turns ?? 0,
      })
    await db.transaction(async (trx) => {
      const issue = this.run.issueId ? await trx<IssueRow>('issues').where({ id: this.run.issueId }).forUpdate().first() : undefined
      await trx('runs')
        .where({ id: this.run.id })
        .update({
          state: input.state,
          outcome: input.outcome,
          result: input.result,
          summary: input.summary ?? null,
          structuredOutput: input.structuredOutput === undefined ? null : json(input.structuredOutput),
          usage: json(this.usage),
          costUsd: cost ?? null,
          costEstimated: this.usage.costUsd === undefined,
          diff: input.diff ?? null,
          error: input.error ? json(input.error) : null,
          sessionRef: this.run.sessionRef,
          finishedAt: trx.fn.now(),
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: trx.fn.now(),
        })
      await trx('approvals')
        .where({ runId: this.run.id, status: 'pending' })
        .whereIn('kind', ['tool', 'question'])
        .update({ status: 'expired', decidedAt: trx.fn.now() })
      if (this.run.workspaceId) await trx('workspaces').where({ id: this.run.workspaceId }).update({ state: 'ready', lastUsedAt: trx.fn.now() })
      await writeAudit(trx, {
        orgId: this.run.orgId,
        actorAccountId: this.run.agentId,
        actorKind: 'agent',
        action: 'run.finished',
        targetType: 'run',
        targetId: this.run.id,
        metadata: { state: input.state, outcome: input.outcome, result: input.result, phase: this.run.phase, costUsd: cost },
      })
      await emit(trx, this.run.orgId, { type: 'notify', kind: 'run', id: this.run.id, projectId: this.run.projectId })
      if (issue) {
        await releaseIssueLock(trx, issue.id, this.run.id)
        if (input.state !== 'cancelled' && issue.cursor?.step === this.run.pipelineStep) {
          await emit(trx, this.run.orgId, {
            type: 'pipeline.advance',
            issueId: issue.id,
            event: { type: 'run.finished', result: input.result, retryable: input.retryable },
          })
        }
      }
    })
    this.run.state = input.state
    // The cleanup sweep retries anything left behind here.
    await stopRunServices(this.deps, this.run.id).catch(() => undefined)
  }
}

/** The run's own values come first, so nothing in the definition can replace the proxy, the model keys, or the run's identity. */
function withServices(env: Record<string, string>, services: RunServices | null): Record<string, string> {
  if (!services) return env
  const merged = { ...services.env, ...env }
  if (env.NO_PROXY && services.noProxy.length > 0) {
    merged.NO_PROXY = [env.NO_PROXY, ...services.noProxy].join(',')
    merged.no_proxy = merged.NO_PROXY
  }
  return merged
}

function summaryOf(output: unknown, finalText: string | undefined): string | undefined {
  const summary = (output as { summary?: unknown } | null | undefined)?.summary
  if (typeof summary === 'string' && summary) return summary
  return finalText || undefined
}

export function newWorkerId(): string {
  return `worker-${randomUUID().slice(0, 8)}`
}
