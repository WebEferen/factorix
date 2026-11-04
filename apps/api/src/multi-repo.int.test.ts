import { json } from '@factorix/db'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { projectRepos } from './services/repos'
import { handleScmEvent, mergeIssue } from './services/scm-inbound'
import { postTrackerComment } from './services/tracker-sync'
import { TEAM_ID } from './testing/fakes'
import { ApiClient, createHarness, type Harness } from './testing/harness'

const SETUP = { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' }
const STATE_MAP = { in_progress: 'st-progress', in_review: 'st-review', done: 'st-done', blocked: 'st-blocked' }
const FIRST = { scmRepoId: '42', scmRepoPath: 'g/r', scmCloneUrl: 'https://gitlab.com/g/r.git', defaultBranch: 'main' }
const SECOND = { scmRepoId: '43', scmRepoPath: 'g/s', scmCloneUrl: 'https://gitlab.com/g/s.git', defaultBranch: 'dev' }

describe('projects with several repositories', () => {
  let harness: Harness
  let admin: ApiClient
  let linearId: string
  let gitlabId: string
  let projectId: string

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', SETUP)
    linearId = (await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'x' })).connection.id
    gitlabId = (await admin.ok('POST', '/api/connections', { kind: 'gitlab', name: 'GitLab', secret: 'y', config: {} })).connection.id
    const { project } = await admin.ok('POST', '/api/projects', {
      name: 'Platform',
      trackerConnectionId: linearId,
      trackerTeamId: TEAM_ID,
      scmConnectionId: gitlabId,
      repos: [FIRST, { ...SECOND, setupCommands: ['yarn', 'yarn build'], checkCommands: ['yarn lint', 'yarn test'] }],
      stateMap: STATE_MAP,
    })
    projectId = project.id
  })
  afterAll(() => harness.destroy())

  const db = () => harness.deps.db
  const body = (repos: unknown[], name = 'Other') => ({
    name,
    trackerConnectionId: linearId,
    trackerTeamId: TEAM_ID,
    trackerProjectId: name,
    scmConnectionId: gitlabId,
    repos,
    stateMap: STATE_MAP,
  })
  const repoId = async (scmRepoId: string) => (await db()('project_repos').where({ projectId, scmRepoId }).first()).id as string

  async function issueAt(title: string, step: string) {
    const { issue } = await admin.ok('POST', `/api/projects/${projectId}/issues`, { title })
    await db()('issues')
      .where({ id: issue.id })
      .update({
        factoryState: 'awaiting_merge',
        branchName: `factorix/${issue.id}`,
        cursor: json({ step, enteredAt: new Date().toISOString(), loops: {}, attempts: {}, waitingFor: null }),
      })
    return issue.id as string
  }

  async function openMr(issueId: string, scmRepoId: string) {
    const mr = await harness.world
      .scm('t')
      .openMergeRequest({ repoId: scmRepoId, sourceBranch: `factorix/${issueId}`, targetBranch: 'main', title: 't', description: 'd' })
    await linkMr(issueId, scmRepoId, mr.iid, mr.url)
    return mr.iid
  }

  async function linkMr(issueId: string, scmRepoId: string, iid: number, url = `https://x/${scmRepoId}/${iid}`) {
    await db()('issue_merge_requests').insert({
      orgId: (await db()('issues').where({ id: issueId }).first()).orgId,
      issueId,
      repoId: await repoId(scmRepoId),
      repoPath: scmRepoId === '42' ? 'g/r' : 'g/s',
      mrId: String(iid),
      mrIid: iid,
      mrUrl: url,
      mrState: 'opened',
    })
  }

  const finished = (kind: 'mr.merged' | 'mr.closed', scmRepoId: string, iid: number) =>
    handleScmEvent(harness.deps, gitlabId, { kind, repoId: scmRepoId, iid, url: null, sourceBranch: null, sha: null })
  const issueRow = (id: string) => db()('issues').where({ id }).first()

  it('keeps the repositories in the order they were picked, each in its own folder', async () => {
    const { project } = await admin.ok('GET', `/api/projects/${projectId}`)
    expect(project.repos.map((repo: { name: string; scmRepoPath: string }) => [repo.name, repo.scmRepoPath])).toEqual([
      ['r', 'g/r'],
      ['s', 'g/s'],
    ])
    expect(project.repos[1]).toMatchObject({ defaultBranch: 'dev', setupCommands: ['yarn', 'yarn build'], checkCommands: ['yarn lint', 'yarn test'] })
  })

  it('gives repositories with the same short name different folders', async () => {
    const { project } = await admin.ok(
      'POST',
      '/api/projects',
      body(
        [
          { ...FIRST, scmRepoPath: 'one/app' },
          { ...SECOND, scmRepoPath: 'two/app' },
        ],
        'Same names',
      ),
    )
    expect(project.repos.map((repo: { name: string }) => repo.name)).toEqual(['app', 'app-2'])
  })

  it('needs at least one repository, each picked once', async () => {
    expect((await admin.request('POST', '/api/projects', body([]))).status).toBe(422)
    expect((await admin.request('POST', '/api/projects', body([FIRST, FIRST]))).status).toBe(422)
    expect((await admin.request('POST', '/api/projects', body([{ ...FIRST, checkCommands: ['  '] }]))).status).toBe(422)
  })

  it('reorders without renaming, and an update that names no repositories leaves them alone', async () => {
    const before = (await admin.ok('GET', `/api/projects/${projectId}`)).project.repos
    await admin.ok('PUT', `/api/projects/${projectId}`, { autonomy: 'human_merge' })
    expect((await admin.ok('GET', `/api/projects/${projectId}`)).project.repos).toEqual(before)

    const { project } = await admin.ok('PUT', `/api/projects/${projectId}`, { repos: [SECOND, FIRST] })
    expect(project.repos.map((repo: { id: string; name: string }) => [repo.id, repo.name])).toEqual([
      [before[1].id, 's'],
      [before[0].id, 'r'],
    ])
    await admin.ok('PUT', `/api/projects/${projectId}`, {
      repos: [FIRST, { ...SECOND, setupCommands: ['yarn', 'yarn build'], checkCommands: ['yarn lint', 'yarn test'] }],
    })
  })

  it('refuses to drop a repository while its merge request is open, and allows it once finished', async () => {
    const { project } = await admin.ok('POST', '/api/projects', body([FIRST, SECOND], 'Removal'))
    const { issue } = await admin.ok('POST', `/api/projects/${project.id}/issues`, { title: 'Open work' })
    const second = await db()('project_repos').where({ projectId: project.id, scmRepoId: '43' }).first()
    await db()('issue_merge_requests').insert({
      orgId: second.orgId,
      issueId: issue.id,
      repoId: second.id,
      repoPath: 'g/s',
      mrId: '1',
      mrIid: 1,
      mrUrl: 'https://x/1',
      mrState: 'opened',
    })
    const refused = await admin.request('PUT', `/api/projects/${project.id}`, { repos: [FIRST] })
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toContain('g/s')
    expect(await projectRepos(db(), project.id)).toHaveLength(2)

    await db()('issue_merge_requests').where({ issueId: issue.id }).update({ mrState: 'merged' })
    await admin.ok('PUT', `/api/projects/${project.id}`, { repos: [FIRST] })
    expect(await projectRepos(db(), project.id)).toHaveLength(1)
    const detail = (await admin.ok('GET', `/api/issues/${issue.id}`)).issue
    expect(detail.mergeRequests).toEqual([{ repoPath: 'g/s', iid: 1, url: 'https://x/1', state: 'merged' }])
  })

  it('registers a webhook on the tracker and on every repository', async () => {
    harness.world.webhooksRegistered = []
    const { results } = await admin.ok('POST', `/api/projects/${projectId}/webhooks`)
    expect(results.map((result: { kind: string; repoPath?: string }) => result.repoPath ?? result.kind)).toEqual(['linear', 'g/r', 'g/s'])
    expect(results.every((result: { registered: boolean }) => result.registered)).toBe(true)
    expect(harness.world.webhooksRegistered).toHaveLength(3)
  })

  it('finds the right issue when two repositories use the same merge request number', async () => {
    const first = await issueAt('Same number, first', 'await_merge')
    const second = await issueAt('Same number, second', 'await_merge')
    await linkMr(first, '42', 77)
    await linkMr(second, '43', 77)

    await finished('mr.merged', '43', 77)
    expect((await issueRow(second)).factoryState).toBe('done')
    expect((await issueRow(first)).factoryState).toBe('awaiting_merge')
    expect((await db()('issue_merge_requests').where({ issueId: first }).first()).mrState).toBe('opened')
  })

  it('attaches a thread to the repository it was written in', async () => {
    const issueId = await issueAt('Threads', 'await_merge')
    await linkMr(issueId, '42', 80)
    await linkMr(issueId, '43', 80)
    await handleScmEvent(harness.deps, gitlabId, {
      kind: 'mr.note',
      repoId: '43',
      iid: 80,
      discussionId: 'thread-1',
      note: {
        id: 'n1',
        body: 'Look at !5',
        author: 'sam',
        system: false,
        path: 'a.ts',
        line: 1,
        createdAt: new Date().toISOString(),
        resolvable: true,
        resolved: false,
      },
    })
    const detail = (await admin.ok('GET', `/api/issues/${issueId}`)).issue
    expect(detail.discussions[0].repoPath).toBe('g/s')
    expect(detail.discussions[0].body).toContain('[!5](https://gitlab.com/g/s/-/merge_requests/5)')
  })

  it('finishes an issue only when every merge request is finished', async () => {
    const issueId = await issueAt('Both merge', 'await_merge')
    await linkMr(issueId, '42', 90)
    await linkMr(issueId, '43', 91)

    await finished('mr.merged', '42', 90)
    expect((await issueRow(issueId)).factoryState).toBe('awaiting_merge')
    await finished('mr.merged', '43', 91)
    expect((await issueRow(issueId)).factoryState).toBe('done')
  })

  it('treats one closed and one merged as done, and all closed as cancelled', async () => {
    const mixed = await issueAt('One closed', 'await_merge')
    await linkMr(mixed, '42', 92)
    await linkMr(mixed, '43', 93)
    await finished('mr.closed', '42', 92)
    expect((await issueRow(mixed)).factoryState).toBe('awaiting_merge')
    await finished('mr.merged', '43', 93)
    expect((await issueRow(mixed)).factoryState).toBe('done')

    const abandoned = await issueAt('All closed', 'await_merge')
    await linkMr(abandoned, '42', 94)
    await linkMr(abandoned, '43', 95)
    await finished('mr.closed', '42', 94)
    await finished('mr.closed', '43', 95)
    expect((await issueRow(abandoned)).factoryState).toBe('cancelled')
  })

  describe('merging', () => {
    it('merges in the order the agent chose for this ticket', async () => {
      const issueId = await issueAt('Backend first', 'auto_merge')
      const first = await openMr(issueId, '42')
      const second = await openMr(issueId, '43')
      await db()('issue_merge_requests').where({ issueId, mrIid: second }).update({ mergePosition: 0 })
      await db()('issue_merge_requests').where({ issueId, mrIid: first }).update({ mergePosition: 1 })
      expect((await admin.ok('GET', `/api/issues/${issueId}`)).issue.mergeRequests.map((mr: { iid: number }) => mr.iid)).toEqual([second, first])
      harness.world.merges = []
      await mergeIssue(harness.deps, issueId)
      expect(harness.world.merges).toEqual([second, first])
    })

    it('falls back to the picked order when the agent named none', async () => {
      const issueId = await issueAt('Ordered', 'auto_merge')
      const second = await openMr(issueId, '43')
      const first = await openMr(issueId, '42')
      harness.world.merges = []
      await mergeIssue(harness.deps, issueId)
      expect(harness.world.merges).toEqual([first, second])
      expect((await issueRow(issueId)).factoryState).toBe('done')
    })

    it('merges nothing when any repository has red CI', async () => {
      const issueId = await issueAt('Red CI', 'auto_merge')
      const first = await openMr(issueId, '42')
      const second = await openMr(issueId, '43')
      harness.world.ciByIid.set(second, { status: 'failed', failedJobs: [] })
      harness.world.merges = []
      await mergeIssue(harness.deps, issueId)
      expect(harness.world.merges).toEqual([])
      expect((await issueRow(issueId)).cursor.step).toBe('merge_blocked')
      expect((await db()('issue_merge_requests').where({ issueId, mrIid: first }).first()).mrState).toBe('opened')
    })

    it('stops at a refused merge, remembers what landed, and names what is left', async () => {
      const issueId = await issueAt('Refused', 'auto_merge')
      const first = await openMr(issueId, '42')
      const second = await openMr(issueId, '43')
      harness.world.refuseMerge.add(second)
      harness.world.merges = []
      await mergeIssue(harness.deps, issueId)
      expect(harness.world.merges).toEqual([first])
      expect((await issueRow(issueId)).cursor.step).toBe('merge_blocked')
      expect((await db()('issue_merge_requests').where({ issueId, mrIid: first }).first()).mrState).toBe('merged')

      const approval = await db()('approvals').where({ issueId, kind: 'merge', status: 'pending' }).first()
      expect(approval.payload.mergeRequests.map((mr: { iid: number }) => mr.iid)).toEqual([first, second])

      await postTrackerComment(harness.deps, { issueId, template: 'merge_blocked' })
      const comment = harness.world.comments.at(-1)?.body ?? ''
      expect(comment).toContain(`https://gitlab.example/g/s/-/merge_requests/${second}`)
      expect(comment).not.toContain(`merge_requests/${first}`)

      harness.world.refuseMerge.delete(second)
      harness.world.merges = []
      await db()('issues')
        .where({ id: issueId })
        .update({ cursor: json({ step: 'auto_merge', enteredAt: new Date().toISOString(), loops: {}, attempts: {}, waitingFor: null }) })
      await mergeIssue(harness.deps, issueId)
      expect(harness.world.merges).toEqual([second])
      expect((await issueRow(issueId)).factoryState).toBe('done')
    })
  })

  it('shows merge requests in repository order on lists and details', async () => {
    const issueId = await issueAt('Display order', 'await_merge')
    await linkMr(issueId, '43', 101)
    await linkMr(issueId, '42', 100)
    const expected = [
      { repoPath: 'g/r', iid: 100, url: 'https://x/42/100', state: 'opened' },
      { repoPath: 'g/s', iid: 101, url: 'https://x/43/101', state: 'opened' },
    ]
    expect((await admin.ok('GET', `/api/issues/${issueId}`)).issue.mergeRequests).toEqual(expected)
    const { issues } = await admin.ok('GET', `/api/issues?projectId=${projectId}&search=Display%20order`)
    expect(issues[0].mergeRequests).toEqual(expected)
  })

  it('links a bare merge request number to where it lives, or the first repository', async () => {
    const { issue } = await admin.ok('POST', `/api/projects/${projectId}/issues`, {
      title: 'Refs',
      description: 'Known !200, unknown !201, and g/s!5',
    })
    await linkMr(issue.id, '43', 200, 'https://gitlab.com/g/s/-/merge_requests/200')
    const detail = (await admin.ok('GET', `/api/issues/${issue.id}`)).issue
    expect(detail.description).toContain('[!200](https://gitlab.com/g/s/-/merge_requests/200)')
    expect(detail.description).toContain('[!201](https://gitlab.com/g/r/-/merge_requests/201)')
  })
})
