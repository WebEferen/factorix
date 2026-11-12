// biome-ignore-all lint/suspicious/noTemplateCurlyInString: definitions use ${...} templates
import { type EnvironmentInstanceRow, json } from '@factorix/db'
import type { Environment, LogLine, SandboxProvider, ServiceSpec, ServiceState, StepRequest, Workspace } from '@factorix/sandbox'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { previewKeys, proxyTokenKey } from './lib/channels'
import { reapSandboxes } from './services/maintenance'
import { runPreviewAction, stopAllPumps, sweepPreviews } from './services/preview-runner'
import { answerPreviewTool } from './services/preview-tool'
import { refreshAfterPush } from './services/previews'
import { TEAM_ID } from './testing/fakes'
import { ApiClient, createHarness, type Harness } from './testing/harness'

const SOURCE = `services:
  db:
    image: postgres:17
    data: /var/lib/postgresql/data
    ready:
      command: pg_isready
  api:
    repo: r
    start: yarn dev
    port: 3000
    secrets: [backend]
    env:
      DATABASE_URL: postgres://\${services.db.host}:5432/app
      ORIGIN: \${preview.url}
    dependsOn: [db]
expose:
  service: api
notes: Sign in as the seeded user.
`

class FakeSandbox {
  steps: StepRequest[] = []
  stepWorkspaces: Workspace[] = []
  started: ServiceSpec[] = []
  stopped: { key: string; services?: string[] }[] = []
  wiped: { key: string; source: boolean }[] = []
  states = new Map<string, { state: ServiceState; exitCode?: number }>()
  roles = new Set(['gateway', 'egress'])
  logs: LogLine[] = []
  attached: { key: string; containerId: string }[] = []

  async ensureWorkspace(key: string): Promise<Workspace> {
    return { key, volume: `fx-ws-${key}`, mirrorVolume: `fx-mirror-${key}` }
  }
  async runStep(workspace: Workspace, request: StepRequest) {
    this.steps.push(request)
    this.stepWorkspaces.push(workspace)
    const values: Record<string, string> = request.op === 'export' ? { REF: 'factorix/abc-1', HEAD: 'a'.repeat(40) } : {}
    return { op: request.op, exitCode: 0, stdout: '', stderr: '', values, timedOut: false, durationMs: 1 }
  }
  async ensureEnvironment(key: string): Promise<Environment> {
    return { key, network: `fx-env-${key}`, sourceVolume: `fx-envsrc-${key}` }
  }
  async startService(_environment: Environment, spec: ServiceSpec): Promise<string> {
    this.started.push(spec)
    return `container-${spec.service}`
  }
  async serviceState(containerId: string) {
    return this.states.get(containerId) ?? { state: 'healthy' as const }
  }
  async joinEnvironment(_environment: Environment, role: 'gateway' | 'egress') {
    return this.roles.has(role)
  }
  async attachToEnvironment(key: string, containerId: string) {
    this.attached.push({ key, containerId })
    return true
  }
  async followLogs(_id: string, options: { signal: AbortSignal }, onLine: (line: LogLine) => void) {
    for (const line of this.logs) onLine(line)
    await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }))
  }
  async stopEnvironment(key: string, services?: string[]) {
    this.stopped.push({ key, services })
  }
  async removeEnvironmentVolumes(key: string, options: { source: boolean }) {
    this.wiped.push({ key, source: options.source })
  }
}

