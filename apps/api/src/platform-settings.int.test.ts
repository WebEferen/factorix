import { json } from '@factorix/db'
import { PLATFORM_SETTINGS } from '@factorix/schemas'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import type { AppDeps } from './deps'
import { loadEnv } from './env'
import { scmConnectionFor, trackerConnectionFor } from './services/connections'
import { reapSandboxes } from './services/maintenance'
import { readSettings } from './services/settings'
import { TEAM_ID } from './testing/fakes'
import { ApiClient, createHarness, type Harness } from './testing/harness'
import { startWorkers } from './worker'

const HOUR = 3_600_000
const DAY = 24 * HOUR

describe('platform settings and agent accounts', () => {
  let harness: Harness
  let admin: ApiClient
  let member: ApiClient
  let linear: string
  let gitlab: string
  let projectId: string
  let counter = 0

  const settings = async () =>
    (await admin.ok('GET', '/api/settings/general')).settings as { key: string; value: unknown; envValue: unknown; overridden: boolean }[]
  const setting = async (key: string) => (await settings()).find((item) => item.key === key)
  const put = (values: Record<string, unknown>) => admin.request('PUT', '/api/settings/general', { values })

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    await admin.ok('POST', '/api/members', { name: 'Bo', email: 'bo@example.com', password: 'long enough password', role: 'member' })
    member = new ApiClient(harness.app)
    await member.ok('POST', '/api/auth/login', { email: 'bo@example.com', password: 'long enough password' })
    linear = (await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'shared-tracker' })).connection.id
    gitlab = (await admin.ok('POST', '/api/connections', { kind: 'gitlab', name: 'GitLab', secret: 'shared-git', config: {} })).connection.id
    projectId = (
      await admin.ok('POST', '/api/projects', {
        name: 'Platform',
        trackerConnectionId: linear,
        trackerTeamId: TEAM_ID,
        trackerProjectId: null,
        scmConnectionId: gitlab,
        repos: [{ scmRepoId: '42', scmRepoPath: 'g/r', scmCloneUrl: 'https://gitlab.com/g/r.git', defaultBranch: 'main' }],
        stateMap: { in_progress: 'st-progress', in_review: 'st-review', done: 'st-done', blocked: 'st-blocked' },
      })
    ).project.id
  })
  afterAll(() => harness.destroy())
  beforeEach(() => harness.deps.db('platform_settings').delete())

  describe('general settings', () => {
    it('lists every setting with the environment as the default', async () => {
      const all = await settings()
      expect(all.map((item) => item.key)).toEqual(PLATFORM_SETTINGS.map((spec) => spec.key))
      expect(await setting('runConcurrency')).toEqual({ key: 'runConcurrency', value: 3, envValue: 3, overridden: false })
      expect(await setting('allowScriptedRuntime')).toMatchObject({ value: true, envValue: true })
    })

    it('reads each default from its environment variable, and treats an empty one as unset', () => {
      const base = { FACTORIX_SECRET_KEY: 'x' }
      for (const [name, value] of [
        ['FACTORIX_RUN_CONCURRENCY', 7],
        ['FACTORIX_SYNC_INTERVAL_SECONDS', 90],
        ['FACTORIX_CLOSED_ISSUE_DAYS', 5],
        ['FACTORIX_FAILED_WORKSPACE_DAYS', 2],
      ] as const) {
        expect(loadEnv({ ...base, [name]: String(value) })[name]).toBe(value)
        expect(loadEnv({ ...base, [name]: '' })[name]).toBe(loadEnv(base)[name])
      }
      expect(loadEnv(base).FACTORIX_CLEAR_RUN_CACHE).toBe(true)
      expect(loadEnv({ ...base, FACTORIX_CLEAR_RUN_CACHE: 'false' }).FACTORIX_CLEAR_RUN_CACHE).toBe(false)
      expect(() => loadEnv({ ...base, FACTORIX_RUN_CONCURRENCY: '0' })).toThrow(/FACTORIX_RUN_CONCURRENCY/)
    })

    it('lets a saved value override the environment until it is cleared', async () => {
      expect((await put({ runConcurrency: 9 })).status).toBe(200)
      expect(await setting('runConcurrency')).toEqual({ key: 'runConcurrency', value: 9, envValue: 3, overridden: true })
      expect((await readSettings(harness.deps)).runConcurrency).toBe(9)

      await put({ runConcurrency: null })
      expect(await setting('runConcurrency')).toEqual({ key: 'runConcurrency', value: 3, envValue: 3, overridden: false })
    })

    it('falls back to the environment when a stored value is no longer valid', async () => {
      await harness.deps.db('platform_settings').insert({ key: 'runConcurrency', value: JSON.stringify(9999) })
      expect((await readSettings(harness.deps)).runConcurrency).toBe(3)
      expect(await setting('runConcurrency')).toMatchObject({ value: 3, overridden: false })
    })

    it('lets members read but not change them', async () => {
      expect((await member.request('GET', '/api/settings/general')).status).toBe(200)
      expect((await member.request('PUT', '/api/settings/general', { values: { runConcurrency: 9 } })).status).toBe(403)
      expect((await readSettings(harness.deps)).runConcurrency).toBe(3)
    })

    it('refuses values outside the range, and keys it does not know', async () => {
      expect((await put({ runConcurrency: 0 })).status).toBe(422)
      expect((await put({ runConcurrency: 1.5 })).status).toBe(422)
      expect((await put({ publicUrl: 'javascript:alert(1)' })).status).toBe(422)
      expect((await put({ sandboxImage: 'evil/image' })).status).toBe(422)
      expect(await harness.deps.db('platform_settings')).toEqual([])
    })

    it('never exposes the sandbox image, which runs the steps that hold the git token', () => {
      expect(PLATFORM_SETTINGS.map((spec) => spec.env)).not.toContain('FACTORIX_SANDBOX_IMAGE')
    })

    it('records who changed what in the audit log', async () => {
      await put({ failedWorkspaceDays: 2 })
      const row = await harness.deps.db('audit_log').where({ action: 'settings.updated' }).orderBy('ts', 'desc').first()
      expect(row.metadata.values).toEqual({ failedWorkspaceDays: 2 })
      expect(row.actorAccountId).toBeTruthy()
    })

    it('refuses HTTPS-only cookies without an https public URL, so nobody gets locked out', async () => {
      expect((await put({ cookieSecure: true })).status).toBe(400)
      expect((await put({ cookieSecure: true, publicUrl: 'https://factorix.example.com' })).status).toBe(200)
      expect((await put({ publicUrl: 'http://factorix.example.com' })).status).toBe(400)
      expect((await put({ publicUrl: null })).status).toBe(400)
    })

    it('applies cookie and session settings to the next sign-in', async () => {
      await put({ cookieSecure: true, publicUrl: 'https://factorix.example.com', sessionDays: 2 })
      const login = await new ApiClient(harness.app).request('POST', '/api/auth/login', {
        email: 'ada@example.com',
        password: 'correct horse battery',
      })
      const cookie = login.cookies.find((item) => item.name === 'fx_session') as unknown as { secure: boolean; expires: Date }
      expect(cookie.secure).toBe(true)
      expect(Math.abs(cookie.expires.getTime() - (Date.now() + 2 * DAY))).toBeLessThan(60_000)
    })

    it('accepts requests from the saved public URL as well as the environment one', async () => {
      const post = (origin: string) =>
        harness.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin, host: 'internal:4100' },
          payload: { email: 'nobody@example.com', password: 'not the password' },
        })
      expect((await post('https://factorix.example.com')).statusCode).toBe(403)
      expect((await post('http://localhost:4101')).statusCode).not.toBe(403)
      await put({ publicUrl: 'https://factorix.example.com' })
      expect((await post('https://factorix.example.com')).statusCode).not.toBe(403)
      expect((await post('https://elsewhere.example.com')).statusCode).toBe(403)
    })

    it('turns the scripted runtime off for new agents', async () => {
      const archetypeId = (await admin.ok('GET', '/api/archetypes')).archetypes[0].id
      const body = (handle: string) => ({ handle, displayName: handle, archetypeId, runtime: 'scripted', policy: { mode: 'full' } })
      expect((await admin.request('POST', '/api/agents', body('scripted-on'))).status).toBeLessThan(300)
      await put({ allowScriptedRuntime: false })
      const refused = await admin.request('POST', '/api/agents', body('scripted-off'))
      expect(refused.status).toBe(400)
      expect(refused.body.error?.message ?? refused.body.message).toMatch(/Settings, General/)
    })

    it('reaches a running worker without a restart', { timeout: 20_000 }, async () => {
      const deps = { ...harness.deps, timings: { settingsMs: 50 }, sandbox: { listManaged: async () => ({ containers: [], volumes: [] }) } }
      const log: string[] = []
      const worker = startWorkers(deps as unknown as AppDeps & { sandbox: NonNullable<AppDeps['sandbox']> }, {
        prefix: harness.prefix,
        log: (message) => log.push(message),
      })
      try {
        expect(worker.runConcurrency()).toBe(3)
        await put({ runConcurrency: 8, syncIntervalSeconds: 120 })
        await expect.poll(() => worker.runConcurrency(), { timeout: 10_000 }).toBe(8)
        await expect.poll(() => log.join('\n'), { timeout: 10_000 }).toContain('syncing every 120 seconds')
      } finally {
        await worker.close()
      }
    })
  })

  describe('workspace cleanup', () => {
    const destroyed: string[] = []
    let failDestroy = false
    const sandbox = {
      listManaged: async () => ({ containers: [], volumes: [] }),
      remove: async () => undefined,
      destroyWorkspace: async (key: string) => {
        if (failDestroy) throw new Error('volume is in use')
        destroyed.push(key)
      },
    }
    const reap = () => reapSandboxes({ db: harness.deps.db, env: harness.deps.env, sandbox: sandbox as never })

    const workspaceFor = async (factoryState: string, idleMs: number, state = 'ready') => {
      counter += 1
      const { issue } = await admin.ok('POST', `/api/projects/${projectId}/issues`, { title: `Ticket ${counter}` })
      await harness.deps.db('issues').where({ id: issue.id }).update({ factoryState })
      const { orgId } = await harness.deps.db('issues').where({ id: issue.id }).first()
      const [workspace] = await harness.deps
        .db('workspaces')
        .insert({
          orgId,
          issueId: issue.id,
          volumeName: `fx-ws-${issue.id}`,
          mirrorVolumeName: `fx-mirror-${issue.id}`,
          state,
          lastUsedAt: new Date(Date.now() - idleMs),
        })
        .returning('*')
      return { id: workspace.id as string, key: issue.id as string, issueId: issue.id as string }
    }
    const stateOf = async (id: string) => (await harness.deps.db('workspaces').where({ id }).first()).state

    beforeEach(() => {
      destroyed.length = 0
      failDestroy = false
    })

    it('removes a finished issue’s workspace at the next cleanup, and a cancelled one too', async () => {
      const done = await workspaceFor('done', 1000)
      const cancelled = await workspaceFor('cancelled', 1000)
      await reap()
      expect(destroyed).toEqual(expect.arrayContaining([done.key, cancelled.key]))
      expect(await stateOf(done.id)).toBe('expired')
      expect(await stateOf(cancelled.id)).toBe('expired')
    })

    it('keeps a failed issue’s workspace for its limit, since it can hold unpushed work', async () => {
      const recent = await workspaceFor('failed', 6 * DAY)
      const old = await workspaceFor('failed', 8 * DAY)
      await reap()
      expect(destroyed).toContain(old.key)
      expect(destroyed).not.toContain(recent.key)
      expect(await stateOf(recent.id)).toBe('ready')
    })

    it('keeps an open issue’s workspace until it has been idle for its limit', async () => {
      const recent = await workspaceFor('awaiting_merge', 29 * DAY)
      const old = await workspaceFor('awaiting_merge', 31 * DAY)
      await reap()
      expect(destroyed).toContain(old.key)
      expect(destroyed).not.toContain(recent.key)
    })

    const runOn = async (workspace: { id: string; issueId: string }, state: string) => {
      const { orgId } = await harness.deps.db('issues').where({ id: workspace.issueId }).first()
      const agent = await harness.deps.db('agents').first()
      const [run] = await harness.deps
        .db('runs')
        .insert({
          orgId,
          issueId: workspace.issueId,
          agentId: agent.accountId,
          agentSnapshot: json({ handle: 'engineer-1' }),
          workspaceId: workspace.id,
          phase: 'implement',
          state,
          runtime: 'scripted',
          model: 'scripted',
          sessionRef: 'session-on-the-volume',
        })
        .returning('*')
      return run as { id: string }
    }

    it('never touches a workspace with a run still going, however old', async () => {
      for (const state of ['queued', 'preparing', 'running', 'waiting_approval', 'finalizing']) {
        const busy = await workspaceFor('done', 400 * DAY, 'in_use')
        await runOn(busy, state)
        await reap()
        expect(destroyed).not.toContain(busy.key)
        expect(await stateOf(busy.id)).toBe('in_use')
      }
    })

    it('frees a workspace left marked in use after its last run ended', async () => {
      const stuck = await workspaceFor('cancelled', 1000, 'in_use')
      await runOn(stuck, 'cancelled')
      await reap()
      expect(destroyed).toContain(stuck.key)
      expect(await stateOf(stuck.id)).toBe('expired')
    })

    it('leaves the record alone when the volume could not go, so the next cleanup retries', async () => {
      const workspace = await workspaceFor('done', 1000)
      failDestroy = true
      await reap()
      expect(await stateOf(workspace.id)).toBe('ready')
      failDestroy = false
      await reap()
      expect(destroyed).toContain(workspace.key)
      expect(await stateOf(workspace.id)).toBe('expired')
    })

    it('forgets agent sessions stored on the volume, so a later run starts fresh', async () => {
      const workspace = await workspaceFor('done', 1000)
      const run = await runOn(workspace, 'succeeded')
      await reap()
      expect((await harness.deps.db('runs').where({ id: run.id }).first()).sessionRef).toBeNull()
    })

    it('follows the limits saved in settings', async () => {
      await put({ finishedWorkspaceHours: 24, failedWorkspaceDays: 1 })
      const kept = await workspaceFor('done', 12 * HOUR)
      const removed = await workspaceFor('failed', 2 * DAY)
      await reap()
      expect(destroyed).toContain(removed.key)
      expect(destroyed).not.toContain(kept.key)
    })
  })

  describe('agent accounts', () => {
    const newConnection = async (kind: string, name: string, secret: string, config: Record<string, unknown> = {}) =>
      (await admin.ok('POST', '/api/connections', { kind, name, secret, config })).connection as { id: string; accountRole?: string }
    const newAgent = async (connectionIds: string[]) => {
      counter += 1
      const archetypeId = (await admin.ok('GET', '/api/archetypes')).archetypes[0].id
      return admin.request('POST', '/api/agents', {
        handle: `account-${counter}`,
        displayName: `Account ${counter}`,
        archetypeId,
        runtime: 'claude',
        policy: { mode: 'full' },
        connectionIds,
      })
    }
    const db = () => harness.deps.db

    it('marks which connections can be an agent’s account', async () => {
      expect((await newConnection('gitlab', 'Git marker', 's')).accountRole).toBe('scm')
      expect((await newConnection('linear', 'Tracker marker', 's')).accountRole).toBe('tracker')
    })

    it('uses the project’s accounts for an agent with none of its own', async () => {
      const { body } = await newAgent([])
      expect((await scmConnectionFor(db(), gitlab, body.agent.id))?.id).toBe(gitlab)
      expect(
        (await trackerConnectionFor(db(), body.agent.orgId ?? (await db()('connections').where({ id: linear }).first()).orgId, linear, body.agent.id))
          .id,
      ).toBe(linear)
    })

    it('uses an agent’s own accounts when it has them, and keeps other agents on the shared one', async () => {
      const ownGit = await newConnection('gitlab', 'Own git', 'own-git')
      const ownTracker = await newConnection('linear', 'Own tracker', 'own-tracker')
      const { body } = await newAgent([ownGit.id, ownTracker.id])
      const { body: other } = await newAgent([])
      const { orgId } = await db()('connections').where({ id: linear }).first()

      expect((await scmConnectionFor(db(), gitlab, body.agent.id))?.id).toBe(ownGit.id)
      expect((await trackerConnectionFor(db(), orgId, linear, body.agent.id)).id).toBe(ownTracker.id)
      expect((await scmConnectionFor(db(), gitlab, other.agent.id))?.id).toBe(gitlab)
      expect((await scmConnectionFor(db(), gitlab, null))?.id).toBe(gitlab)
      expect(await db()('agent_connections').where({ agentId: body.agent.id }).select('role').orderBy('role')).toEqual([
        { role: 'scm' },
        { role: 'tracker' },
      ])
    })

    it('falls back to the project’s account when the agent’s is on another server, and says so', async () => {
      const elsewhere = await newConnection('gitlab', 'Elsewhere', 'elsewhere', { host: 'https://gitlab.other.example' })
      const { body } = await newAgent([elsewhere.id])
      const warnings: string[] = []
      expect((await scmConnectionFor(db(), gitlab, body.agent.id, (message) => warnings.push(message)))?.id).toBe(gitlab)
      expect(warnings[0]).toContain('Elsewhere')
    })

    it('allows one account of each kind per agent', async () => {
      const first = await newConnection('gitlab', 'First git', 'a')
      const second = await newConnection('gitlab', 'Second git', 'b')
      expect((await newAgent([first.id, second.id])).status).toBe(400)
    })

    it('links an account under its own role, which the lookups for MCP servers and agent-visible secrets skip', async () => {
      const own = await newConnection('gitlab', 'Own git two', 'own-git-two')
      const { body } = await newAgent([own.id])
      const rows = await db()('agent_connections').where({ agentId: body.agent.id })
      expect(rows.map((row: { role: string }) => row.role)).toEqual(['scm'])
    })
  })
})
