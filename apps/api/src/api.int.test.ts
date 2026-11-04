import type { TrackerIssue } from '@factorix/connectors'
import { ISSUE_SORTS, type RuntimeDto } from '@factorix/schemas'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { relayDomainEvents } from './services/relay'
import { refreshRuntimeModels } from './services/runtime-models'
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

      it('verifies GitLab webhooks with the shared token', async () => {
        expect((await sendGitlabWebhook(harness.app, gitlabId, 'wrong', 'Note Hook', { object_kind: 'note' })).statusCode).toBe(401)
        expect((await sendGitlabWebhook(harness.app, gitlabId, gitlabSecret, 'Note Hook', { object_kind: 'note' })).statusCode).toBe(200)
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
