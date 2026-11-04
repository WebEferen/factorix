import { renderSystemPrompt } from '@factorix/core'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { advanceIssue } from './services/pipeline'
import { TEAM_ID } from './testing/fakes'
import { ApiClient, createHarness, type Harness } from './testing/harness'

const STATE_MAP = { in_progress: 'st-progress', in_review: 'st-review', done: 'st-done', blocked: 'st-blocked' }
const REPO = { scmRepoId: '42', scmRepoPath: 'g/r', scmCloneUrl: 'https://gitlab.com/g/r.git', defaultBranch: 'main' }
const POLICY = { mode: 'full' }

describe('archetypes', () => {
  let harness: Harness
  let admin: ApiClient
  let member: ApiClient
  let projectId: string
  let counter = 0

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    await admin.ok('POST', '/api/members', { name: 'Bo', email: 'bo@example.com', password: 'long enough password', role: 'member' })
    member = new ApiClient(harness.app)
    await member.ok('POST', '/api/auth/login', { email: 'bo@example.com', password: 'long enough password' })
    const linear = (await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'x' })).connection.id
    const gitlab = (await admin.ok('POST', '/api/connections', { kind: 'gitlab', name: 'GitLab', secret: 'y', config: {} })).connection.id
    projectId = (
      await admin.ok('POST', '/api/projects', {
        name: 'Platform',
        trackerConnectionId: linear,
        trackerTeamId: TEAM_ID,
        trackerProjectId: null,
        scmConnectionId: gitlab,
        repos: [REPO],
        stateMap: STATE_MAP,
      })
    ).project.id
  })
  afterAll(() => harness.destroy())

  const list = async () => (await admin.ok('GET', '/api/archetypes')).archetypes as { id: string; name: string; role: string; agents: unknown[] }[]
  const named = async (name: string) => {
    const found = (await list()).find((item) => item.name === name)
    if (!found) throw new Error(`No archetype called ${name}`)
    return found
  }
  const newArchetype = async (overrides: Record<string, unknown> = {}) => {
    counter += 1
    const body = { name: `Custom ${counter}`, role: 'engineer', systemPrompt: `Prompt of custom ${counter}.`, ...overrides }
    return (await admin.ok('POST', '/api/archetypes', body)).archetype
  }
  const newAgent = async (archetypeId: string, overrides: Record<string, unknown> = {}) => {
    counter += 1
    const body = { handle: `agent-${counter}`, displayName: `Agent ${counter}`, archetypeId, runtime: 'claude', policy: POLICY, ...overrides }
    return (await admin.ok('POST', '/api/agents', body)).agent
  }
  const agentNamed = async (handle: string) =>
    (await admin.ok('GET', '/api/agents')).agents.find((agent: { handle: string }) => agent.handle === handle)
  const ticket = async () => {
    counter += 1
    return (await admin.ok('POST', `/api/projects/${projectId}/issues`, { title: `Ticket ${counter}` })).issue as { id: string }
  }
  const assign = async (agentId: string) => {
    const issue = await ticket()
    await admin.ok('POST', `/api/issues/${issue.id}/assign`, { agentId })
    return issue
  }
  const latestRun = (issueId: string) => harness.deps.db('runs').where({ issueId }).orderBy('created_at', 'desc').first()
  const handleOfRun = async (issueId: string) => (await latestRun(issueId)).agentSnapshot.handle
  const setDefaults = (body: Record<string, string | null>) => admin.ok('PUT', `/api/projects/${projectId}`, body)

  it('seeds the presets and builds the first agents from them', async () => {
    expect((await list()).map((item) => [item.name, item.role])).toEqual([
      ['Engineer', 'engineer'],
      ['Incident manager', 'engineer'],
      ['Reviewer', 'reviewer'],
      ['Tester', 'engineer'],
    ])
    const engineer = await agentNamed('engineer-1')
    expect(engineer.archetype).toMatchObject({ name: 'Engineer', role: 'engineer' })
    expect(engineer.systemPrompt).toBe('')
    expect((await agentNamed('reviewer-1')).archetype).toMatchObject({ name: 'Reviewer', role: 'reviewer' })
    expect((await named('Engineer')).agents).toEqual([{ id: engineer.id, displayName: 'Engineer One' }])
  })

  it('creates and updates with an audit trail that keeps the prompt in effect', async () => {
    const created = await newArchetype({ name: 'Frontend engineer', description: 'Browser work' })
    expect(created).toMatchObject({ name: 'Frontend engineer', description: 'Browser work', role: 'engineer', agents: [] })
    const { archetype } = await admin.ok('PUT', `/api/archetypes/${created.id}`, { systemPrompt: 'Care about the browser.' })
    expect(archetype.systemPrompt).toBe('Care about the browser.')
    const { entries } = await admin.ok('GET', `/api/audit?targetType=archetype&targetId=${created.id}`)
    expect(entries.map((entry: { action: string }) => entry.action).sort()).toEqual(['archetype.created', 'archetype.updated'])
    expect(entries.find((entry: { action: string }) => entry.action === 'archetype.updated')).toMatchObject({
      actorName: 'Ada',
      metadata: { name: 'Frontend engineer', role: 'engineer', systemPrompt: 'Care about the browser.' },
    })
  })

  it('lets members read but not change them', async () => {
    const target = await newArchetype()
    expect((await member.request('GET', '/api/archetypes')).status).toBe(200)
    expect((await member.request('POST', '/api/archetypes', { name: 'Nope', role: 'engineer' })).status).toBe(403)
    expect((await member.request('PUT', `/api/archetypes/${target.id}`, { systemPrompt: 'Nope' })).status).toBe(403)
    expect((await member.request('DELETE', `/api/archetypes/${target.id}`)).status).toBe(403)
    expect((await named(target.name)).id).toBe(target.id)
  })

  it('refuses a duplicate name in any case, and bad input', async () => {
    const first = await newArchetype({ name: 'Data engineer' })
    expect((await admin.request('POST', '/api/archetypes', { name: 'DATA ENGINEER', role: 'engineer' })).status).toBe(409)
    const second = await newArchetype({ name: 'Platform engineer' })
    expect((await admin.request('PUT', `/api/archetypes/${second.id}`, { name: 'data engineer' })).status).toBe(409)
    expect((await admin.request('POST', '/api/archetypes', { name: '   ', role: 'engineer' })).status).toBe(422)
    expect((await admin.request('POST', '/api/archetypes', { name: 'Tester two', role: 'tester' })).status).toBe(422)
    expect((await named('Data engineer')).id).toBe(first.id)
  })

  it('keeps the fields a partial update leaves out', async () => {
    const created = await newArchetype({ description: 'Stays', systemPrompt: 'Stays too', role: 'reviewer' })
    const { archetype } = await admin.ok('PUT', `/api/archetypes/${created.id}`, { name: `${created.name} renamed` })
    expect(archetype).toMatchObject({ description: 'Stays', systemPrompt: 'Stays too', role: 'reviewer' })
  })

  it('will not delete one that agents use, and names them', async () => {
    const created = await newArchetype()
    const agent = await newAgent(created.id, { displayName: 'Blocker' })
    const refused = await admin.request('DELETE', `/api/archetypes/${created.id}`)
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toContain('Blocker')
    expect((await named(created.name)).agents).toEqual([{ id: agent.id, displayName: 'Blocker' }])

    const engineer = await named('Engineer')
    const moved = await admin.ok('PUT', `/api/agents/${agent.id}`, {
      handle: agent.handle,
      displayName: agent.displayName,
      archetypeId: engineer.id,
      runtime: 'claude',
      policy: POLICY,
    })
    expect(moved.agent.archetype.name).toBe('Engineer')

    expect((await admin.request('DELETE', `/api/archetypes/${created.id}`)).status).toBe(200)
    expect((await list()).some((item) => item.id === created.id)).toBe(false)
    const { entries } = await admin.ok('GET', `/api/audit?targetType=archetype&targetId=${created.id}`)
    expect(entries.find((entry: { action: string }) => entry.action === 'archetype.deleted').metadata.systemPrompt).toBe(created.systemPrompt)
    expect((await admin.request('DELETE', `/api/archetypes/${created.id}`)).status).toBe(404)
  })

  it('lets a built-in be deleted once nothing uses it', async () => {
    const tester = await named('Tester')
    expect((await admin.request('DELETE', `/api/archetypes/${tester.id}`)).status).toBe(200)
  })

  it('refuses an agent built from an archetype that does not exist', async () => {
    const body = { handle: 'ghost', displayName: 'Ghost', archetypeId: '00000000-0000-4000-8000-000000000000', runtime: 'claude', policy: POLICY }
    expect((await admin.request('POST', '/api/agents', body)).status).toBe(400)
    const agent = await agentNamed('engineer-1')
    expect((await admin.request('PUT', `/api/agents/${agent.id}`, { ...body, handle: agent.handle })).status).toBe(400)
    expect((await admin.request('POST', '/api/agents', { ...body, archetypeId: undefined })).status).toBe(422)
  })

  describe('agents outside the pipeline', () => {
    const newOther = async () => newAgent((await newArchetype({ role: 'other', systemPrompt: 'Dig into it.' })).id)
    const trackerStateOf = async (issueId: string) => {
      const { trackerIssueId } = await harness.deps.db('issues').where({ id: issueId }).first()
      return harness.world.issues.get(trackerIssueId)?.stateId
    }
    const rowOf = (issueId: string) => harness.deps.db('issues').where({ id: issueId }).first()

    it('runs the assigned agent once, in its own step', async () => {
      const agent = await newOther()
      const issue = await ticket()
      const before = await trackerStateOf(issue.id)
      await admin.ok('POST', `/api/issues/${issue.id}/assign`, { agentId: agent.id })
      const run = await latestRun(issue.id)
      expect(run).toMatchObject({ phase: 'task', pipelineStep: 'task', agentId: agent.id })
      expect(run.agentSnapshot.archetype.role).toBe('other')
      expect((await rowOf(issue.id)).factoryState).toBe('active')
      expect(await trackerStateOf(issue.id)).toBe(before)
    })

    it('finishes with no next step, and the ticket can still go to an engineer', async () => {
      const issue = await assign((await newOther()).id)
      const before = await trackerStateOf(issue.id)
      await advanceIssue(harness.deps.db, issue.id, { type: 'run.finished', result: 'completed' })
      expect((await rowOf(issue.id)).factoryState).toBe('done')
      expect((await latestRun(issue.id)).phase).toBe('task')
      expect(await trackerStateOf(issue.id)).toBe(before)

      await admin.ok('POST', `/api/issues/${issue.id}/assign`, { agentId: (await agentNamed('engineer-1')).id })
      expect(await latestRun(issue.id)).toMatchObject({ phase: 'implement', pipelineStep: 'implement' })
      expect((await latestRun(issue.id)).agentSnapshot.handle).toBe('engineer-1')
    })

    it('goes back to the same agent on a retry', async () => {
      const agent = await newOther()
      const issue = await assign(agent.id)
      await advanceIssue(harness.deps.db, issue.id, { type: 'run.finished', result: 'failed', retryable: false })
      expect((await rowOf(issue.id)).factoryState).toBe('failed')
      await admin.ok('POST', `/api/issues/${issue.id}/retry`)
      expect(await latestRun(issue.id)).toMatchObject({ phase: 'task', agentId: agent.id })
    })

    it('refuses to join a ticket that is being worked on, and changes nothing', async () => {
      const engineer = await agentNamed('engineer-1')
      const issue = await assign(engineer.id)
      const refused = await admin.request('POST', `/api/issues/${issue.id}/assign`, { agentId: (await newOther()).id })
      expect(refused.status).toBe(409)
      expect((await rowOf(issue.id)).assignedAgentId).toBe(engineer.id)
    })

    it('refuses to swap in an engineer while its task is running', async () => {
      const agent = await newOther()
      const issue = await assign(agent.id)
      const refused = await admin.request('POST', `/api/issues/${issue.id}/assign`, { agentId: (await agentNamed('engineer-1')).id })
      expect(refused.status).toBe(409)
      expect((await rowOf(issue.id)).assignedAgentId).toBe(agent.id)
    })

    it('can be stopped by removing the agent', async () => {
      const issue = await assign((await newOther()).id)
      await admin.ok('POST', `/api/issues/${issue.id}/assign`, { agentId: null })
      expect((await rowOf(issue.id)).factoryState).toBe('cancelled')
    })

    it('never gets engineer or review work, even as a project default', async () => {
      const agent = await newOther()
      await setDefaults({ defaultEngineerAgentId: agent.id, defaultReviewerAgentId: agent.id })
      const issue = await ticket()
      await harness.deps.db('issues').where({ id: issue.id }).update({ assignedAgentId: null })
      await advanceIssue(harness.deps.db, issue.id, { type: 'start' })
      expect((await latestRun(issue.id)).agentSnapshot.handle).toBe('engineer-1')
      await advanceIssue(harness.deps.db, issue.id, { type: 'run.finished', result: 'completed' })
      await advanceIssue(harness.deps.db, issue.id, { type: 'ci.settled' })
      expect((await latestRun(issue.id)).phase).toBe('review')
      expect((await latestRun(issue.id)).agentSnapshot.handle).toBe('reviewer-1')
      await setDefaults({ defaultEngineerAgentId: null, defaultReviewerAgentId: null })
    })

    it('has no stand-in when the assigned agent is disabled', async () => {
      const other = await newOther()
      await newOther()
      const issue = await ticket()
      await admin.ok('PUT', `/api/agents/${other.id}`, {
        handle: other.handle,
        displayName: other.displayName,
        archetypeId: other.archetype.id,
        runtime: 'claude',
        policy: POLICY,
        status: 'disabled',
      })
      await harness.deps.db('issues').where({ id: issue.id }).update({ assignedAgentId: other.id })
      await advanceIssue(harness.deps.db, issue.id, { type: 'start' })
      expect(await latestRun(issue.id)).toBeUndefined()
    })

    it('still takes an ad-hoc task', async () => {
      const agent = await newOther()
      const { run } = await admin.ok('POST', '/api/runs', { agentId: agent.id, gitUrl: 'https://gitlab.com/g/r.git', prompt: 'Look around.' })
      expect(run.phase).toBe('ad_hoc')
    })
  })

  describe('picking who does the work', () => {
    it('gives the ticket to an assigned agent from a custom archetype', async () => {
      const archetype = await newArchetype({ name: 'Backend engineer', systemPrompt: 'Mind the migrations.' })
      const agent = await newAgent(archetype.id, { systemPrompt: 'Also write the runbook.' })
      const issue = await assign(agent.id)
      const run = await latestRun(issue.id)
      expect(run.agentId).toBe(agent.id)
      expect(run.agentSnapshot.archetype).toEqual({ name: 'Backend engineer', role: 'engineer', systemPrompt: 'Mind the migrations.' })

      const prompt = renderSystemPrompt({ agent: run.agentSnapshot, skills: [], phase: 'implement', repoDocs: [] })
      expect(prompt).toContain('Your archetype on the team is Backend engineer')
      expect(prompt.indexOf('Mind the migrations.')).toBeGreaterThanOrEqual(0)
      expect(prompt.indexOf('Also write the runbook.')).toBeGreaterThan(prompt.indexOf('Mind the migrations.'))
      expect(prompt).not.toContain('undefined')
    })

    it('does not give an engineer step to an assigned agent that works as a reviewer', async () => {
      const issue = await assign((await agentNamed('reviewer-1')).id)
      expect(await handleOfRun(issue.id)).toBe('engineer-1')
    })

    it('follows a role change on the next ticket', async () => {
      const archetype = await newArchetype()
      const agent = await newAgent(archetype.id)
      expect(await handleOfRun((await assign(agent.id)).id)).toBe(agent.handle)
      await admin.ok('PUT', `/api/archetypes/${archetype.id}`, { role: 'reviewer' })
      expect(await handleOfRun((await assign(agent.id)).id)).toBe('engineer-1')
    })

    it('skips a project default with the wrong role', async () => {
      const reviewer = await agentNamed('reviewer-1')
      await setDefaults({ defaultEngineerAgentId: reviewer.id })
      const issue = await assign(reviewer.id)
      expect(await handleOfRun(issue.id)).toBe('engineer-1')
      await setDefaults({ defaultEngineerAgentId: null })
    })

    it('hands the review step to a custom reviewer', async () => {
      const archetype = await newArchetype({ name: 'Security reviewer', role: 'reviewer', systemPrompt: 'Look for injection.' })
      const reviewer = await newAgent(archetype.id)
      await setDefaults({ defaultReviewerAgentId: reviewer.id })
      const issue = await assign((await agentNamed('engineer-1')).id)
      await advanceIssue(harness.deps.db, issue.id, { type: 'run.finished', result: 'completed' })
      await advanceIssue(harness.deps.db, issue.id, { type: 'ci.settled' })
      const run = await latestRun(issue.id)
      expect(run).toMatchObject({ phase: 'review', agentId: reviewer.id })
      expect(run.agentSnapshot.archetype.name).toBe('Security reviewer')
      await setDefaults({ defaultReviewerAgentId: null })
    })

    it('uses an edited prompt from the next run and leaves earlier runs alone', async () => {
      const archetype = await newArchetype({ systemPrompt: 'Before the edit.' })
      const agent = await newAgent(archetype.id)
      const earlier = await assign(agent.id)
      await admin.ok('PUT', `/api/archetypes/${archetype.id}`, { systemPrompt: 'After the edit.' })
      const later = await assign(agent.id)
      expect((await latestRun(earlier.id)).agentSnapshot.archetype.systemPrompt).toBe('Before the edit.')
      expect((await latestRun(later.id)).agentSnapshot.archetype.systemPrompt).toBe('After the edit.')
    })
  })
})
