import type { IssueRow, ProjectRow, RunRow } from '@factorix/db'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { agentRedactor } from './services/redact'
import { buildRunSpec, readIssueResources } from './services/spec'
import { TEAM_ID } from './testing/fakes'
import { ApiClient, createHarness, type Harness } from './testing/harness'

describe('resources attached to an issue', () => {
  let harness: Harness
  let project: ProjectRow
  let issue: IssueRow
  let admin: ApiClient
  const document = { kind: 'document' as const, title: 'ABC-1 Spec', url: 'https://linear.app/x/document/spec', subtitle: null, content: '# Spec' }

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    const linear = (await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'lin-token' })).connection.id
    const gitlab = (await admin.ok('POST', '/api/connections', { kind: 'gitlab', name: 'GitLab', secret: 'git-token', config: {} })).connection.id
    const created = await admin.ok('POST', '/api/projects', {
      name: 'App',
      trackerConnectionId: linear,
      trackerTeamId: TEAM_ID,
      trackerProjectId: null,
      scmConnectionId: gitlab,
      repos: [{ scmRepoId: '42', scmRepoPath: 'g/r', scmCloneUrl: 'https://gitlab.com/g/r.git', defaultBranch: 'main' }],
      stateMap: { in_progress: 'st-progress', in_review: 'st-review', done: 'st-done', blocked: 'st-blocked' },
    })
    project = await harness.deps.db('projects').where({ id: created.project.id }).first()
    issue = (
      await harness.deps
        .db('issues')
        .insert({ orgId: project.orgId, projectId: project.id, trackerIssueId: 't-1', identifier: 'ABC-1', title: 'Issue 1' })
        .returning('*')
    )[0]
  })
  afterAll(() => harness.destroy())

  const runOf = () => ({ orgId: project.orgId, agentId: null }) as unknown as RunRow

  it('reads them with the project’s tracker account', async () => {
    harness.world.resources.set('t-1', [document])
    const warnings: string[] = []
    expect(await readIssueResources(harness.deps, { run: runOf(), issue, project }, (message) => warnings.push(message))).toEqual({
      resources: [document],
      files: [],
    })
    expect(harness.world.resourceTokens.at(-1)).toBe('lin-token')
    expect(warnings).toEqual([])
  })

  it('leaves them out with a warning when the tracker fails, so the run goes on', async () => {
    harness.world.failResources = 'Linear is down'
    try {
      const warnings: string[] = []
      expect(await readIssueResources(harness.deps, { run: runOf(), issue, project }, (message) => warnings.push(message))).toEqual({
        resources: [],
        files: [],
      })
      expect(warnings).toEqual(['Could not read the documents and links attached to ABC-1: Linear is down'])
    } finally {
      harness.world.failResources = null
    }
  })

  it('puts them in the agent’s prompt', async () => {
    const { agents } = await admin.ok('GET', '/api/agents')
    const { run } = await admin.ok('POST', '/api/runs', { agentId: agents[0].id, prompt: 'Look', gitUrl: 'file:///remote/repo.git' })
    const row = (await harness.deps.db('runs').where({ id: run.id }).first()) as RunRow
    const spec = await buildRunSpec(harness.deps, {
      run: { ...row, issueId: issue.id, phase: 'implement', adHoc: null },
      issue,
      project,
      repos: [{ name: 'r', path: 'g/r', baseBranch: 'main' }],
      branch: 'factorix/abc-1',
      repoDocs: [],
      ciFailures: [],
      extraNotes: [],
      resources: [document],
    })
    expect(spec.prompt.user).toContain('<issue_resources>\nDocument: ABC-1 Spec\nhttps://linear.app/x/document/spec\n\n# Spec\n</issue_resources>')
  })

  it('copies files and description uploads for the container, masks secrets, and points the description at the copies', async () => {
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d])
    const [described] = await harness.deps
      .db('issues')
      .insert({
        orgId: project.orgId,
        projectId: project.id,
        trackerIssueId: 't-2',
        identifier: 'ABC-2',
        title: 'Issue 2',
        description: 'It breaks like this: ![image.png](https://uploads.linear.app/o/i/1)',
      })
      .returning('*')
    const apiKey = `lin_api_${'a'.repeat(40)}`
    harness.world.resources.set('t-2', [
      {
        kind: 'document',
        title: 'Runbook',
        url: 'https://linear.app/x/document/runbook',
        subtitle: null,
        content: `Deploy with git-token and ${apiKey}`,
      },
      { kind: 'file', title: 'app.log', url: 'https://uploads.linear.app/o/l/2', subtitle: null, content: null },
      { kind: 'file', title: 'dump.bin', url: 'https://uploads.linear.app/o/d/3', subtitle: null, content: null },
      { kind: 'file', title: 'gone.txt', url: 'https://uploads.linear.app/o/g/4', subtitle: null, content: null },
    ])
    harness.world.media.set('https://uploads.linear.app/o/l/2', { contentType: 'text/plain', body: 'pushing with git-token\nok\n' })
    harness.world.media.set('https://uploads.linear.app/o/d/3', { contentType: 'application/octet-stream', body: new Uint8Array(11 * 1024 * 1024) })
    harness.world.media.set('https://uploads.linear.app/o/i/1', { contentType: 'image/png', body: image })

    const warnings: string[] = []
    const warn = (message: string) => warnings.push(message)
    const redact = await agentRedactor(harness.deps, { orgId: project.orgId, projectId: project.id }, warn)
    const { resources, files } = await readIssueResources(harness.deps, { run: runOf(), issue: described, project }, warn, redact)
    expect(files.map((file) => file.name)).toEqual(['1-app.log', '2-image.png'])
    expect(Buffer.from(files[0]?.content ?? '', 'base64').toString()).toBe('pushing with [secret removed]\nok\n')
    expect(new Uint8Array(Buffer.from(files[1]?.content ?? '', 'base64'))).toEqual(image)
    expect(resources.map((resource) => [resource.title, resource.path ?? resource.note])).toEqual([
      ['Runbook', undefined],
      ['app.log', '/workspace/.factorix/issue-files/1-app.log'],
      ['dump.bin', 'it is over 10 MB'],
      ['gone.txt', 'the tracker did not return it'],
      ['image.png', '/workspace/.factorix/issue-files/2-image.png'],
    ])
    expect(warnings).toEqual([])

    const { agents } = await admin.ok('GET', '/api/agents')
    const { run } = await admin.ok('POST', '/api/runs', { agentId: agents[0].id, prompt: 'Look', gitUrl: 'file:///remote/repo.git' })
    const row = (await harness.deps.db('runs').where({ id: run.id }).first()) as RunRow
    const spec = await buildRunSpec(harness.deps, {
      run: { ...row, issueId: described.id, phase: 'implement', adHoc: null },
      issue: described,
      project,
      repos: [{ name: 'r', path: 'g/r', baseBranch: 'main' }],
      branch: 'factorix/abc-2',
      repoDocs: [],
      ciFailures: [],
      extraNotes: [],
      resources,
      files,
      redact,
    })
    expect(spec.files).toEqual(files)
    expect(spec.prompt.user).toContain('It breaks like this: ![image.png](/workspace/.factorix/issue-files/2-image.png)')
    expect(spec.prompt.user).toContain('Deploy with [secret removed] and [secret removed]')
    expect(spec.prompt.user).toContain('File: dump.bin\nNot copied: it is over 10 MB')
    expect(spec.prompt.user).not.toContain('git-token')
    expect(spec.prompt.user).not.toContain('uploads.linear.app/o/l/2')
  })

  it('reads nothing for a run without an issue', async () => {
    const before = harness.world.resourceTokens.length
    expect(await readIssueResources(harness.deps, { run: runOf(), issue: null, project }, () => undefined)).toEqual({ resources: [], files: [] })
    expect(harness.world.resourceTokens).toHaveLength(before)
  })
})