describe('previews', () => {
  let harness: Harness
  let admin: ApiClient
  let member: ApiClient
  let projectId: string
  let doppler: string
  let issueIds: string[]
  let sandbox: FakeSandbox
  let workerDeps: Parameters<typeof runPreviewAction>[0]

  const url = (issue = 0, action = '') => `/api/issues/${issueIds[issue]}/preview${action ? `/${action}` : ''}`
  const row = async (issue = 0) =>
    (await harness.deps.db<EnvironmentInstanceRow>('environment_instances').where({ issueId: issueIds[issue] }).first()) as EnvironmentInstanceRow
  const saveEnvironment = (source: string) =>
    admin.ok('PUT', `/api/projects/${projectId}/environment`, {
      source,
      secretSets: [{ name: 'backend', connectionId: doppler, project: 'backend', config: 'dev' }],
    })

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    await admin.ok('POST', '/api/members', { name: 'Bo', email: 'bo@example.com', password: 'long enough password', role: 'member' })
    member = new ApiClient(harness.app)
    await member.ok('POST', '/api/auth/login', { email: 'bo@example.com', password: 'long enough password' })
    const linear = (await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'lin-token' })).connection.id
    const gitlab = (await admin.ok('POST', '/api/connections', { kind: 'gitlab', name: 'GitLab', secret: 'git-token', config: {} })).connection.id
    doppler = (await admin.ok('POST', '/api/connections', { kind: 'doppler', name: 'Doppler', secret: 'dp.sa.the-token' })).connection.id
    projectId = (
      await admin.ok('POST', '/api/projects', {
        name: 'App',
        trackerConnectionId: linear,
        trackerTeamId: TEAM_ID,
        trackerProjectId: null,
        scmConnectionId: gitlab,
        repos: [{ scmRepoId: '42', scmRepoPath: 'g/r', scmCloneUrl: 'https://gitlab.com/g/r.git', defaultBranch: 'main' }],
        stateMap: { in_progress: 'st-progress', in_review: 'st-review', done: 'st-done', blocked: 'st-blocked' },
        networkAllowlist: ['api.stripe.com'],
        networkBypass: ['test-internal-api', '*.corp.test'],
      })
    ).project.id
    const { orgId } = await harness.deps.db('projects').where({ id: projectId }).first()
    issueIds = (
      await harness.deps
        .db('issues')
        .insert([1, 2].map((n) => ({ orgId, projectId, trackerIssueId: `t-${n}`, identifier: `ABC-${n}`, title: `Issue ${n}` })))
        .returning('id')
    ).map((issue: { id: string }) => issue.id)
  })
  afterAll(async () => {
    stopAllPumps()
    await harness.destroy()
  })
  beforeEach(async () => {
    await harness.deps.db('environment_instances').delete()
    await harness.deps.db('project_environments').delete()
    await harness.deps.db('platform_settings').delete()
    harness.world.dopplerConfigs = new Map([['backend/dev', { API_KEY: 'doppler-secret-value', DATABASE_URL: 'postgres://prod' }]])
    sandbox = new FakeSandbox()
    workerDeps = {
      ...harness.deps,
      env: { ...harness.deps.env, FACTORIX_PROXY_URL: 'http://egress-proxy:8080' },
      sandbox: sandbox as unknown as SandboxProvider,
      owner: 'worker-test',
    }
  })

  it('explains why an issue has no preview', async () => {
    expect((await member.ok('GET', url())).preview).toMatchObject({ unavailable: expect.stringContaining('no environment yet'), state: null })
    await saveEnvironment(SOURCE.replace(/expose:\n {2}service: api\n/, ''))
    expect((await member.ok('GET', url())).preview.unavailable).toBe('The project’s environment has nothing to open. Add expose to it.')
    expect((await member.request('POST', url(0, 'start'))).status).toBe(409)
  })

  it('lets any member start one preview per issue, audited, with a job for the worker', async () => {
    await saveEnvironment(SOURCE)
    const started = await member.request('POST', url(0, 'start'))
    expect(started.status).toBe(202)
    expect(started.body.preview).toMatchObject({
      state: 'starting',
      unavailable: null,
      definitionVersion: 1,
      notes: 'Sign in as the seeded user.',
      startedBy: { name: 'Bo' },
      services: [
        { name: 'db', state: 'waiting', repo: null, image: 'postgres:17' },
        { name: 'api', state: 'waiting', repo: 'r', image: null },
      ],
    })
    expect(started.body.preview.url).toMatch(/^http:\/\/[a-z0-9]{10}\.preview\.localhost:4102$/)
    expect((await member.request('POST', url(0, 'start'))).body.error.message).toBe('This preview is already running.')
    expect((await member.request('POST', url(0, 'refresh'))).status).toBe(409)
    expect((await member.request('POST', url(0, 'open'))).body.error.message).toBe('This preview is not ready to open.')
    const event = await harness.deps.db('domain_events').where({ type: 'environment.action' }).orderBy('id', 'desc').first()
    expect(event.payload).toEqual({ instanceId: (await row()).id, action: 'start' })
    const audit = await harness.deps.db('audit_log').where({ action: 'preview.start' }).first()
    expect(audit).toMatchObject({ actorKind: 'human', targetType: 'issue', targetId: issueIds[0] })
  })

  it('caps how many previews run at once', async () => {
    await saveEnvironment(SOURCE)
    await admin.ok('PUT', '/api/settings/general', { values: { previewMaxRunning: 1 } })
    await member.ok('POST', url(0, 'start'))
    const second = await member.request('POST', url(1, 'start'))
    expect(second.status).toBe(409)
    expect(second.body.error).toMatchObject({ code: 'too_many_previews', message: '1 preview is running, the most allowed at once. Stop one first.' })
  })

  it('refuses issues from another organization', async () => {
    const stranger = new ApiClient(harness.app)
    expect((await stranger.request('GET', url())).status).toBe(401)
    expect((await member.request('GET', '/api/issues/00000000-0000-0000-0000-000000000000/preview')).status).toBe(404)
  })

  it('starts services in order with secrets, the egress proxy, and masked logs, then opens with a one-time ticket', async () => {
    await saveEnvironment(SOURCE)
    await member.ok('POST', url(0, 'start'))
    sandbox.logs = [{ ts: Date.now(), stream: 'stdout', text: 'connecting with doppler-secret-value' }]
    await runPreviewAction(workerDeps, (await row()).id, 'start')

    const ready = await row()
    expect(ready).toMatchObject({ state: 'ready', error: null, commits: { r: { ref: 'factorix/abc-1', sha: 'a'.repeat(40) } } })
    expect(ready.services).toMatchObject({
      db: { state: 'ready', containerId: 'container-db' },
      api: { state: 'ready', containerId: 'container-api' },
    })

    expect(sandbox.steps.map((step) => [step.op, Boolean(step.gitToken)])).toEqual([
      ['mirror-fetch', true],
      ['export', false],
    ])
    expect(sandbox.stepWorkspaces[1]).toMatchObject({ volume: `fx-envsrc-${ready.slug}`, mirrorVolume: `fx-mirror-${issueIds[0]}` })
    expect(sandbox.started.map((spec) => spec.service)).toEqual(['db', 'api'])
    const api = sandbox.started[1] as ServiceSpec
    expect(api.env).toMatchObject({
      API_KEY: 'doppler-secret-value',
      DATABASE_URL: 'postgres://db:5432/app',
      ORIGIN: `http://${ready.slug}.preview.localhost:4102`,
      NODE_USE_ENV_PROXY: '1',
    })
    expect(api.env.HTTP_PROXY).toMatch(/^http:\/\/[^:]+:x@factorix-egress:8080$/)
    expect(api.env.NO_PROXY?.split(',')).toEqual(expect.arrayContaining(['db', 'test-internal-api', '.corp.test']))
    expect(api.env.no_proxy).toBe(api.env.NO_PROXY)
    expect(sandbox.started[0]?.env.API_KEY).toBeUndefined()

    const redis = harness.deps.redis
    const token = (await redis.get(previewKeys.grant(ready.slug))) as string
    expect(JSON.parse((await redis.get(proxyTokenKey(token))) as string)).toMatchObject({
      channel: `preview:${ready.slug}:proxy`,
      anthropicKey: null,
      openaiKey: null,
      allow: expect.arrayContaining(['api.stripe.com', 'registry.npmjs.org']),
    })
    expect(JSON.parse((await redis.get(previewKeys.route(ready.slug))) as string)).toMatchObject({
      state: 'ready',
      upstream: { host: `fx-env-${ready.slug}-api`, port: 3000 },
      frameAncestors: ['http://localhost:4101'],
    })
    const logs = (await redis.lrange(previewKeys.logs(ready.slug), 0, -1)).join('\n')
    expect(logs).toContain('connecting with ••••••')
    expect(logs).not.toContain('doppler-secret-value')
    expect(JSON.stringify(await member.ok('GET', `/api/issues/${issueIds[0]}/preview`))).not.toContain('doppler-secret-value')
    expect(JSON.stringify(await harness.deps.db('environment_instances').where({ id: ready.id }))).not.toContain('doppler-secret-value')

    const opened = await member.ok('POST', url(0, 'open'), { path: '/dashboard' })
    const ticketUrl = new URL(opened.url)
    expect(ticketUrl.host).toBe(`${ready.slug}.preview.localhost:4102`)
    expect(ticketUrl.searchParams.get('to')).toBe('/dashboard')
    const ticket = previewKeys.ticket(ticketUrl.searchParams.get('ticket') as string)
    expect(JSON.parse((await redis.get(ticket)) as string)).toMatchObject({ slug: ready.slug })
    expect(await redis.ttl(ticket)).toBeLessThanOrEqual(60)
    expect((await member.request('POST', url(0, 'open'), { path: '//evil.example' })).status).toBe(422)
  })

  it('fails with the reason, and takes everything down', async () => {
    await saveEnvironment(SOURCE)
    await member.ok('POST', url(0, 'start'))
    sandbox.states.set('container-api', { state: 'exited', exitCode: 1 })
    await runPreviewAction(workerDeps, (await row()).id, 'start')
    const failed = await row()
    expect(failed).toMatchObject({ state: 'failed', error: 'api exited with code 1 before it was ready. Its log says why.' })
    expect(failed.services.api).toMatchObject({ state: 'failed' })
    expect(sandbox.stopped.at(-1)).toEqual({ key: failed.slug, services: undefined })
    expect(await harness.deps.redis.exists(previewKeys.route(failed.slug), previewKeys.grant(failed.slug))).toBe(0)
  })

  it('refuses to start without the egress proxy rather than run with no network rules', async () => {
    await saveEnvironment(SOURCE)
    await member.ok('POST', url(0, 'start'))
    sandbox.roles.delete('egress')
    await runPreviewAction(workerDeps, (await row()).id, 'start')
    expect((await row()).error).toMatch(/egress proxy is not running/)
    expect(sandbox.started).toEqual([])
  })

  it('stops, clearing the route and the egress grant, and starts again with the same address', async () => {
    await saveEnvironment(SOURCE)
    await member.ok('POST', url(0, 'start'))
    await runPreviewAction(workerDeps, (await row()).id, 'start')
    const { slug } = await row()
    const token = (await harness.deps.redis.get(previewKeys.grant(slug))) as string
    await member.ok('POST', url(0, 'stop'))
    expect((await row()).state).toBe('stopping')
    await runPreviewAction(workerDeps, (await row()).id, 'stop')
    expect(await row()).toMatchObject({ state: 'stopped', services: { db: { state: 'stopped' }, api: { state: 'stopped' } } })
    expect(await harness.deps.redis.exists(previewKeys.route(slug), previewKeys.grant(slug), proxyTokenKey(token))).toBe(0)
    expect(sandbox.wiped).toEqual([])
    await member.ok('POST', url(0, 'start'))
    expect((await row()).slug).toBe(slug)
  })

  it('resets data under a new setup generation', async () => {
    await saveEnvironment(SOURCE)
    await member.ok('POST', url(0, 'start'))
    await runPreviewAction(workerDeps, (await row()).id, 'start')
    await member.ok('POST', url(0, 'reset'))
    expect(await row()).toMatchObject({ state: 'starting', dataGeneration: 2 })
    await runPreviewAction(workerDeps, (await row()).id, 'reset')
    expect(sandbox.wiped).toEqual([{ key: (await row()).slug, source: false }])
    expect((await row()).state).toBe('ready')
  })

  it('refreshes after a push by restarting only the services that run code', async () => {
    await saveEnvironment(SOURCE)
    await member.ok('POST', url(0, 'start'))
    await runPreviewAction(workerDeps, (await row()).id, 'start')
    sandbox.started = []
    await refreshAfterPush(harness.deps.db, issueIds[0] as string)
    expect((await row()).state).toBe('refreshing')
    await runPreviewAction(workerDeps, (await row()).id, 'refresh')
    expect((await row()).state).toBe('ready')
    expect(sandbox.stopped.at(-1)).toEqual({ key: (await row()).slug, services: ['api'] })
    expect(sandbox.started.map((spec) => spec.service)).toEqual(['api'])
    await refreshAfterPush(harness.deps.db, issueIds[1] as string)
  })

  it('stops a preview nobody opens, and one past its time limit', async () => {
    await saveEnvironment(SOURCE)
    await member.ok('POST', url(0, 'start'))
    await member.ok('POST', url(1, 'start'))
    for (const index of [0, 1]) await runPreviewAction(workerDeps, (await row(index)).id, 'start')
    await harness.deps
      .db('environment_instances')
      .where({ issueId: issueIds[0] })
      .update({ readyAt: new Date(Date.now() - 2 * 3_600_000) })
    await harness.deps
      .db('environment_instances')
      .where({ issueId: issueIds[1] })
      .update({ expiresAt: new Date(Date.now() - 1000) })
    await harness.deps.redis.set(previewKeys.seen((await row(1)).slug), String(Date.now()))
    await sweepPreviews(workerDeps)
    expect((await row(0)).state).toBe('stopping')
    expect((await row(1)).state).toBe('stopping')
    const reasons = (await harness.deps.db('audit_log').where({ action: 'preview.stop' }).orderBy('id')).map((entry) => entry.metadata.reason)
    expect(reasons).toEqual(expect.arrayContaining(['Nobody opened it for 60 minutes.', 'Ran for its 24 hour limit.']))
  })

  it('keeps a recently opened preview running', async () => {
    await saveEnvironment(SOURCE)
    await member.ok('POST', url(0, 'start'))
    await runPreviewAction(workerDeps, (await row()).id, 'start')
    await harness.deps
      .db('environment_instances')
      .where({ issueId: issueIds[0] })
      .update({ readyAt: new Date(Date.now() - 2 * 3_600_000) })
    await harness.deps.redis.set(previewKeys.seen((await row()).slug), String(Date.now()))
    await sweepPreviews(workerDeps)
    expect(await row()).toMatchObject({ state: 'ready', lastSeenAt: expect.any(Date) })
    expect((await member.ok('GET', url())).preview.stopsAt).not.toBeNull()
  })

  it('cleans up only its own stack, and stops the services of runs that ended without their worker', async () => {
    const old = new Date(Date.now() - 2 * 3_600_000)
    const { orgId } = await harness.deps.db('projects').where({ id: projectId }).first()
    const agent = await harness.deps.db('agents').first()
    const [run] = await harness.deps
      .db('runs')
      .insert({
        orgId,
        issueId: issueIds[0],
        agentId: agent.accountId,
        agentSnapshot: json({ handle: 'engineer-1' }),
        phase: 'implement',
        state: 'failed',
        runtime: 'scripted',
        model: 'scripted',
      })
      .returning('*')
    await harness.deps.db('environment_instances').insert({
      orgId,
      projectId,
      issueId: issueIds[0],
      runId: run.id,
      kind: 'run',
      slug: 'runservice',
      state: 'ready',
      services: json({ cache: { state: 'ready' } }),
    })
    const removed: string[] = []
    const managed = Object.assign(sandbox, {
      listManaged: async () => ({
        containers: [
          { id: 'ours', kind: 'env', running: true, createdAt: old, envKey: 'leftover01', stack: 'factorix' },
          { id: 'theirs', kind: 'env', running: true, createdAt: old, envKey: 'leftover02', stack: 'other' },
          { id: 'no-stack', kind: 'env', running: true, createdAt: old, envKey: 'leftover03' },
          { id: 'their-step', kind: 'step', running: false, createdAt: old, stack: 'other' },
          { id: 'old-step', kind: 'step', running: false, createdAt: old },
        ],
        volumes: [
          { name: 'fx-envdata-leftover01-db', workspaceKey: '', envKey: 'leftover01', stack: 'factorix' },
          { name: 'fx-envdata-leftover02-db', workspaceKey: '', envKey: 'leftover02', stack: 'other' },
          { name: 'fx-envdata-leftover03-db', workspaceKey: '', envKey: 'leftover03' },
        ],
      }),
      remove: async (id: string) => {
        removed.push(id)
      },
      destroyWorkspace: async () => undefined,
    })
    await reapSandboxes({
      db: harness.deps.db,
      env: { ...harness.deps.env, FACTORIX_STACK: 'factorix' },
      sandbox: managed as unknown as SandboxProvider,
    })
    expect(removed.sort()).toEqual(['old-step', 'ours'])
    expect(sandbox.stopped.map((call) => call.key).sort()).toEqual(['leftover01', 'runservice'])
    expect(sandbox.wiped).toEqual(
      expect.arrayContaining([
        { key: 'runservice', source: false },
        { key: 'leftover01', source: true },
      ]),
    )
    expect(sandbox.wiped).toHaveLength(2)
    expect(await harness.deps.db<EnvironmentInstanceRow>('environment_instances').where({ runId: run.id }).first()).toMatchObject({
      state: 'stopped',
      services: { cache: { state: 'stopped' } },
    })
  })

  it('lets the issue’s agent preview its working copy, follow it, and stop it, acting as itself', async () => {
    await saveEnvironment(SOURCE)
    const { orgId } = await harness.deps.db('projects').where({ id: projectId }).first()
    const agent = await harness.deps.db('agents').first()
    const [run] = await harness.deps
      .db('runs')
      .insert({
        orgId,
        issueId: issueIds[0],
        agentId: agent.accountId,
        agentSnapshot: json({ handle: 'engineer-1' }),
        phase: 'implement',
        state: 'running',
        runtime: 'scripted',
        model: 'scripted',
        containerId: 'agent-container',
      })
      .returning('*')
    const issue = await harness.deps.db('issues').where({ id: issueIds[0] }).first()
    const ask = (op: Parameters<typeof answerPreviewTool>[1]['op'], input: unknown = {}, waitMs = 0) =>
      answerPreviewTool(workerDeps, { run, issue, op, input, waitMs })

    expect(await ask('preview.status')).toMatchObject({ state: 'none' })
    expect(await ask('preview.start')).toMatchObject({ state: 'starting', source: 'worktree' })
    const started = await row()
    expect(started).toMatchObject({ source: 'worktree', startedBy: agent.accountId, secretSets: [] })
    expect(await harness.deps.db('audit_log').where({ action: 'preview.start' }).orderBy('id', 'desc').first()).toMatchObject({
      actorKind: 'agent',
      actorAccountId: agent.accountId,
      metadata: { source: 'worktree' },
    })

    await runPreviewAction(workerDeps, started.id, 'start')
    expect(sandbox.steps.find((step) => step.op === 'export')).toMatchObject({ env: { FX_SOURCE: 'worktree' }, sourceVolume: `fx-ws-${issueIds[0]}` })
    expect(sandbox.steps.find((step) => step.op === 'mirror-fetch')?.sourceVolume).toBeUndefined()
    expect(sandbox.started.find((spec) => spec.service === 'api')?.aliases).toEqual(['api.preview.internal'])
    expect(sandbox.started.find((spec) => spec.service === 'api')?.env.API_KEY).toBeUndefined()
    expect((await member.ok('GET', url())).preview.withoutSecrets).toBe(true)
    expect(await ask('preview.status', { wait: true }, 2000)).toMatchObject({
      state: 'ready',
      reach: { api: 'http://api.preview.internal:3000' },
      routes: { '/': 'api' },
    })
    expect(sandbox.attached).toEqual([{ key: started.slug, containerId: 'agent-container' }])
    expect((await member.ok('GET', url())).preview.source).toBe('worktree')

    await harness.deps.redis.rpush(
      previewKeys.logs(started.slug),
      JSON.stringify({ seq: 1, ts: Date.now(), service: 'api', text: 'listening on 3000' }),
      JSON.stringify({ seq: 2, ts: Date.now(), service: 'db', text: 'ready to accept connections' }),
    )
    expect(await ask('preview.logs', { service: 'api' })).toBe('api: listening on 3000')
    expect(await ask('preview.logs', { lines: 1 })).toBe('db: ready to accept connections')

    await member.ok('POST', url(0, 'refresh'))
    expect((await row()).source).toBe('branch')
    expect(await ask('preview.start')).toMatchObject({ state: 'refreshing', source: 'branch' })
    await runPreviewAction(workerDeps, started.id, 'refresh')
    expect(await ask('preview.start')).toMatchObject({ state: 'refreshing', source: 'worktree' })
    await runPreviewAction(workerDeps, started.id, 'refresh')
    expect(await ask('preview.stop')).toEqual({ state: 'stopping' })
    await expect(ask('preview.start')).rejects.toThrow('stopping')
    await expect(answerPreviewTool(workerDeps, { run, issue: null, op: 'preview.status', input: {} })).rejects.toThrow('has no issue')
  })

  it('keeps the agent away from a preview that has secret values', async () => {
    await saveEnvironment(SOURCE)
    const { orgId } = await harness.deps.db('projects').where({ id: projectId }).first()
    const agent = await harness.deps.db('agents').first()
    const [run] = await harness.deps
      .db('runs')
      .insert({
        orgId,
        issueId: issueIds[0],
        agentId: agent.accountId,
        agentSnapshot: json({ handle: 'engineer-1' }),
        phase: 'implement',
        state: 'running',
        runtime: 'scripted',
        model: 'scripted',
        containerId: 'agent-container',
      })
      .returning('*')
    const issue = await harness.deps.db('issues').where({ id: issueIds[0] }).first()
    const ask = (op: Parameters<typeof answerPreviewTool>[1]['op'], input: unknown = {}, waitMs = 0) =>
      answerPreviewTool(workerDeps, { run, issue, op, input, waitMs })

    await member.ok('POST', url(0, 'start'))
    await runPreviewAction(workerDeps, (await row()).id, 'start')
    expect(sandbox.started.find((spec) => spec.service === 'api')?.env.API_KEY).toBe('doppler-secret-value')
    expect((await member.ok('GET', url())).preview.withoutSecrets).toBe(false)
    await harness.deps.redis.rpush(
      previewKeys.logs((await row()).slug),
      JSON.stringify({ seq: 1, ts: Date.now(), service: 'api', text: 'ZG9wcGxlci1zZWNyZXQ=' }),
    )

    const status = (await ask('preview.status')) as Record<string, unknown>
    expect(status).toMatchObject({ state: 'ready' })
    expect(status.reach).toBeUndefined()
    expect(String(status.next)).toContain('secret values')
    expect(sandbox.attached).toEqual([])
    await expect(ask('preview.logs')).rejects.toThrow('secret values')
    await expect(ask('preview.start')).rejects.toThrow('Call preview_stop first')

    await harness.deps
      .db('environment_instances')
      .where({ issueId: issueIds[0] })
      .update({ state: 'failed', error: 'api exited: ZG9wcGxlci1zZWNyZXQ=' })
    const failed = (await ask('preview.status')) as Record<string, unknown>
    expect(failed).toMatchObject({ state: 'failed' })
    expect(JSON.stringify(failed)).not.toContain('ZG9wcGxlci1zZWNyZXQ=')

    sandbox.started = []
    expect(await ask('preview.start')).toMatchObject({ state: 'starting' })
    expect((await row()).secretSets).toEqual([])
    await runPreviewAction(workerDeps, (await row()).id, 'start')
    expect(sandbox.started.find((spec) => spec.service === 'api')?.env.API_KEY).toBeUndefined()
    expect(await ask('preview.status')).toMatchObject({ state: 'ready', reach: { api: 'http://api.preview.internal:3000' } })
    expect(await ask('preview.logs')).not.toContain('ZG9wcGxlci1zZWNyZXQ=')
  })
})
