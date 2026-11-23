import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { bundledPluginSecret, signPlugin, type TrackerIssue, verifyPlugin } from '@factorix/connectors'
import { json } from '@factorix/db'
import { ISSUE_SORTS, type RuntimeDto } from '@factorix/schemas'
import { definePlugin, factorix } from '@moxxylabs/factorix-plugin-sdk'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { syncBundledPlugins } from './services/bundled-plugins'
import { relayDomainEvents } from './services/relay'
import { refreshRuntimeModels } from './services/runtime-models'
import { FactorixTracker } from './services/tickets'
import { importProject, setTrackerState, syncProjectIssues } from './services/tracker-sync'
import { STATES, TEAM_ID } from './testing/fakes'
import { ApiClient, createHarness, type Harness, issuePayload, sendGitlabWebhook, sendLinearWebhook } from './testing/harness'

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
    redisUrl: string
  }
}

const SETUP = { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' }

describe('API', () => {
  let harness: Harness
  let admin: ApiClient

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    admin = new ApiClient(harness.app)
  })
  afterAll(() => harness.destroy())

  describe('auth', () => {
    it('reports the install as not set up, then bootstraps exactly once', async () => {
      expect((await admin.ok('GET', '/api/auth/status')).setUp).toBe(false)
      const first = await admin.request('POST', '/api/auth/setup', SETUP)
      expect(first.status).toBe(200)
      expect(first.cookies.find((cookie) => cookie.name === 'fx_session')?.httpOnly).toBe(true)
      expect((await admin.ok('GET', '/api/auth/status')).setUp).toBe(true)
      const second = await new ApiClient(harness.app).request('POST', '/api/auth/setup', { ...SETUP, email: 'eve@example.com' })
      expect(second.status).toBe(409)
    })

    it('seeds the default agents, skill, and pipeline', async () => {
      const { agents } = await admin.ok('GET', '/api/agents')
      expect(agents.map((agent: { handle: string }) => agent.handle)).toEqual(['engineer-1', 'reviewer-1'])
      expect(agents[0].skillIds).toHaveLength(1)
      expect(agents[1].policy.mode).toBe('read_only')
    })

    it('rejects unauthenticated requests', async () => {
      const anon = new ApiClient(harness.app)
      for (const url of ['/api/agents', '/api/issues', '/api/runs', '/api/connections', '/api/audit', '/api/inbox', '/api/spend']) {
        expect((await anon.request('GET', url)).status, url).toBe(401)
      }
    })

    it('rejects a wrong password with the same error as an unknown account', async () => {
      const anon = new ApiClient(harness.app)
      const wrong = await anon.request('POST', '/api/auth/login', { email: SETUP.email, password: 'nope' })
      const unknown = await anon.request('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'nope' })
      expect(wrong.status).toBe(401)
      expect(unknown.body).toEqual(wrong.body)
    })

    it('logs in case-insensitively and ends the session on logout', async () => {
      const client = new ApiClient(harness.app)
      await client.ok('POST', '/api/auth/login', { email: 'ADA@example.com', password: SETUP.password })
      expect((await client.ok('GET', '/api/auth/me')).account.handle).toBe('ada')
      await client.ok('POST', '/api/auth/logout')
      expect((await client.request('GET', '/api/auth/me')).status).toBe(401)
    })

    it('never returns password hashes', async () => {
      expect(JSON.stringify(await admin.ok('GET', '/api/members'))).not.toMatch(/passwordHash|argon2/)
    })

    it('lets an API token act as its account, short of admin actions and other tokens', async () => {
      const created = await admin.ok('POST', '/api/tokens', { name: 'laptop' })
      expect(created.secret).toMatch(/^fxp_/)
      expect(created.token.prefix).toBe(created.secret.slice(0, 8))
      expect(JSON.stringify(await admin.ok('GET', '/api/tokens'))).not.toContain(created.secret)

      const cli = new ApiClient(harness.app)
      cli.token = created.secret
      expect((await cli.ok('GET', '/api/auth/me')).account.handle).toBe('ada')
      expect((await cli.ok('GET', '/api/tokens')).tokens[0].lastUsedAt).not.toBeNull()
      expect((await cli.request('POST', '/api/tokens', { name: 'second' })).status).toBe(403)
      expect((await cli.request('DELETE', `/api/tokens/${created.token.id}`)).status).toBe(403)
      expect((await cli.request('POST', '/api/connections', { kind: 'linear', name: 'x', secret: 'y' })).status).toBe(403)

      const wrong = new ApiClient(harness.app)
      wrong.cookie = admin.cookie
      wrong.token = 'fxp_not-a-real-token'
      expect((await wrong.request('GET', '/api/auth/me')).status).toBe(401)

      const expired = await admin.ok('POST', '/api/tokens', { name: 'short', expiresInDays: 1 })
      await harness.deps
        .db('api_tokens')
        .where({ id: expired.token.id })
        .update({ expiresAt: new Date(Date.now() - 1000) })
      cli.token = expired.secret
      expect((await cli.request('GET', '/api/auth/me')).status).toBe(401)

      expect((await admin.request('DELETE', `/api/tokens/${created.token.id}`)).status).toBe(200)
      cli.token = created.secret
      expect((await cli.request('GET', '/api/auth/me')).status).toBe(401)
    })

    it('lets a token change only what its scopes name, and nothing a route does not open to tokens', async () => {
      const NOBODY = '00000000-0000-4000-8000-000000000000'
      const withScopes = async (scopes?: string[]) => {
        const created = await admin.ok('POST', '/api/tokens', { name: `scoped ${scopes?.join(' ') ?? 'default'}`, scopes })
        const client = new ApiClient(harness.app)
        client.token = created.secret
        return { client, token: created.token }
      }
      const code = async (client: ApiClient, method: 'POST' | 'PUT', url: string, body: unknown = {}) => {
        const response = await client.request(method, url, body)
        return `${response.status} ${response.body?.error?.code ?? ''}`.trim()
      }

      const standard = await withScopes()
      expect(standard.token.scopes).toEqual(['runs', 'issues', 'approvals'])
      expect(await code(standard.client, 'POST', '/api/runs')).toBe('422 validation_failed')
      expect(await code(standard.client, 'POST', `/api/issues/${NOBODY}/instructions`, { body: 'x' })).toBe('404 not_found')
      expect(await code(standard.client, 'POST', `/api/issues/${NOBODY}/preview/open`)).toBe('403 scope_required')
      expect(await code(standard.client, 'POST', `/api/issues/${NOBODY}/preview/start`)).toBe('403 scope_required')
      expect(await code(standard.client, 'POST', '/api/agents')).toBe('403 session_required')
      expect(await code(standard.client, 'POST', '/api/auth/logout')).toBe('403 session_required')

      const previews = await withScopes(['previews', 'previews'])
      expect(previews.token.scopes).toEqual(['previews'])
      expect(await code(previews.client, 'POST', `/api/issues/${NOBODY}/preview/open`)).toBe('404 not_found')
      expect(await code(previews.client, 'POST', '/api/runs')).toBe('403 scope_required')
      expect(await code(previews.client, 'POST', `/api/approvals/${NOBODY}/decide`, { decision: 'approved' })).toBe('403 scope_required')

      const reader = await withScopes([])
      expect(reader.token.scopes).toEqual([])
      expect((await reader.client.ok('GET', '/api/agents')).agents.length).toBeGreaterThan(0)
      expect(await code(reader.client, 'POST', '/api/runs')).toBe('403 scope_required')

      expect((await admin.request('POST', '/api/tokens', { name: 'bad', scopes: ['admin'] })).status).toBe(422)
      expect((await admin.request('POST', `/api/issues/${NOBODY}/preview/open`, {})).status).toBe(404)
    })

    it('limits admin actions to admins', async () => {
      await admin.ok('POST', '/api/members', { name: 'Bo', email: 'bo@example.com', password: 'long enough password', role: 'member' })
      const member = new ApiClient(harness.app)
      await member.ok('POST', '/api/auth/login', { email: 'bo@example.com', password: 'long enough password' })
      expect((await member.request('POST', '/api/connections', { kind: 'linear', name: 'x', secret: 'y' })).status).toBe(403)
      expect((await member.request('POST', '/api/members', { name: 'C', email: 'c@example.com', password: 'long enough password' })).status).toBe(403)
    })

    it('refuses cross-origin writes but allows webhooks', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: 'https://evil.example', host: 'factorix.example' },
        payload: { email: SETUP.email, password: SETUP.password },
      })
      expect(response.statusCode).toBe(403)
      const sandboxed = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { origin: 'null', host: 'factorix.example' },
      })
      expect(sandboxed.statusCode).toBe(403)
    })
  })

  describe('runtime models', () => {
    const opus = { id: 'claude-opus-5-5', label: 'Opus 5.5', description: 'Everyday', efforts: ['low', 'max'] as ('low' | 'max')[] }
    const claude = async () => {
      const { body } = await admin.request('GET', '/api/runtimes')
      return (body as { runtimes: RuntimeDto[] }).runtimes.find((item) => item.id === 'claude')
    }

    it('offers no models until the worker has listed them', async () => {
      expect((await claude())?.models).toEqual([])
      expect((await claude())?.defaultModel).toBe('claude-opus-5-5')
    })

    it('serves what the SDKs reported and replaces it on the next refresh', async () => {
      const listRuntimeModels = vi.fn().mockResolvedValueOnce({ claude: { defaultModel: 'claude-opus-5-5', models: [opus] } })
      await refreshRuntimeModels({ db: harness.deps.db, sandbox: { listRuntimeModels } })
      expect((await claude())?.models).toEqual([opus])

      listRuntimeModels.mockResolvedValueOnce({ claude: { defaultModel: 'claude-next', models: [{ ...opus, id: 'claude-next' }] } })
      await refreshRuntimeModels({ db: harness.deps.db, sandbox: { listRuntimeModels } })
      expect((await claude())?.defaultModel).toBe('claude-next')
      expect((await claude())?.models.map((model) => model.id)).toEqual(['claude-next'])
    })

    it('keeps the last list when a runtime fails to report', async () => {
      await refreshRuntimeModels({ db: harness.deps.db, sandbox: { listRuntimeModels: async () => ({}) } })
      expect((await claude())?.models.map((model) => model.id)).toEqual(['claude-next'])
    })
  })

  describe('agents', () => {
    let agent: Record<string, unknown>
    beforeAll(async () => {
      const { archetypes } = await admin.ok('GET', '/api/archetypes')
      const archetypeId = archetypes.find((item: { name: string }) => item.name === 'Engineer').id
      agent = { handle: 'engineer-2', displayName: 'Engineer Two', archetypeId, runtime: 'claude', policy: { mode: 'full' } }
    })

    it('creates an agent with a capability snapshot and an audit row', async () => {
      const created = (await admin.ok('POST', '/api/agents', agent)).agent
      expect(created.capabilities.toolApproval).toBe('per_call')
      const { entries } = await admin.ok('GET', `/api/audit?targetType=agent&targetId=${created.id}`)
      expect(entries[0]).toMatchObject({ action: 'agent.created', actorName: 'Ada', actorKind: 'human' })
    })

    it('rejects a duplicate handle and a bad handle', async () => {
      expect((await admin.request('POST', '/api/agents', agent)).status).toBe(409)
      expect((await admin.request('POST', '/api/agents', { ...agent, handle: 'Not Valid' })).status).toBe(422)
    })

    it('refuses per-tool approval rules on a runtime that cannot honor them', async () => {
      const response = await admin.request('POST', '/api/agents', {
        ...agent,
        handle: 'codex-1',
        runtime: 'codex',
        policy: { mode: 'full', requireApproval: ['Bash'] },
      })
      expect(response.status).toBe(400)
      expect(response.body.error.message).toContain('cannot pause')
    })

    it('keeps an agent’s helpers on every runtime that can run them', async () => {
      const helper = { name: 'code-search', description: 'Finds code', prompt: 'Search and answer with paths.', model: 'claude-haiku-5-5' }
      const created = (await admin.ok('POST', '/api/agents', { ...agent, handle: 'lead-1', helpers: [helper] })).agent
      expect(created.helpers).toEqual([{ ...helper, access: 'read' }])
      const row = await harness.deps.db('agents').where({ accountId: created.id }).first()
      expect(row.helpers).toEqual(created.helpers)

      const twice = await admin.request('POST', '/api/agents', { ...agent, handle: 'lead-2', helpers: [helper, helper] })
      expect(twice.status).toBe(422)
      expect(JSON.stringify(twice.body)).toContain('share a name')
      const codex = (await admin.ok('POST', '/api/agents', { ...agent, handle: 'lead-3', runtime: 'codex', helpers: [helper] })).agent
      expect(codex.helpers).toHaveLength(1)
      await harness.deps.db('accounts').where({ id: codex.id }).delete()
      expect((await admin.ok('PUT', `/api/agents/${created.id}`, { ...agent, handle: 'lead-1' })).agent.helpers).toEqual([])
      await harness.deps.db('accounts').where({ id: created.id }).delete()
    })

    it('bumps the version on update', async () => {
      const { agents } = await admin.ok('GET', '/api/agents')
      const target = agents.find((candidate: { handle: string }) => candidate.handle === 'engineer-2')
      const updated = (await admin.ok('PUT', `/api/agents/${target.id}`, { ...agent, description: 'Now with notes' })).agent
      expect(updated.version).toBe(2)
    })
  })

  describe('connections', () => {
    let linearId: string
    let gitlabId: string
    let linearSecret: string
    let foreignLinearId: string
    let gitlabSecret: string
    let projectId: string

    it('stores secrets encrypted and never returns them', async () => {
      const created = await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'lin_api_supersecret' })
      linearId = created.connection.id
      linearSecret = created.connection.webhookSecret
      expect(created.connection.hasSecret).toBe(true)
      expect(JSON.stringify(created)).not.toContain('supersecret')
      const row = await harness.deps.db('connections').where({ id: linearId }).first()
      expect(row.secretCiphertext.toString('utf8')).not.toContain('supersecret')
      expect(harness.deps.secrets.decrypt({ ciphertext: row.secretCiphertext, nonce: row.secretNonce })).toBe('lin_api_supersecret')
      expect(JSON.stringify(await admin.ok('GET', '/api/connections'))).not.toContain('supersecret')
    })

    it('hides the webhook secret from non-admins', async () => {
      const member = new ApiClient(harness.app)
      await member.ok('POST', '/api/auth/login', { email: 'bo@example.com', password: 'long enough password' })
      const { connections } = await member.ok('GET', '/api/connections')
      expect(connections[0].webhookSecret).toBeNull()
      expect(connections[0].egressHosts).toEqual([])
    })

    it('lets admins define the network allowlist, members read it, and records who changed it', async () => {
      const member = new ApiClient(harness.app)
      await member.ok('POST', '/api/auth/login', { email: 'bo@example.com', password: 'long enough password' })
      expect((await new ApiClient(harness.app).request('GET', '/api/settings/network')).status).toBe(401)
      expect((await member.ok('GET', '/api/settings/network')).network).toEqual({ mode: 'extend', hosts: [] })
      expect((await member.request('PUT', '/api/settings/network', { mode: 'replace', hosts: [] })).status).toBe(403)
      expect((await admin.request('PUT', '/api/settings/network', { mode: 'extend', hosts: ['https://gitlab.com'] })).status).toBe(422)
      expect((await admin.request('PUT', '/api/settings/network', { mode: 'open', hosts: [] })).status).toBe(422)

      const { network } = await admin.ok('PUT', '/api/settings/network', { mode: 'replace', hosts: ['Nexus.Acme.dev', 'nexus.acme.dev'] })
      expect(network).toEqual({ mode: 'replace', hosts: ['nexus.acme.dev'] })
      expect((await member.ok('GET', '/api/settings/network')).network).toEqual(network)

      const { entries } = await admin.ok('GET', '/api/audit?targetType=organization')
      const changes = entries.filter((entry: { action: string }) => entry.action === 'network.updated')
      expect(changes.map((entry: { metadata: unknown }) => entry.metadata)).toEqual([{ mode: 'replace', hosts: ['nexus.acme.dev'] }])
      await admin.ok('PUT', '/api/settings/network', { mode: 'extend', hosts: [] })
    })

    it('tests a connection through its connector', async () => {
      const created = await admin.ok('POST', '/api/connections', {
        kind: 'gitlab',
        name: 'GitLab',
        secret: 'glpat-x',
        config: { host: 'https://gitlab.com' },
      })
      gitlabId = created.connection.id
      expect(created.connection.egressHosts).toEqual(['gitlab.com'])
      gitlabSecret = created.connection.webhookSecret
      expect(await admin.ok('POST', `/api/connections/${gitlabId}/test`)).toEqual({ ok: true, message: 'Connected to GitLab as bot' })
      expect((await admin.ok('GET', `/api/tracker/teams?connectionId=${linearId}`)).teams[0].key).toBe('ABC')
      expect((await admin.ok('GET', `/api/scm/repos?connectionId=${gitlabId}`)).repos[0].path).toBe('g/r')
    })

    it('creates a project, makes one agent label each, and imports existing issues', async () => {
      harness.world.addIssue({ title: 'Already there' })
      const readsBefore = harness.world.issuePagesRead
      const { project } = await admin.ok('POST', '/api/projects', {
        name: 'Web app',
        trackerConnectionId: linearId,
        trackerTeamId: TEAM_ID,
        scmConnectionId: gitlabId,
        repos: [{ scmRepoId: '42', scmRepoPath: 'g/r', scmCloneUrl: 'https://gitlab.com/g/r.git', defaultBranch: 'main' }],
        stateMap: { in_progress: 'st-progress', in_review: 'st-review', done: 'st-done', blocked: 'st-blocked' },
      })
      projectId = project.id
      expect(project.syncState).toBe('syncing')
      expect(project.issueCount).toBe(0)
      expect(harness.world.issuePagesRead).toBe(readsBefore)

      await relayDomainEvents(harness.deps)
      expect((await harness.deps.queues.projectSync.getJobs(['waiting'])).map((job) => job.data.projectId)).toContain(projectId)
      await importProject(harness.deps, projectId)

      const { project: imported } = await admin.ok('GET', `/api/projects/${projectId}`)
      expect(imported.syncState).toBe('idle')
      expect(imported.lastSyncedAt).not.toBeNull()
      expect(Object.keys(imported.agentLabels).sort()).toEqual(['engineer-1', 'engineer-2', 'reviewer-1'])
      expect(harness.world.labels.find((label) => label.isGroup)?.name).toBe('Agent')
      expect(imported.issueCount).toBe(1)
    })

    it('changes only the fields an update names', async () => {
      const before = (await admin.ok('GET', `/api/projects/${projectId}`)).project
      const { project } = await admin.ok('PUT', `/api/projects/${projectId}`, { autonomy: 'full_auto' })
      expect(project.autonomy).toBe('full_auto')
      expect(project.stateMap).toEqual(before.stateMap)
      expect(project.trigger).toEqual(before.trigger)
      await admin.ok('PUT', `/api/projects/${projectId}`, { autonomy: before.autonomy })

      const { connection } = await admin.ok('PUT', `/api/connections/${gitlabId}`, { name: 'Renamed' })
      expect(connection.config).toEqual({ host: 'https://gitlab.com' })
      expect(connection.hasSecret).toBe(true)
    })

    it("refuses to point a project at another organization's connection", async () => {
      const { db } = harness.deps
      const [org] = await db('organizations').insert({ name: 'Other', slug: 'other' }).returning('id')
      const [foreign] = await db('connections')
        .insert({ orgId: org.id, kind: 'linear', name: 'Theirs', config: JSON.stringify({ webhookSecret: 'their-secret' }) })
        .returning('id')
      foreignLinearId = foreign.id
      expect((await admin.request('PUT', `/api/projects/${projectId}`, { trackerConnectionId: foreignLinearId })).status).toBe(404)
      expect((await admin.request('PUT', `/api/projects/${projectId}`, { scmConnectionId: foreignLinearId })).status).toBe(404)
      expect(await db('projects').where({ id: projectId }).first()).toMatchObject({ trackerConnectionId: linearId, scmConnectionId: gitlabId })
    })

    it('registers webhooks on both systems', async () => {
      const { results } = await admin.ok('POST', `/api/projects/${projectId}/webhooks`)
      expect(results.map((result: { registered: boolean }) => result.registered)).toEqual([true, true])
      expect(harness.world.webhooksRegistered).toEqual([
        `http://localhost:4101/webhooks/linear/${linearId}`,
        `http://localhost:4101/webhooks/gitlab/${gitlabId}`,
      ])
    })

    describe('issues', () => {
      it('creates an issue in the tracker and mirrors it', async () => {
        const { issue } = await admin.ok('POST', `/api/projects/${projectId}/issues`, { title: 'From the UI' })
        expect(issue.identifier).toMatch(/^ABC-/)
        expect([...harness.world.issues.values()].some((candidate) => candidate.title === 'From the UI')).toBe(true)
        expect(issue.factoryState).toBe('untracked')
      })

      it('shows the new tracker state as soon as the factory writes it, with no webhook needed', async () => {
        const { issue } = await admin.ok('POST', `/api/projects/${projectId}/issues`, { title: 'State mirror' })
        await setTrackerState(harness.deps, { issueId: issue.id, key: 'in_review' })
        const { issue: shown } = await admin.ok('GET', `/api/issues/${issue.id}`)
        expect(shown.trackerStateName).toBe('In Review')
        expect(shown.trackerStateType).toBe('started')
      })

      it('rejects a webhook with a bad signature and accepts a good one once', async () => {
        const issue = harness.world.addIssue({ title: 'Via webhook' })
        const payload = issuePayload(issue, 'create')
        expect((await sendLinearWebhook(harness.app, linearId, 'wrong-secret', payload)).statusCode).toBe(401)
        expect((await sendLinearWebhook(harness.app, linearId, linearSecret, payload, 'd1')).statusCode).toBe(200)
        const duplicate = await sendLinearWebhook(harness.app, linearId, linearSecret, payload, 'd1')
        expect(duplicate.json()).toEqual({ ok: true, duplicate: true })
        expect(await harness.deps.db('webhook_deliveries').where({ deliveryId: 'd1' })).toHaveLength(1)
        expect(await harness.deps.queues.trackerInbound.getJobCounts('waiting')).toEqual({ waiting: 1 })
      })

      it('keeps a delivery id that another connection has already used', async () => {
        const payload = issuePayload(harness.world.addIssue({ title: 'Same id, other organization' }), 'create')
        const response = await sendLinearWebhook(harness.app, foreignLinearId, 'their-secret', payload, 'd1')
        expect(response.json()).toEqual({ ok: true, duplicate: false })
        const [row] = await harness.deps.db('webhook_deliveries').where({ deliveryId: 'd1', connectionId: foreignLinearId })
        await harness.deps.queues.trackerInbound.remove(`linear-${row.id}`)
      })

      it('verifies GitLab webhooks with the shared token', async () => {
        expect((await sendGitlabWebhook(harness.app, gitlabId, 'wrong', 'Note Hook', { object_kind: 'note' })).statusCode).toBe(401)
        expect((await sendGitlabWebhook(harness.app, gitlabId, gitlabSecret, 'Note Hook', { object_kind: 'note' })).statusCode).toBe(200)
      })

      it('verifies GitHub webhooks by their signature and queues them with their source', async () => {
        const { connection } = await admin.ok('POST', '/api/connections', { kind: 'github', name: 'GitHub', config: {}, secret: 'ghp_test' })
        expect(connection).toMatchObject({ accountRole: 'scm', webhookUrl: `http://localhost:4101/webhooks/github/${connection.id}` })
        const body = JSON.stringify({ action: 'opened', repository: { id: 42 }, pull_request: { number: 1 } })
        const send = (secret: string) =>
          harness.app.inject({
            method: 'POST',
            url: `/webhooks/github/${connection.id}`,
            payload: body,
            headers: {
              'content-type': 'application/json',
              'x-github-event': 'pull_request',
              'x-github-delivery': 'gh-1',
              'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
            },
          })
        expect((await send('wrong')).statusCode).toBe(401)
        expect((await send(connection.webhookSecret)).json()).toEqual({ ok: true, duplicate: false })
        const [row] = await harness.deps.db('webhook_deliveries').where({ connectionId: connection.id })
        expect(row).toMatchObject({ source: 'github', eventType: 'pull_request' })
        const job = await harness.deps.queues.scmInbound.getJob(`github-${row.id}`)
        expect(job?.data).toMatchObject({ source: 'github', headers: { 'x-github-event': 'pull_request' } })
        await job?.remove()
      })

      it('takes Jira and Trello webhooks, each signed its own way', async () => {
        const jira = (
          await admin.ok('POST', '/api/connections', { kind: 'jira', name: 'Jira', config: { host: 'https://acme.atlassian.net' }, secret: 't' })
        ).connection
        expect(jira).toMatchObject({ accountRole: 'tracker', webhookUrl: `http://localhost:4101/webhooks/jira/${jira.id}` })
        const jiraBody = JSON.stringify({ webhookEvent: 'jira:issue_deleted', issue: { id: '10001' } })
        const sendJira = (secret: string) =>
          harness.app.inject({
            method: 'POST',
            url: `/webhooks/jira/${jira.id}`,
            payload: jiraBody,
            headers: {
              'content-type': 'application/json',
              'x-hub-signature': `sha256=${createHmac('sha256', secret).update(jiraBody).digest('hex')}`,
            },
          })
        expect((await sendJira('wrong')).statusCode).toBe(401)
        expect((await sendJira(jira.webhookSecret)).json()).toEqual({ ok: true, duplicate: false })
        const [jiraRow] = await harness.deps.db('webhook_deliveries').where({ connectionId: jira.id })
        expect(jiraRow).toMatchObject({ source: 'jira', eventType: 'jira:issue_deleted' })
        const jiraJob = await harness.deps.queues.trackerInbound.getJob(`jira-${jiraRow.id}`)
        expect(jiraJob?.data).toMatchObject({ source: 'jira' })
        await jiraJob?.remove()

        const config = { apiKey: 'key', webhookSecret: 'api-secret' }
        const trello = (await admin.ok('POST', '/api/connections', { kind: 'trello', name: 'Trello', config, secret: 't' })).connection
        expect((await harness.app.inject({ method: 'HEAD', url: `/webhooks/trello/${trello.id}` })).statusCode).toBe(200)
        const trelloBody = JSON.stringify({ action: { id: 'a1', type: 'deleteCard', data: { card: { id: 'c1' } } } })
        const sendTrello = (url: string) =>
          harness.app.inject({
            method: 'POST',
            url: `/webhooks/trello/${trello.id}`,
            payload: trelloBody,
            headers: {
              'content-type': 'application/json',
              'x-trello-webhook': createHmac('sha1', 'api-secret').update(`${trelloBody}${url}`).digest('base64'),
            },
          })
        expect((await sendTrello('https://elsewhere.example/hook')).statusCode).toBe(401)
        expect((await sendTrello(trello.webhookUrl)).json()).toEqual({ ok: true, duplicate: false })
        const trelloJob = await harness.deps.queues.trackerInbound.getJob(
          `trello-${(await harness.deps.db('webhook_deliveries').where({ connectionId: trello.id }).first()).id}`,
        )
        expect(trelloJob?.data).toMatchObject({ source: 'trello' })
        await trelloJob?.remove()
      })

      it('installs a plugin, turns it on, opens its page, and uses its tracker', async () => {
        const secret = 'plugin-secret-0123456789'
        const calls: { method: string; connection: { config: Record<string, string>; secrets: Record<string, string> } | null }[] = []
        const manifest = {
          protocol: 1,
          name: 'Acme board',
          version: '1.0.0',
          provides: ['tracker'],
          connection: {
            fields: [
              { key: 'site', label: 'Site', type: 'url', required: true },
              { key: 'token', label: 'Token', type: 'secret' },
            ],
          },
          settings: {
            fields: [
              { key: 'region', label: 'Region', type: 'text' },
              { key: 'apiKey', label: 'API key', type: 'secret' },
            ],
          },
          pages: [{ key: 'reports', label: 'Reports', path: '/pages/reports', placement: 'sidebar' }],
        }
        const server = createServer((req, res) => {
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('end', () => {
            const raw = Buffer.concat(chunks)
            const signed = verifyPlugin(secret, String(req.headers['x-factorix-timestamp']), String(req.headers['x-factorix-signature']), raw)
            const call = JSON.parse(raw.toString('utf8'))
            calls.push(call)
            const result =
              call.method === 'manifest'
                ? manifest
                : call.method === 'tracker.viewer'
                  ? { id: 'u1', name: 'Board bot', email: null }
                  : [{ id: 't1', key: 'ACME', name: 'Acme' }]
            res.writeHead(signed ? 200 : 401, { 'content-type': 'application/json' })
            res.end(JSON.stringify(signed ? { result } : { error: { message: 'bad signature' } }))
          })
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/factorix`
        try {
          expect((await admin.request('POST', '/api/plugins', { url, secret: 'the-wrong-secret-0000' })).status).toBe(400)
          const { plugin } = await admin.ok('POST', '/api/plugins', { url, secret })
          expect(plugin).toMatchObject({
            name: 'Acme board',
            enabled: false,
            url,
            pages: [{ key: 'reports', label: 'Reports', placement: 'sidebar' }],
          })
          expect((await admin.ok('GET', '/api/plugins/origins')).origins).toContain(new URL(url).origin)

          const connect = {
            kind: 'plugin',
            name: 'Acme',
            config: { pluginId: plugin.id, site: 'https://acme.example', other: 'x' },
            secret: { token: 't0k' },
          }
          expect((await admin.request('POST', '/api/connections', connect)).status).toBe(400)
          const on = await admin.ok('PUT', `/api/plugins/${plugin.id}/organization`, { enabled: true, settings: { region: 'eu', apiKey: 'k1' } })
          expect(on.plugin).toMatchObject({ enabled: true, settings: { region: 'eu' }, secretSettings: ['apiKey'] })
          const kept = await admin.ok('PUT', `/api/plugins/${plugin.id}/organization`, { enabled: true, settings: { region: 'us' } })
          expect(kept.plugin).toMatchObject({ settings: { region: 'us' }, secretSettings: ['apiKey'] })

          const page = await admin.ok('POST', `/api/plugins/${plugin.id}/pages/reports/open`)
          const opened = new URL(page.url)
          expect(opened.origin + opened.pathname).toBe(`${url}/pages/reports`)
          const [payload, signature] = String(opened.searchParams.get('factorix')).split('.')
          expect(signature).toBe(createHmac('sha256', secret).update(String(payload)).digest('hex'))
          expect(JSON.parse(Buffer.from(String(payload), 'base64url').toString())).toMatchObject({
            page: 'reports',
            account: { role: 'admin' },
            settings: { region: 'us' },
          })

          const { connection } = await admin.ok('POST', '/api/connections', connect)
          expect(connection).toMatchObject({ accountRole: 'tracker', hasSecret: true, config: { pluginId: plugin.id, site: 'https://acme.example' } })
          expect(connection.config.other).toBeUndefined()
          expect((await admin.ok('POST', `/api/connections/${connection.id}/test`)).message).toBe('Connected to the plugin as Board bot')
          expect(calls.at(-1)).toMatchObject({
            method: 'tracker.viewer',
            connection: { config: { site: 'https://acme.example' }, secrets: { token: 't0k' } },
          })
          expect((await admin.ok('GET', `/api/tracker/teams?connectionId=${connection.id}`)).teams).toEqual([{ id: 't1', key: 'ACME', name: 'Acme' }])

          const send = (path: string, body: string, key: string) => {
            const timestamp = String(Date.now())
            return harness.app.inject({
              method: 'POST',
              url: path,
              payload: body,
              headers: {
                'content-type': 'application/json',
                'x-factorix-timestamp': timestamp,
                'x-factorix-signature': signPlugin(key, timestamp, body),
              },
            })
          }
          const event = JSON.stringify({ event: { kind: 'issue.removed', issueId: 'i1' } })
          expect((await send(`/webhooks/plugin/${connection.id}`, event, 'another-secret-000000')).statusCode).toBe(401)
          expect((await send(`/webhooks/plugin/${connection.id}`, event, secret)).json()).toEqual({ ok: true, duplicate: false })
          const row = await harness.deps.db('webhook_deliveries').where({ connectionId: connection.id }).first()
          expect(row).toMatchObject({ source: 'plugin', eventType: 'issue.removed' })
          await (await harness.deps.queues.trackerInbound.getJob(`plugin-${row.id}`))?.remove()

          const { org } = await admin.ok('GET', '/api/auth/me')
          const ask = JSON.stringify({ orgId: org.id })
          expect((await send(`/webhooks/plugins/${plugin.id}/settings`, ask, 'another-secret-000000')).statusCode).toBe(401)
          expect((await send(`/webhooks/plugins/${plugin.id}/settings`, ask, secret)).json()).toEqual({
            settings: { region: 'us' },
            secrets: { apiKey: 'k1' },
          })

          expect((await admin.request('PUT', `/api/plugins/${plugin.id}/organization`, { enabled: false })).status).toBe(409)
          expect((await admin.request('DELETE', `/api/plugins/${plugin.id}`)).status).toBe(409)
        } finally {
          await new Promise((resolve) => server.close(resolve))
        }
      })

      it('answers a plugin only with what the organization allowed it', async () => {
        const secret = 'access-secret-0123456789'
        const manifest = {
          protocol: 1,
          name: 'Reporter',
          version: '1.0.0',
          provides: [],
          permissions: ['activity:read'],
          connection: { fields: [] },
          settings: { fields: [] },
          pages: [{ key: 'home', label: 'Home', path: '/pages/home', placement: 'sidebar' }],
        }
        const server = createServer((req, res) => {
          req.resume()
          req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ result: manifest }))
          })
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/factorix`
        const send = (path: string, payload: unknown, key = secret) => {
          const body = JSON.stringify(payload)
          const timestamp = String(Date.now())
          return harness.app.inject({
            method: 'POST',
            url: path,
            payload: body,
            headers: {
              'content-type': 'application/json',
              'x-factorix-timestamp': timestamp,
              'x-factorix-signature': signPlugin(key, timestamp, body),
            },
          })
        }
        try {
          const { plugin } = await admin.ok('POST', '/api/plugins', { url, secret })
          expect(plugin.permissions).toEqual([{ id: 'activity:read', description: expect.stringContaining('tickets'), granted: false }])
          const { org } = await admin.ok('GET', '/api/auth/me')
          const since = new Date(Date.now() - 86_400_000).toISOString()
          const activityPath = `/webhooks/plugins/${plugin.id}/activity`
          expect((await send(activityPath, { orgId: org.id, since })).statusCode).toBe(404)

          await admin.ok('PUT', `/api/plugins/${plugin.id}/organization`, { enabled: true })
          const issue = await harness.deps.db('issues').where({ orgId: org.id }).orderBy('createdAt').first()
          await harness.deps
            .db('issues')
            .where({ id: issue.id })
            .update({ assigneeName: 'Grace', assigneeTrackerId: 'u-grace', trackerStateType: 'started' })
          expect((await send(activityPath, { orgId: org.id, since }, 'another-secret-000000')).statusCode).toBe(401)
          const read = await send(activityPath, { orgId: org.id, since })
          expect(read.statusCode).toBe(200)
          expect(read.json().activity.issues).toContainEqual(
            expect.objectContaining({ identifier: issue.identifier, assignee: { id: 'u-grace', name: 'Grace' }, statusType: 'started' }),
          )
          const tooOld = new Date(Date.now() - 40 * 86_400_000).toISOString()
          expect((await send(activityPath, { orgId: org.id, since: tooOld })).statusCode).toBe(400)

          const agentsPath = `/webhooks/plugins/${plugin.id}/agents`
          expect((await send(agentsPath, { orgId: org.id })).statusCode).toBe(403)
          manifest.permissions = ['activity:read', 'agents:run']
          const refreshed = (await admin.ok('POST', `/api/plugins/${plugin.id}/refresh`)).plugin
          expect(refreshed.permissions.map((permission: { granted: boolean }) => permission.granted)).toEqual([true, false])
          expect((await send(agentsPath, { orgId: org.id })).statusCode).toBe(403)
          await admin.ok('PUT', `/api/plugins/${plugin.id}/organization`, { enabled: true })
          const { agents } = (await send(agentsPath, { orgId: org.id })).json()
          const engineer = agents.find((agent: { handle: string }) => agent.handle === 'engineer-1')
          expect(engineer).toMatchObject({ status: 'active', runtime: expect.any(String) })

          const runsPath = `/webhooks/plugins/${plugin.id}/runs`
          const outputSchema = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } }
          expect((await send(runsPath, { orgId: org.id, agentId: engineer.id, prompt: 'Say hi', outputSchema: { type: 'array' } })).statusCode).toBe(
            400,
          )
          const started = await send(runsPath, { orgId: org.id, agentId: engineer.id, prompt: 'Say hi', outputSchema })
          expect(started.statusCode).toBe(200)
          const { run } = started.json()
          expect(run).toMatchObject({
            state: 'queued',
            finished: false,
            agentId: engineer.id,
            output: null,
            url: `http://localhost:4101/runs/${run.id}`,
          })
          expect(await harness.deps.db('runs').where({ id: run.id }).first()).toMatchObject({
            phase: 'plugin',
            issueId: null,
            projectId: null,
            trigger: { pluginId: plugin.id, prompt: 'Say hi', outputSchema },
          })
          expect((await send(`${runsPath}/${run.id}`, { orgId: org.id })).json().run).toMatchObject({ id: run.id, state: 'queued' })
          expect((await send(`${runsPath}/00000000-0000-4000-8000-000000000000`, { orgId: org.id })).statusCode).toBe(404)
          await send(runsPath, { orgId: org.id, agentId: engineer.id, prompt: 'Again' })
          await send(runsPath, { orgId: org.id, agentId: engineer.id, prompt: 'And again' })
          expect((await send(runsPath, { orgId: org.id, agentId: engineer.id, prompt: 'One too many' })).statusCode).toBe(409)

          const opened = new URL((await admin.ok('POST', `/api/plugins/${plugin.id}/pages/home/open`)).url)
          const [payload] = String(opened.searchParams.get('factorix')).split('.')
          expect(JSON.parse(Buffer.from(String(payload), 'base64url').toString())).toMatchObject({ plugin: { id: plugin.id } })
        } finally {
          await harness.deps.db('runs').where({ phase: 'plugin' }).update({ state: 'cancelled' })
          await new Promise((resolve) => server.close(resolve))
        }
      })

      it('speaks the protocol the plugin SDK speaks', async () => {
        const secret = 'sdk-secret-0123456789'
        const sealed = harness.deps.secrets.encrypt(secret)
        const manifest = {
          ...definePlugin({
            name: 'SDK check',
            version: '1.0.0',
            permissions: ['activity:read'],
            pages: [{ key: 'p', label: 'P', render: () => '' }],
          }).manifest,
        }
        const [plugin] = await harness.deps
          .db('plugins')
          .insert({
            name: manifest.name,
            url: 'http://sdk-check.invalid/factorix',
            manifest: json(manifest),
            secretCiphertext: sealed.ciphertext,
            secretNonce: sealed.nonce,
          })
          .returning('*')
        const { org } = await admin.ok('GET', '/api/auth/me')
        await admin.ok('PUT', `/api/plugins/${plugin.id}/organization`, { enabled: true })
        const viaApp: typeof fetch = async (input, init) => {
          const target = new URL(String(input))
          const answer = await harness.app.inject({
            method: 'POST',
            url: target.pathname,
            headers: init?.headers as Record<string, string>,
            payload: String(init?.body ?? ''),
          })
          return new Response(answer.body, { status: answer.statusCode, headers: { 'content-type': 'application/json' } })
        }
        const fx = factorix({ url: 'http://factorix.test', secret, pluginId: plugin.id, fetch: viaApp })

        const activity = await fx.activity(org.id, new Date(Date.now() - 86_400_000))
        expect(activity).toMatchObject({ issues: expect.any(Array), merges: expect.any(Array), reports: expect.any(Array), truncated: false })
        await expect(fx.agents(org.id)).rejects.toMatchObject({ status: 403 })
        await expect(fx.settings('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ status: 404 })
        await expect(
          factorix({ url: 'http://factorix.test', secret: 'not-the-secret-0000', pluginId: plugin.id, fetch: viaApp }).settings(org.id),
        ).rejects.toMatchObject({
          status: 401,
        })

        await harness.deps
          .db('plugins')
          .where({ id: plugin.id })
          .update({ manifest: json({ ...manifest, permissions: ['activity:read', 'agents:run'] }) })
        await admin.ok('PUT', `/api/plugins/${plugin.id}/organization`, { enabled: true })
        const engineer = (await fx.agents(org.id)).find((agent) => agent.handle === 'engineer-1')
        const run = await fx.startRun(org.id, { agentId: String(engineer?.id), prompt: 'Say hi' })
        expect(await fx.getRun(org.id, run.id)).toMatchObject({ id: run.id, state: 'queued', finished: false, output: null })
        await harness.deps.db('runs').where({ id: run.id }).update({ state: 'cancelled' })
        await admin.ok('PUT', `/api/plugins/${plugin.id}/organization`, { enabled: false })
      })

      it('registers the plugins the plugin host runs, each with its own secret and origin', async () => {
        const key = 'bundled-key-0123456789'
        const manifest = {
          protocol: 1,
          name: 'Bundled board',
          version: '1.0.0',
          provides: [],
          connection: { fields: [] },
          settings: { fields: [] },
          pages: [{ key: 'board', label: 'Board', path: '/pages/board', placement: 'sidebar' }],
        }
        let listed = [
          { name: 'board', running: true },
          { name: 'Not A Name', running: true },
        ]
        const host = createServer((req, res) => {
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' })
            if (req.method === 'GET' && req.url === '/__plugins') return void res.end(JSON.stringify({ plugins: listed }))
            const signed = verifyPlugin(
              bundledPluginSecret(key, 'board'),
              String(req.headers['x-factorix-timestamp']),
              String(req.headers['x-factorix-signature']),
              Buffer.concat(chunks),
            )
            res.end(JSON.stringify(req.url === '/board/factorix' && signed ? { result: manifest } : { error: { message: 'bad signature' } }))
          })
        })
        await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve))
        const internal = `http://127.0.0.1:${(host.address() as AddressInfo).port}`
        const env = {
          ...harness.deps.env,
          FACTORIX_PLUGINS_KEY: key,
          FACTORIX_PLUGINS_INTERNAL_URL: internal,
        }
        const deps = { ...harness.deps, env }
        try {
          await syncBundledPlugins(deps)
          const find = async () =>
            (await admin.ok('GET', '/api/plugins')).plugins.find((plugin: { url: string }) => plugin.url === `${internal}/board/factorix`)
          const plugin = await find()
          expect(plugin).toMatchObject({ name: 'Bundled board', bundled: true })
          const factorix = new URL(env.FACTORIX_PUBLIC_URL).origin
          expect((await admin.ok('GET', '/api/plugins/origins')).origins).toContain(factorix)
          expect((await admin.request('DELETE', `/api/plugins/${plugin.id}`)).status).toBe(409)
          await admin.ok('PUT', `/api/plugins/${plugin.id}/organization`, { enabled: true })
          const opened = new URL((await admin.ok('POST', `/api/plugins/${plugin.id}/pages/board/open`)).url)
          expect(opened.origin + opened.pathname).toBe(`${factorix}/_plugin/board/factorix/pages/board`)

          const before = await harness.deps.db('plugins').where({ id: plugin.id }).first()
          await syncBundledPlugins(deps)
          expect((await harness.deps.db('plugins').where({ id: plugin.id }).first()).updatedAt).toEqual(before.updatedAt)
          manifest.version = '1.1.0'
          await syncBundledPlugins(deps)
          expect((await find()).version).toBe('1.1.0')

          listed = []
          await syncBundledPlugins(deps)
          expect((await find()).bundled).toBe(false)
          await admin.ok('PUT', `/api/plugins/${plugin.id}/organization`, { enabled: false })
          expect((await admin.request('DELETE', `/api/plugins/${plugin.id}`)).status).toBe(200)
        } finally {
          await new Promise((resolve) => host.close(resolve))
        }
      })

      it('runs a project on built-in tickets when there is no tracker to connect', async () => {
        const { connection } = await admin.ok('POST', '/api/connections', { kind: 'factorix', name: 'Factorix tickets' })
        expect(connection).toMatchObject({ hasSecret: false, webhookUrl: null, accountRole: null })
        expect((await admin.request('POST', '/api/connections', { kind: 'factorix', name: 'Again' })).status).toBe(409)

        const board = { connectionId: connection.id, key: 'shop', name: 'Shop' }
        const { team } = await admin.ok('POST', '/api/tracker/teams', board)
        expect(team).toMatchObject({ key: 'SHOP', name: 'Shop' })
        expect((await admin.request('POST', '/api/tracker/teams', board)).status).toBe(409)
        expect((await admin.request('POST', '/api/tracker/teams', { ...board, connectionId: linearId })).status).toBe(400)
        expect((await admin.ok('GET', `/api/tracker/teams?connectionId=${connection.id}`)).teams).toEqual([team])
        const { states } = await admin.ok('GET', `/api/tracker/states?connectionId=${connection.id}&teamId=${team.id}`)
        expect(states.map((state: { id: string }) => state.id)).toContain('in_review')

        const { project } = await admin.ok('POST', '/api/projects', {
          name: 'Shop',
          trackerConnectionId: connection.id,
          trackerTeamId: team.id,
          scmConnectionId: gitlabId,
          repos: [{ scmRepoId: '43', scmRepoPath: 'g/s', scmCloneUrl: 'https://gitlab.com/g/s.git', defaultBranch: 'main' }],
          stateMap: { in_progress: 'in_progress', in_review: 'in_review', done: 'done', blocked: 'blocked' },
          trigger: { states: ['Todo'] },
        })
        await importProject(harness.deps, project.id)
        const labels = (await admin.ok('GET', `/api/projects/${project.id}`)).project.agentLabels
        expect(Object.keys(labels)).toContain('engineer-1')
        const hooks = await admin.ok('POST', `/api/projects/${project.id}/webhooks`)
        expect(hooks.results.map((result: { kind: string }) => result.kind)).toEqual(['gitlab'])

        const first = (await admin.ok('POST', `/api/projects/${project.id}/issues`, { title: 'Add a cart', description: 'See SHOP-2', priority: 2 }))
          .issue
        const second = (await admin.ok('POST', `/api/projects/${project.id}/issues`, { title: 'Add checkout' })).issue
        expect([first.identifier, second.identifier]).toEqual(['SHOP-1', 'SHOP-2'])
        expect(first).toMatchObject({ trackerStateName: 'Todo', priority: 2, trackerUrl: null, factoryState: 'untracked' })
        expect(first.authorName).toBeTruthy()

        const detail = (await admin.ok('GET', `/api/issues/${first.id}`)).issue
        expect(detail).toMatchObject({ editable: true, descriptionSource: 'See SHOP-2' })
        expect(detail.description).toBe(`See [SHOP-2](/issues/${second.id})`)

        const edited = (await admin.ok('PUT', `/api/issues/${first.id}`, { title: 'Add a basket', stateId: 'done' })).issue
        expect(edited).toMatchObject({ title: 'Add a basket', trackerStateName: 'Done', closed: true, priority: 2 })
        expect((await admin.request('PUT', `/api/issues/${first.id}`, { stateId: 'nope' })).status).toBe(400)

        const { agents } = await admin.ok('GET', '/api/agents')
        const engineer = agents.find((candidate: { handle: string }) => candidate.handle === 'engineer-1')
        const assigned = (await admin.ok('POST', `/api/issues/${second.id}/assign`, { agentId: engineer.id })).issue
        expect(assigned.factoryState).not.toBe('untracked')
        const tracker = new FactorixTracker(harness.deps.db, { id: connection.id, orgId: project.orgId ?? '' })
        expect((await tracker.getIssue(second.trackerIssueId))?.labels.map((label) => label.name)).toEqual(['engineer-1'])
        await syncProjectIssues(harness.deps, (await harness.deps.db('projects').where({ id: project.id }).first()) as never, { full: true })
        expect((await admin.ok('GET', `/api/issues/${second.id}`)).issue.labels.map((label: { name: string }) => label.name)).toEqual(['engineer-1'])

        await setTrackerState(harness.deps, { issueId: second.id, key: 'in_progress' })
        expect((await tracker.getIssue(second.trackerIssueId))?.stateName).toBe('In Progress')
        await admin.ok('POST', `/api/issues/${second.id}/cancel`)

        const linearIssue = (await admin.ok('GET', '/api/issues')).issues.find((issue: { projectId: string }) => issue.projectId === projectId)
        expect((await admin.request('PUT', `/api/issues/${linearIssue.id}`, { title: 'No' })).status).toBe(409)
      })

      it('lets a plugin read members and create tickets only where the organization allowed it', async () => {
        const secret = 'tickets-secret-0123456789'
        const manifest = {
          protocol: 1,
          name: 'Processes',
          version: '1.0.0',
          provides: [],
          permissions: [] as string[],
          connection: { fields: [] },
          settings: { fields: [] },
          pages: [{ key: 'home', label: 'Home', path: '/pages/home', placement: 'sidebar' }],
        }
        const server = createServer((req, res) => {
          req.resume()
          req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ result: manifest }))
          })
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/factorix`
        const send = (path: string, payload: unknown) => {
          const body = JSON.stringify(payload)
          const timestamp = String(Date.now())
          return harness.app.inject({
            method: 'POST',
            url: path,
            payload: body,
            headers: {
              'content-type': 'application/json',
              'x-factorix-timestamp': timestamp,
              'x-factorix-signature': signPlugin(secret, timestamp, body),
            },
          })
        }
        try {
          const { plugin } = await admin.ok('POST', '/api/plugins', { url, secret })
          const { org } = await admin.ok('GET', '/api/auth/me')
          await admin.ok('PUT', `/api/plugins/${plugin.id}/organization`, { enabled: true })
          const base = `/webhooks/plugins/${plugin.id}`
          const shop = await harness.deps.db('projects').where({ orgId: org.id, name: 'Shop' }).first()
          const ask = { orgId: org.id, projectId: shop.id, title: 'Order a laptop', description: 'For **Ada**.', priority: 2 }
          expect((await send(`${base}/members`, { orgId: org.id })).statusCode).toBe(403)
          expect((await send(`${base}/projects`, { orgId: org.id })).statusCode).toBe(403)
          expect((await send(`${base}/tickets`, ask)).statusCode).toBe(403)

          manifest.permissions = ['members:read', 'tickets:write']
          await admin.ok('POST', `/api/plugins/${plugin.id}/refresh`)
          expect((await send(`${base}/members`, { orgId: org.id })).statusCode).toBe(403)
          await admin.ok('PUT', `/api/plugins/${plugin.id}/organization`, { enabled: true })

          const { members } = (await send(`${base}/members`, { orgId: org.id })).json()
          expect(members).toContainEqual(expect.objectContaining({ kind: 'agent', handle: 'engineer-1', status: 'active' }))
          const person = members.find((member: { kind: string }) => member.kind === 'person')
          expect(Object.keys(person).sort()).toEqual(['handle', 'id', 'kind', 'name', 'role', 'status'])

          const { projects } = (await send(`${base}/projects`, { orgId: org.id })).json()
          expect(projects).toContainEqual({ id: shop.id, name: 'Shop' })

          expect((await send(`${base}/tickets`, { ...ask, projectId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404)
          expect((await send(`${base}/tickets`, { ...ask, agentId: person.id })).statusCode).toBe(404)
          expect((await send(`${base}/tickets`, { ...ask, title: '' })).statusCode).toBe(422)
          const created = await send(`${base}/tickets`, ask)
          expect(created.statusCode).toBe(200)
          const { ticket } = created.json()
          expect(ticket).toMatchObject({ identifier: expect.stringMatching(/^SHOP-\d+$/), title: 'Order a laptop', status: 'Todo', closed: false })
          expect(await harness.deps.db('issues').where({ id: ticket.id }).first()).toMatchObject({ orgId: org.id, projectId: shop.id, priority: 2 })
          expect(await harness.deps.db('audit_log').where({ targetId: ticket.id, action: 'issue.created' }).first()).toMatchObject({
            metadata: { via: 'plugin', pluginId: plugin.id },
          })

          expect((await send(`${base}/tickets/${ticket.id}`, { orgId: org.id })).json().ticket).toEqual(ticket)
          await admin.ok('PUT', `/api/issues/${ticket.id}`, { stateId: 'done' })
          expect((await send(`${base}/tickets/${ticket.id}`, { orgId: org.id })).json().ticket).toMatchObject({ status: 'Done', closed: true })
          const other = await harness.deps.db('issues').where({ orgId: org.id }).whereNot({ id: ticket.id }).first()
          expect((await send(`${base}/tickets/${other.id}`, { orgId: org.id })).statusCode).toBe(404)

          const engineer = members.find((member: { handle: string }) => member.handle === 'engineer-1')
          const handed = (await send(`${base}/tickets`, { ...ask, title: 'Set up accounts', agentId: engineer.id })).json().ticket
          expect(await harness.deps.db('issues').where({ id: handed.id }).first()).toMatchObject({ assignedAgentId: engineer.id })
          await admin.ok('POST', `/api/issues/${handed.id}/cancel`)
        } finally {
          await new Promise((resolve) => server.close(resolve))
        }
      })

      it('answers an unknown connection with 404 and a malformed id without touching the database', async () => {
        expect((await sendLinearWebhook(harness.app, '00000000-0000-4000-8000-000000000000', 'x', {})).statusCode).toBe(404)
        expect((await sendLinearWebhook(harness.app, 'not-a-uuid', 'x', {})).statusCode).toBe(404)
      })

      it('pages through issues and reports totals per factory state', async () => {
        const created = await Promise.all(
          ['alpha one', 'alpha two', 'alpha three'].map((title) => admin.ok('POST', `/api/projects/${projectId}/issues`, { title })),
        )
        expect(created).toHaveLength(3)
        const first = await admin.ok('GET', `/api/issues?projectId=${projectId}&q=alpha&limit=2&page=1`)
        const second = await admin.ok('GET', `/api/issues?projectId=${projectId}&q=alpha&limit=2&page=2`)
        expect(first.total).toBe(3)
        expect(first.counts.untracked).toBe(3)
        expect(first.issues).toHaveLength(2)
        expect(second.issues).toHaveLength(1)
        const ids = [...first.issues, ...second.issues].map((issue: { id: string }) => issue.id)
        expect(new Set(ids).size).toBe(3)
        expect(first.issues[0].description).toBeNull()
      })

      it('escapes search wildcards', async () => {
        expect((await admin.ok('GET', `/api/issues?projectId=${projectId}&q=%25`)).total).toBe(0)
      })

      it('filters by the fields the source declares', async () => {
        const named = harness.world.addIssue({
          title: 'Filter me please',
          priority: 1,
          creatorName: 'Pat Author',
          assigneeName: 'Quinn',
          stateId: 'st-progress',
          stateName: 'In Progress',
          stateType: 'started',
          labels: [{ id: 'label-bug', name: 'bug', parentId: null }],
        })
        await importProject(harness.deps, projectId)
        const ids = async (query: string) =>
          (await admin.ok('GET', `/api/issues?projectId=${projectId}&${query}`)).issues.map(
            (issue: { trackerIssueId: string }) => issue.trackerIssueId,
          )
        expect(await ids('author=Pat%20Author')).toEqual([named.id])
        expect(await ids('title=filter%20me')).toEqual([named.id])
        expect(await ids('status=In%20Progress')).toEqual([named.id])
        expect(await ids('priority=1')).toEqual([named.id])
        expect(await ids('assignee=Quinn')).toEqual([named.id])
        expect(await ids('label=bug')).toEqual([named.id])
        expect(await ids('author=Pat%20Author&label=nope')).toEqual([])
        expect(await ids('status=In%20Progress&status=Nope')).toEqual([named.id])
        expect(await ids('assignee=__none__&title=filter%20me')).toEqual([])

        const { filters } = await admin.ok('GET', `/api/issues/filters?projectId=${projectId}`)
        const keys = filters.map((filter: { key: string }) => filter.key)
        expect(keys).toEqual(['title', 'status', 'priority', 'assignee', 'author', 'label', 'factoryState', 'agentId'])
        const options = (key: string) => filters.find((filter: { key: string }) => filter.key === key).options
        expect(options('author').map((option: { value: string }) => option.value)).toContain('Pat Author')
        expect(options('priority').find((option: { value: string }) => option.value === '1').label).toBe('Urgent')
        expect(options('label').map((option: { value: string }) => option.value)).toEqual(['bug'])
        expect(options('status').find((option: { value: string }) => option.value === 'In Progress').meta).toBe('started')
      })

      it('a full import skips work closed long ago, and an open ticket always comes through', async () => {
        const old = new Date(Date.now() - 200 * 86_400_000).toISOString()
        const ancientDone = harness.world.addIssue({
          title: 'Ancient done',
          stateId: 'st-done',
          stateName: 'Done',
          stateType: 'completed',
          updatedAt: old,
        })
        const ancientOpen = harness.world.addIssue({ title: 'Ancient open', updatedAt: old })
        const recentDone = harness.world.addIssue({ title: 'Recent done', stateId: 'st-done', stateName: 'Done', stateType: 'completed' })
        await importProject(harness.deps, projectId)
        const imported = (await harness.deps.db('issues').where({ projectId }).pluck('tracker_issue_id')) as string[]
        expect(imported).not.toContain(ancientDone.id)
        expect(imported).toContain(ancientOpen.id)
        expect(imported).toContain(recentDone.id)
        harness.world.issues.delete(ancientDone.id)
      })

      it('keeps closed issues out of the open view and out of reach of agents', async () => {
        const done = harness.world.addIssue({ title: 'Closed scope probe', stateId: 'st-done', stateName: 'Done', stateType: 'completed' })
        const open = harness.world.addIssue({ title: 'Open scope probe' })
        await importProject(harness.deps, projectId)
        const list = async (query: string) => await admin.ok('GET', `/api/issues?projectId=${projectId}&q=scope%20probe&${query}`)
        expect((await list('scope=open')).issues.map((issue: { trackerIssueId: string }) => issue.trackerIssueId)).toEqual([open.id])
        const closed = await list('scope=closed')
        expect(closed.issues.map((issue: { trackerIssueId: string }) => issue.trackerIssueId)).toEqual([done.id])
        expect(closed.issues[0].group).toBe('closed')
        expect(closed.counts).toEqual({ closed: 1 })
        expect((await list('scope=all')).total).toBe(2)
        expect((await list('factoryState=closed')).total).toBe(1)
        expect((await list('factoryState=untracked')).issues.map((issue: { trackerIssueId: string }) => issue.trackerIssueId)).toEqual([open.id])

        const { filters } = await admin.ok('GET', `/api/issues/filters?projectId=${projectId}&scope=open`)
        const statuses = filters.find((filter: { key: string }) => filter.key === 'status').options.map((option: { value: string }) => option.value)
        expect(statuses).not.toContain('Done')

        const { agents } = await admin.ok('GET', '/api/agents')
        const refused = await admin.request('POST', `/api/issues/${closed.issues[0].id}/assign`, { agentId: agents[0].id })
        expect(refused.status).toBe(409)
        expect(refused.body.error.message).toContain('closed in the tracker')
      })

      it('counts tickets that arrive after you last looked', async () => {
        const count = async () => (await admin.ok('GET', `/api/projects/${projectId}`)).project.newIssueCount
        await admin.ok('POST', `/api/projects/${projectId}/seen`)
        expect(await count()).toBe(0)

        const project = async () => (await harness.deps.db('projects').where({ id: projectId }).first()) as never
        harness.world.addIssue({ title: 'Fresh from Linear' })
        harness.world.addIssue({ title: 'Already finished', stateId: 'st-done', stateName: 'Done', stateType: 'completed' })
        await syncProjectIssues(harness.deps, await project())
        expect(await count()).toBe(1)
        expect((await admin.ok('GET', '/api/projects')).projects.find((entry: { id: string }) => entry.id === projectId).newIssueCount).toBe(1)

        await admin.ok('POST', `/api/projects/${projectId}/issues`, { title: 'Filed from here' })
        expect(await count()).toBe(1)

        await admin.ok('POST', `/api/projects/${projectId}/seen`)
        expect(await count()).toBe(0)
      })

      it('a first import is not news', async () => {
        const row = await harness.deps.db('projects').where({ id: projectId }).first()
        const issue = harness.world.addIssue({ title: 'There before you connected' })
        await syncProjectIssues(harness.deps, { ...row, lastSyncedAt: null }, { full: true })
        const mirrored = await harness.deps.db('issues').where({ trackerIssueId: issue.id }).first()
        expect(mirrored.announcedAt).toBeNull()
      })

      it('links references from every source the project uses', async () => {
        const { issue: other } = await admin.ok('POST', `/api/projects/${projectId}/issues`, { title: 'Linked target' })
        const { issue } = await admin.ok('POST', `/api/projects/${projectId}/issues`, {
          title: 'Has references',
          description: `Split out of !6723, follows ${other.identifier}, unlike UTF-8 or \`!12\``,
        })
        const detail = (await admin.ok('GET', `/api/issues/${issue.id}`)).issue
        expect(detail.description).toBe(
          `Split out of [!6723](https://gitlab.com/g/r/-/merge_requests/6723), follows [${other.identifier}](/issues/${other.id}), unlike UTF-8 or \`!12\``,
        )
      })

      it('imports in batches, reports progress, and keeps what it has when a page fails', async () => {
        const batchWorld = harness.world
        for (let index = 0; index < 120; index += 1) batchWorld.addIssue({ title: `Bulk ${index}` })
        const seen: number[] = []
        const before = batchWorld.issuePagesRead
        await syncProjectIssues(harness.deps, (await harness.deps.db('projects').where({ id: projectId }).first()) as never, {
          full: true,
          onBatch: async (imported) => void seen.push(imported),
        })
        expect(batchWorld.issuePagesRead - before).toBeGreaterThan(2)
        expect(seen).toEqual([...seen].sort((a, b) => a - b))

        batchWorld.failIssueListing = 'Linear is down'
        await expect(importProject(harness.deps, projectId, { finalAttempt: false })).rejects.toThrow('Linear is down')
        expect((await admin.ok('GET', `/api/projects/${projectId}`)).project.syncState).toBe('syncing')
        await expect(importProject(harness.deps, projectId, { finalAttempt: true })).rejects.toThrow('Linear is down')
        const failed = (await admin.ok('GET', `/api/projects/${projectId}`)).project
        expect(failed.syncState).toBe('failed')
        expect(failed.syncError).toContain('Linear is down')
        batchWorld.failIssueListing = null

        expect((await admin.ok('POST', `/api/projects/${projectId}/sync`)).project.syncState).toBe('syncing')
        await importProject(harness.deps, projectId)
        expect((await admin.ok('GET', `/api/projects/${projectId}`)).project.syncState).toBe('idle')
      })

      it('formats issue text with the source formatter and serves its uploads through the proxy', async () => {
        const upload = 'https://uploads.linear.app/a/b/c'
        harness.world.media.set(upload, { contentType: 'image/png', body: 'png-bytes' })
        harness.world.media.set(`${upload}/svg`, { contentType: 'image/svg+xml', body: '<svg onload="alert(1)"/>' })
        const { issue } = await admin.ok('POST', `/api/projects/${projectId}/issues`, {
          title: 'Has an image',
          description: `first\nsecond\n\n![image (1).png](${upload})`,
        })
        const detail = (await admin.ok('GET', `/api/issues/${issue.id}`)).issue
        const proxied = `/api/issues/${issue.id}/media?url=${encodeURIComponent(upload)}`
        expect(detail.description).toBe(`first  \nsecond\n\n![image (1).png](${proxied})`)

        const stored = await harness.deps.db('issues').where({ id: issue.id }).first()
        expect(stored.description).toContain(upload)

        const get = (url: string, cookie = admin.cookie) => harness.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })
        const file = await get(proxied)
        expect(file.statusCode).toBe(200)
        expect(file.headers['content-type']).toBe('image/png')
        expect(file.headers['x-content-type-options']).toBe('nosniff')
        expect(file.body).toBe('png-bytes')

        const svg = await get(`/api/issues/${issue.id}/media?url=${encodeURIComponent(`${upload}/svg`)}`)
        expect(svg.headers['content-type']).toBe('application/octet-stream')
        expect(svg.headers['content-disposition']).toBe('attachment')

        for (const url of ['https://evil.example/a', 'http://uploads.linear.app/a', 'file:///etc/passwd', 'http://localhost:4100/api/auth/me']) {
          expect((await get(`/api/issues/${issue.id}/media?url=${encodeURIComponent(url)}`)).statusCode).toBe(404)
        }
        expect((await get(proxied, '')).statusCode).toBe(401)
      })

      it('lists and filters issues', async () => {
        const all = (await admin.ok('GET', `/api/issues?projectId=${projectId}`)).issues
        expect(all.length).toBeGreaterThan(0)
        expect((await admin.ok('GET', '/api/issues?q=from%20the')).issues.map((issue: { title: string }) => issue.title)).toEqual(['From the UI'])
      })

      it('assigning an agent writes the label, moves the cursor, and creates a run', async () => {
        const { issues } = await admin.ok('GET', '/api/issues?q=from%20the')
        const { agents } = await admin.ok('GET', '/api/agents')
        const engineer = agents.find((agent: { handle: string }) => agent.handle === 'engineer-1')
        const { issue } = await admin.ok('POST', `/api/issues/${issues[0].id}/assign`, { agentId: engineer.id })
        expect(issue.factoryState).toBe('active')
        expect(issue.pipelineStep).toBe('implement')
        expect(issue.activeRunId).toBeTruthy()
        expect(harness.world.issues.get(issue.trackerIssueId)?.labels.map((label) => label.name)).toEqual(['engineer-1'])

        const { runs } = await admin.ok('GET', `/api/runs?issueId=${issue.id}`)
        expect(runs[0]).toMatchObject({ state: 'queued', phase: 'implement', agentHandle: 'engineer-1', runtime: 'claude' })

        const detail = (await admin.ok('GET', `/api/issues/${issue.id}`)).issue
        expect(detail.runs).toHaveLength(1)
        expect(detail.timeline.some((entry: { action: string }) => entry.action === 'issue.assigned_to_agent')).toBe(true)
      })

      it('keeps at most one active run per issue', async () => {
        const { issues } = await admin.ok('GET', '/api/issues?q=from%20the')
        const { agents } = await admin.ok('GET', '/api/agents')
        const engineer = agents.find((agent: { handle: string }) => agent.handle === 'engineer-2')
        await admin.ok('POST', `/api/issues/${issues[0].id}/assign`, { agentId: engineer.id })
        const { runs } = await admin.ok('GET', `/api/runs?issueId=${issues[0].id}`)
        expect(runs).toHaveLength(1)
      })

      it('cancels a run that has not started without a worker', async () => {
        const { issues } = await admin.ok('GET', '/api/issues?q=from%20the')
        const { issue } = await admin.ok('POST', `/api/issues/${issues[0].id}/cancel`)
        expect(issue.factoryState).toBe('cancelled')
        expect(issue.activeRunId).toBeNull()
        const { runs } = await admin.ok('GET', `/api/runs?issueId=${issue.id}`)
        expect(runs[0].state).toBe('cancelled')
      })

      it('retries only issues that ended badly', async () => {
        const { issues } = await admin.ok('GET', '/api/issues?q=from%20the')
        const { issue } = await admin.ok('POST', `/api/issues/${issues[0].id}/retry`)
        expect(issue.factoryState).toBe('active')
        expect((await admin.request('POST', `/api/issues/${issues[0].id}/retry`)).status).toBe(409)
      })

      describe('sorting', () => {
        const SORTED = 'sortable'
        let a: string
        let b: string
        let c: string
        const order = async (query: string) => {
          const { issues } = await admin.ok('GET', `/api/issues?projectId=${projectId}&q=${SORTED}&${query}`)
          return issues.map((issue: { trackerIssueId: string }) => ({ [a]: 'a', [b]: 'b', [c]: 'c' })[issue.trackerIssueId])
        }

        beforeAll(async () => {
          a = harness.world.addIssue({
            title: `${SORTED} apple`,
            identifier: 'SRT-9',
            priority: 3,
            assigneeName: 'Zed',
            creatorName: 'Ann',
            createdAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-03-01T00:00:00.000Z',
            stateId: 'st-progress',
            stateName: 'In Progress',
            stateType: 'started',
          }).id
          b = harness.world.addIssue({
            title: `${SORTED.toUpperCase()} banana`,
            identifier: 'SRT-100',
            priority: 0,
            assigneeName: null,
            creatorName: 'Bob',
            createdAt: '2026-01-03T00:00:00.000Z',
            updatedAt: '2026-02-01T00:00:00.000Z',
            stateId: 'st-todo',
            stateName: 'Todo',
            stateType: 'unstarted',
          }).id
          c = harness.world.addIssue({
            title: `${SORTED} cherry`,
            identifier: 'SRT-10',
            priority: 1,
            assigneeName: 'amy',
            creatorName: 'Cid',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-04-01T00:00:00.000Z',
            stateId: 'st-backlog',
            stateName: 'Backlog',
            stateType: 'backlog',
          }).id
          await importProject(harness.deps, projectId)
        })

        const EXPECTED = {
          updated: { first: ['c', 'a', 'b'], reversed: ['b', 'a', 'c'] },
          created: { first: ['b', 'a', 'c'], reversed: ['c', 'a', 'b'] },
          // No priority stays last either way.
          priority: { first: ['c', 'a', 'b'], reversed: ['a', 'c', 'b'] },
          status: { first: ['c', 'b', 'a'], reversed: ['a', 'b', 'c'] },
          // Case does not matter.
          title: { first: ['a', 'b', 'c'], reversed: ['c', 'b', 'a'] },
          // 100 beats 10 beats 9, which a text comparison gets backwards.
          identifier: { first: ['b', 'c', 'a'], reversed: ['a', 'c', 'b'] },
          // Case does not matter, and no assignee stays last either way.
          assignee: { first: ['c', 'a', 'b'], reversed: ['a', 'c', 'b'] },
          author: { first: ['a', 'b', 'c'], reversed: ['c', 'b', 'a'] },
        } satisfies Record<keyof typeof ISSUE_SORTS, { first: string[]; reversed: string[] }>

        it('offers every field it can sort by', async () => {
          const { sorts } = await admin.ok('GET', `/api/issues/filters?projectId=${projectId}`)
          expect(sorts.map((sort: { key: string }) => sort.key).sort()).toEqual(Object.keys(EXPECTED).sort())
        })

        it.each(Object.entries(EXPECTED))('sorts by %s in both directions', async (sort, { first, reversed }) => {
          const natural = ISSUE_SORTS[sort as keyof typeof ISSUE_SORTS]
          expect(await order(`sort=${sort}`)).toEqual(first)
          expect(await order(`sort=${sort}&direction=${natural}`)).toEqual(first)
          expect(await order(`sort=${sort}&direction=${natural === 'asc' ? 'desc' : 'asc'}`)).toEqual(reversed)
        })

        it('defaults to the latest update', async () => {
          expect(await order('')).toEqual(EXPECTED.updated.first)
        })

        it('walks through pages in sorted order', async () => {
          const pages = await Promise.all([1, 2, 3].map((page) => order(`sort=identifier&limit=1&page=${page}`)))
          expect(pages.flat()).toEqual(EXPECTED.identifier.first)
        })

        it('keeps groups together and sorts inside them', async () => {
          await harness.deps.db('issues').where({ projectId, trackerIssueId: a }).update({ factoryState: 'failed' })
          expect(await order('group=state&sort=priority')).toEqual(['a', 'c', 'b'])
          expect(await order('group=state&sort=title&direction=desc')).toEqual(['a', 'c', 'b'])
          expect(await order('group=state&sort=identifier')).toEqual(['a', 'b', 'c'])
          await harness.deps.db('issues').where({ projectId, trackerIssueId: a }).update({ factoryState: 'untracked' })
        })

        it('reads the created date from the tracker, and a later update without one keeps it', async () => {
          const created = async () => {
            const { issues } = await admin.ok('GET', `/api/issues?projectId=${projectId}&q=${SORTED}%20apple`)
            return issues[0].createdAt
          }
          expect(await created()).toBe('2026-01-02T00:00:00.000Z')
          harness.world.touch(harness.world.issues.get(a) as TrackerIssue, { createdAt: null })
          await importProject(harness.deps, projectId)
          expect(await created()).toBe('2026-01-02T00:00:00.000Z')
        })

        it('fills in dates on old closed issues once, then goes back to skipping them', async () => {
          const db = harness.deps.db
          const { orgId } = await db('projects').where({ id: projectId }).first()
          const closed = { stateId: 'st-done', stateName: 'Done', stateType: 'completed' as const, updatedAt: '2024-02-01T00:00:00.000Z' }
          const legacy = harness.world.addIssue({ title: 'legacy done', createdAt: '2024-01-01T00:00:00.000Z', ...closed })
          await db('issues').insert([
            { orgId, projectId, trackerIssueId: legacy.id, identifier: legacy.identifier, title: legacy.title },
            { orgId, projectId, trackerIssueId: 'gone-from-tracker', identifier: 'GONE-1', title: 'gone' },
          ])
          const row = (id: string) => db('issues').where({ projectId, trackerIssueId: id }).first()

          await importProject(harness.deps, projectId)
          expect((await row(legacy.id)).trackerCreatedAt.toISOString()).toBe('2024-01-01T00:00:00.000Z')
          expect((await row(legacy.id)).announcedAt).toBeNull()
          expect((await row('gone-from-tracker')).trackerCreatedAt).not.toBeNull()

          const later = harness.world.addIssue({ title: 'later done', ...closed })
          await importProject(harness.deps, projectId)
          expect(await row(later.id)).toBeUndefined()
        })

        it('refuses anything but a known field and direction', async () => {
          for (const query of ['sort=state', 'sort=title;drop%20table%20issues', 'direction=sideways']) {
            expect((await admin.request('GET', `/api/issues?projectId=${projectId}&${query}`)).status, query).toBe(422)
          }
        })
      })
    })

    it('relays domain events to queues exactly once', async () => {
      const first = await relayDomainEvents(harness.deps)
      expect(first).toBeGreaterThan(0)
      while ((await relayDomainEvents(harness.deps)) > 0) {}
      expect(await relayDomainEvents(harness.deps)).toBe(0)
      expect(await harness.deps.db('domain_events').whereNull('processedAt')).toHaveLength(0)
      expect((await harness.deps.queues.runsExecute.getJobCounts('waiting')).waiting).toBeGreaterThan(0)
    })

    it('reports the workflow states the wizard needs', async () => {
      expect((await admin.ok('GET', `/api/tracker/states?connectionId=${linearId}&teamId=${TEAM_ID}`)).states).toEqual(STATES)
    })
  })

  describe('audit log', () => {
    it('refuses tampering at the database level', async () => {
      const { db } = harness.deps
      await expect(db('audit_log').delete()).rejects.toThrow(/append-only/)
      await expect(db('audit_log').update({ action: 'x' })).rejects.toThrow(/append-only/)
    })
  })

  describe('spend', () => {
    it('reports zero before any money was spent', async () => {
      const spend = await admin.ok('GET', '/api/spend')
      expect(spend.totalUsd).toBe(0)
    })
  })

  it('reports health', async () => {
    expect((await harness.app.inject({ url: '/healthz' })).json()).toEqual({ ok: true })
  })
})
