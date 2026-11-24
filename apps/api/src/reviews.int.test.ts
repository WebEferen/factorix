import { randomUUID } from 'node:crypto'
import { isFactoryScmBody } from '@factorix/core'
import type { IssueRow, ProjectRow, RunRow } from '@factorix/db'
import type { RunEventBody } from '@factorix/runtime'
import type { SandboxProvider, Workspace } from '@factorix/sandbox'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { finalizePhase } from './services/finalize'
import { TEAM_ID } from './testing/fakes'
import { ApiClient, createHarness, type Harness } from './testing/harness'

const SETUP = { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' }
const STATE_MAP = { in_progress: 'st-progress', in_review: 'st-review', done: 'st-done', blocked: 'st-blocked' }
const REPO = { scmRepoId: '42', scmRepoPath: 'g/r', scmCloneUrl: 'https://gitlab.com/g/r.git', defaultBranch: 'main' }

describe('a reviewer’s verdict on the merge request', () => {
  let harness: Harness
  let admin: ApiClient
  let projectId: string
  let agents = 0

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', SETUP)
    const linearId = (await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'x' })).connection.id
    const gitlabId = (await admin.ok('POST', '/api/connections', { kind: 'gitlab', name: 'GitLab', secret: 'y', config: {} })).connection.id
    projectId = (
      await admin.ok('POST', '/api/projects', {
        name: 'Platform',
        trackerConnectionId: linearId,
        trackerTeamId: TEAM_ID,
        scmConnectionId: gitlabId,
        repos: [REPO],
        stateMap: STATE_MAP,
      })
    ).project.id
  })
  afterAll(() => harness.destroy())

  const db = () => harness.deps.db

  async function reviewer(connectionIds: string[] = []): Promise<string> {
    agents += 1
    const archetypeId = (await admin.ok('GET', '/api/archetypes')).archetypes[0].id
    const { agent } = await admin.ok('POST', '/api/agents', {
      handle: `verdict-${agents}`,
      displayName: `Verdict ${agents}`,
      archetypeId,
      runtime: 'claude',
      policy: { mode: 'full' },
      connectionIds,
    })
    return agent.id
  }

  async function review(agentId: string, verdict: 'approve' | 'request_changes') {
    const { issue } = await admin.ok('POST', `/api/projects/${projectId}/issues`, { title: 'Add a heading' })
    const mr = await harness.world
      .scm('t')
      .openMergeRequest({ repoId: REPO.scmRepoId, sourceBranch: `factorix/${issue.id}`, targetBranch: 'main', title: 't', description: 'd' })
    const issueRow = (await db()('issues').where({ id: issue.id }).first()) as IssueRow
    const project = (await db()('projects').where({ id: projectId }).first()) as ProjectRow
    const repo = await db()('project_repos').where({ projectId, scmRepoId: REPO.scmRepoId }).first()
    await db()('issue_merge_requests').insert({
      orgId: issueRow.orgId,
      issueId: issue.id,
      repoId: repo.id,
      repoPath: REPO.scmRepoPath,
      mrId: mr.id,
      mrIid: mr.iid,
      mrUrl: mr.url,
      mrState: 'opened',
    })
    const logs: RunEventBody[] = []
    const { result } = await finalizePhase({
      db: db(),
      sandbox: {} as SandboxProvider,
      workspace: {} as Workspace,
      run: { id: randomUUID(), orgId: issueRow.orgId, phase: 'review', agentId } as RunRow,
      issue: issueRow,
      project,
      scm: harness.world.scm('t'),
      repos: [],
      branch: `factorix/${issue.id}`,
      agentHandle: 'reviewer',
      outcome: 'completed',
      structuredOutput: { verdict, summary: 'Needs a heading.', comments: [] },
      log: (body) => logs.push(body),
      refresh: async () => ({ conflicts: [] }),
    })
    const messages = logs.flatMap((body) => (body.type === 'log' ? [body.message] : []))
    return { iid: mr.iid, result, messages }
  }

  it('requests changes as Factorix’s own text, and says to give the reviewer its own account when the server refuses', async () => {
    const { iid, result, messages } = await review(await reviewer(), 'request_changes')
    expect(result).toBe('verdict:request_changes')
    const requests = harness.world.changeRequests.filter((request) => request.iid === iid)
    expect(requests).toHaveLength(1)
    expect(isFactoryScmBody(requests[0]?.body ?? '')).toBe(true)
    expect(harness.world.approvals).not.toContain(iid)
    expect(messages).toContainEqual(expect.stringContaining('Give the reviewer agent its own git account'))
  })

  it('leaves the account advice out for a reviewer that already has its own', async () => {
    const own = (await admin.ok('POST', '/api/connections', { kind: 'gitlab', name: 'Reviewer git', secret: 'z', config: {} })).connection.id
    const { messages } = await review(await reviewer([own]), 'request_changes')
    expect(messages).toContainEqual(expect.stringContaining('refused the change request'))
    expect(messages.join('\n')).not.toContain('its own git account')
  })

  it('approves without requesting changes', async () => {
    const { iid, result } = await review(await reviewer(), 'approve')
    expect(result).toBe('verdict:approve')
    expect(harness.world.approvals).toContain(iid)
    expect(harness.world.changeRequests.some((request) => request.iid === iid)).toBe(false)
  })
})
