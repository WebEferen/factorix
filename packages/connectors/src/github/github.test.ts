import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type StubServer, startStubServer } from '../testing/stub-server'
import { GithubConnector, githubEndpoints } from './client'
import { githubWebhookCodec } from './webhook'

const rawPull = {
  id: 100,
  node_id: 'PR_1',
  number: 7,
  html_url: 'https://github.example/o/r/pull/7',
  state: 'open',
  draft: false,
  title: 'ABC-1: Fix',
  body: 'body',
  head: { ref: 'factorix/abc-1-fix', sha: 'h', repo: { id: 42 } },
  base: { ref: 'main', sha: 'b', repo: { id: 42 } },
  mergeable: true,
  mergeable_state: 'clean',
}
const REPO = '/api/v3/repositories/42'

describe('GithubConnector against a stub server', () => {
  let stub: StubServer
  let github: GithubConnector

  beforeAll(async () => {
    stub = await startStubServer()
    github = new GithubConnector({ token: 'ghp_test', host: stub.url })
  })
  afterAll(() => stub.close())

  const route = (routes: Record<string, unknown>) =>
    stub.handle((request) => {
      const body = routes[`${request.method} ${request.path}`]
      return body === undefined ? undefined : { body }
    })
  const last = () => stub.requests.at(-1)
  const sent = (method: string, path: string) => stub.requests.findLast((request) => request.method === method && request.path === path)

  it('uses the public API hosts for GitHub.com and a path on a self-hosted server', () => {
    expect(githubEndpoints(undefined)).toEqual({
      web: 'https://github.com',
      rest: 'https://api.github.com',
      graphql: 'https://api.github.com/graphql',
    })
    expect(githubEndpoints('https://git.acme.dev/')).toMatchObject({
      rest: 'https://git.acme.dev/api/v3',
      graphql: 'https://git.acme.dev/api/graphql',
    })
  })

  it('authenticates with a bearer token and filters repositories by name', async () => {
    const repo = (id: number, name: string) => ({
      id,
      name,
      full_name: `o/${name}`,
      clone_url: `https://github.example/o/${name}.git`,
      html_url: `https://github.example/o/${name}`,
      default_branch: 'main',
    })
    route({ 'GET /api/v3/user/repos': [repo(42, 'r'), repo(43, 'other')] })
    expect(await github.listRepos('O/R')).toEqual([
      { id: '42', path: 'o/r', name: 'r', cloneUrl: 'https://github.example/o/r.git', webUrl: 'https://github.example/o/r', defaultBranch: 'main' },
    ])
    expect(sent('GET', '/api/v3/user/repos')?.headers.authorization).toBe('Bearer ghp_test')
  })

  it('opens a pull request and maps it', async () => {
    route({ [`POST ${REPO}/pulls`]: rawPull })
    const mr = await github.openMergeRequest({
      repoId: '42',
      sourceBranch: 'factorix/abc-1-fix',
      targetBranch: 'main',
      title: 'ABC-1: Fix',
      description: 'body',
    })
    expect(mr).toMatchObject({
      id: '100',
      iid: 7,
      state: 'opened',
      sourceBranch: 'factorix/abc-1-fix',
      targetBranch: 'main',
      sha: 'h',
      mergeBlocker: null,
      diffRefs: { baseSha: 'b', headSha: 'h', startSha: 'b' },
    })
    expect(last()?.body).toEqual({ title: 'ABC-1: Fix', body: 'body', head: 'factorix/abc-1-fix', base: 'main' })
  })

  it('finds an existing open pull request by its branch', async () => {
    route({ [`GET ${REPO}`]: { id: 42, owner: { login: 'o' } }, [`GET ${REPO}/pulls`]: [{ number: 7 }], [`GET ${REPO}/pulls/7`]: rawPull })
    expect((await github.findOpenMergeRequest('42', 'factorix/abc-1-fix'))?.iid).toBe(7)
    expect(sent('GET', `${REPO}/pulls`)?.query.get('head')).toBe('o:factorix/abc-1-fix')
    route({ [`GET ${REPO}`]: { id: 42, owner: { login: 'o' } }, [`GET ${REPO}/pulls`]: [] })
    expect(await github.findOpenMergeRequest('42', 'x')).toBeNull()
  })

  it('reads state and merge blockers', async () => {
    const read = async (fields: Record<string, unknown>) => {
      route({ [`GET ${REPO}/pulls/7`]: { ...rawPull, ...fields } })
      return github.getMergeRequest('42', 7)
    }
    expect((await read({ state: 'closed', merged: true })).state).toBe('merged')
    expect((await read({ state: 'closed' })).state).toBe('closed')
    expect((await read({ mergeable: null, mergeable_state: 'unknown' })).mergeBlocker).toBeNull()
    expect((await read({ mergeable_state: 'unstable' })).mergeBlocker).toBeNull()
    expect(await read({ mergeable: false, mergeable_state: 'dirty' })).toMatchObject({ hasConflicts: true, mergeBlocker: 'it has merge conflicts' })
    expect((await read({ mergeable_state: 'blocked' })).mergeBlocker).toContain('branch protection')
    expect((await read({ draft: true })).mergeBlocker).toBe('it is a draft')
    expect((await read({ state: 'closed', mergeable_state: 'dirty' })).mergeBlocker).toBeNull()
  })

  it('comments on a line of the diff and replies in the thread', async () => {
    route({
      [`POST ${REPO}/pulls/7/comments`]: { id: 55 },
      [`POST ${REPO}/pulls/7/comments/55/replies`]: { id: 56 },
      [`POST ${REPO}/issues/7/comments`]: { id: 9 },
    })
    const refs = { baseSha: 'b', headSha: 'h', startSha: 'b' }
    expect(await github.postDiffDiscussion('42', 7, { path: 'a.ts', line: 3, side: 'old', body: 'bug', diffRefs: refs })).toEqual({
      discussionId: 'r55',
    })
    expect(last()?.body).toEqual({ body: 'bug', commit_id: 'h', path: 'a.ts', line: 3, side: 'LEFT' })
    await github.replyDiscussion('42', 7, 'r55', 'done')
    expect(last()?.path).toBe(`${REPO}/pulls/7/comments/55/replies`)
    await github.replyDiscussion('42', 7, 'c9', 'answer')
    expect(last()?.path).toBe(`${REPO}/issues/7/comments`)
    expect(await github.postNote('42', 7, 'note')).toEqual({ noteId: 'c9' })
  })

  const thread = {
    id: 'T_1',
    isResolved: true,
    comments: {
      nodes: [
        { databaseId: 55, body: 'why', path: 'a.ts', line: 4, createdAt: 'now', author: { login: 'sam' } },
        { databaseId: 56, body: 'because', path: 'a.ts', line: null, originalLine: 4, createdAt: 'later', author: { login: 'bot' } },
      ],
    },
  }
  const threads = { data: { node: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [thread] } } } }

  it('lists conversation comments, review texts, and review threads as discussions', async () => {
    route({
      [`GET ${REPO}/pulls/7`]: rawPull,
      [`GET ${REPO}/issues/7/comments`]: [{ id: 9, body: 'hello', user: { login: 'sam' }, created_at: 'now' }],
      [`GET ${REPO}/pulls/7/reviews`]: [
        { id: 3, body: 'needs work', state: 'CHANGES_REQUESTED', user: { login: 'sam' }, submitted_at: 'now' },
        { id: 4, body: '', state: 'APPROVED', user: { login: 'sam' }, submitted_at: 'now' },
      ],
      'POST /api/graphql': threads,
    })
    const discussions = await github.listDiscussions('42', 7)
    expect(discussions.map((discussion) => [discussion.id, discussion.notes.map((note) => note.id)])).toEqual([
      ['c9', ['c9']],
      ['v3', ['v3']],
      ['r55', ['r55', 'r56']],
    ])
    expect(discussions[2]?.notes[1]).toEqual({
      id: 'r56',
      body: 'because',
      author: 'bot',
      system: false,
      path: 'a.ts',
      line: 4,
      createdAt: 'later',
      resolvable: true,
      resolved: true,
    })
    expect(sent('POST', '/api/graphql')?.body.variables).toEqual({ id: 'PR_1', after: null })
  })

  it('looks beyond five pages of comments and review threads when checking receipts', async () => {
    stub.handle((request) => {
      if (request.path === `${REPO}/pulls/7`) return { body: rawPull }
      if (request.path === `${REPO}/pulls/7/reviews`) return { body: [] }
      if (request.path === `${REPO}/issues/7/comments`) {
        const page = Number(request.query.get('page'))
        return { body: page === 6 ? [{ id: 501, body: 'summary receipt' }] : Array.from({ length: 100 }, (_, id) => ({ id })) }
      }
      if (request.path === '/api/graphql') {
        const page = Number(request.body.variables.after ?? 0) + 1
        const reviewThreads = { pageInfo: { hasNextPage: page < 6, endCursor: String(page) }, nodes: page === 6 ? [thread] : [] }
        return { body: { data: { node: { reviewThreads } } } }
      }
    })
    expect(await github.listDiscussions('42', 7)).toHaveLength(500)
    expect((await github.listDiscussions('42', 7, { allPages: true })).slice(-2).map(({ id }) => id)).toEqual(['c501', 'r55'])
  })

  it('resolves a review thread by its first comment, and has nothing to resolve on a conversation comment', async () => {
    route({ [`GET ${REPO}/pulls/7`]: rawPull, 'POST /api/graphql': threads })
    const before = stub.requests.length
    await github.resolveDiscussion('42', 7, 'c9', true)
    expect(stub.requests.length).toBe(before)
    await github.resolveDiscussion('42', 7, 'r55', true)
    expect(last()?.body.query).toContain('resolveReviewThread')
    expect(last()?.body.variables).toEqual({ id: 'T_1' })
    await github.resolveDiscussion('42', 7, 'r55', false)
    expect(last()?.body.query).toContain('unresolveReviewThread')
    await expect(github.resolveDiscussion('42', 7, 'r1', true)).rejects.toThrow('No review thread')
  })

  it('treats a refused self-approval as a soft failure', async () => {
    stub.handle((request) =>
      request.path.endsWith('/reviews')
        ? { status: 422, body: { message: 'Unprocessable Entity', errors: ['Can not approve your own pull request'] } }
        : undefined,
    )
    expect(await github.approve('42', 7)).toBe(false)
    route({ [`POST ${REPO}/pulls/7/reviews`]: { id: 1 } })
    expect(await github.approve('42', 7)).toBe(true)
    expect(last()?.body).toEqual({ event: 'APPROVE' })
  })

  it('does not submit an approval the host already accepted for this run', async () => {
    const receipt = '<!-- factorix:review=run/approval -->'
    const path = `${REPO}/pulls/7/reviews`
    route({ [`GET ${path}`]: [], [`POST ${path}`]: { id: 1 } })
    expect(await github.approve('42', 7, receipt)).toBe(true)
    expect(last()?.body).toEqual({ event: 'APPROVE', body: receipt })

    route({ [`GET ${path}`]: [{ id: 1, state: 'APPROVED', body: receipt }] })
    expect(await github.approve('42', 7, receipt)).toBe(true)
    expect(last()?.method).toBe('GET')
  })

  it('reads CI from every check and status on the head commit', async () => {
    const ci = async (runs: unknown[], statuses: unknown[]) => {
      route({
        [`GET ${REPO}/pulls/7`]: rawPull,
        [`GET ${REPO}/commits/h/check-runs`]: { check_runs: runs },
        [`GET ${REPO}/commits/h/status`]: { state: 'pending', statuses },
      })
      return github.getCiStatus('42', 7)
    }
    const failedRun = {
      id: 1,
      name: 'test',
      status: 'completed',
      conclusion: 'failure',
      html_url: 'j',
      app: { slug: 'other', name: 'Other CI' },
      output: { summary: 'boom' },
    }
    expect(await ci([], [])).toEqual({ status: 'none', failedJobs: [] })
    expect((await ci([{ status: 'queued' }], [])).status).toBe('pending')
    expect((await ci([failedRun, { status: 'in_progress' }], [])).status).toBe('running')
    expect((await ci([{ status: 'completed', conclusion: 'success' }], [{ state: 'pending' }])).status).toBe('pending')
    expect((await ci([{ status: 'completed', conclusion: 'skipped' }], [])).status).toBe('skipped')
    expect(
      (
        await ci(
          [
            { status: 'completed', conclusion: 'success' },
            { status: 'completed', conclusion: 'skipped' },
          ],
          [{ state: 'success' }],
        )
      ).status,
    ).toBe('success')
    const failed = await ci(
      [failedRun, { status: 'completed', conclusion: 'success' }],
      [{ state: 'error', context: 'deploy', target_url: 'd', description: 'no' }],
    )
    expect(failed).toMatchObject({ status: 'failed', pipelineId: 'h', webUrl: 'https://github.example/o/r/pull/7/checks' })
    expect(failed.failedJobs).toEqual([
      { name: 'test', stage: 'Other CI', webUrl: 'j', logTail: 'boom' },
      { name: 'deploy', stage: 'status', webUrl: 'd', logTail: 'no' },
    ])
  })

  describe('merging', () => {
    const merge = (repo: Record<string, unknown>, input: Parameters<GithubConnector['merge']>[2]) => {
      route({
        [`GET ${REPO}`]: { id: 42, ...repo },
        [`GET ${REPO}/pulls/7`]: rawPull,
        [`PUT ${REPO}/pulls/7/merge`]: { merged: true },
        [`DELETE ${REPO}/git/refs/heads/factorix/abc-1-fix`]: {},
      })
      return github.merge('42', 7, input)
    }

    it('squashes at the reviewed commit and removes the branch', async () => {
      expect(await merge({}, { sha: 'h', squash: true })).toEqual({ merged: true })
      expect(sent('PUT', `${REPO}/pulls/7/merge`)?.body).toEqual({ sha: 'h', merge_method: 'squash' })
      expect(last()?.method).toBe('DELETE')
    })

    it('uses a method the repository allows, and keeps the branch when asked', async () => {
      await merge({ allow_squash_merge: false }, { squash: true, removeSourceBranch: false })
      expect(last()?.body).toEqual({ merge_method: 'merge' })
      await merge({ allow_merge_commit: false }, { removeSourceBranch: false })
      expect(last()?.body).toEqual({ merge_method: 'squash' })
      await merge({ allow_merge_commit: false, allow_squash_merge: false }, { removeSourceBranch: false })
      expect(last()?.body).toEqual({ merge_method: 'rebase' })
    })

    it('reports a refusal as a reason', async () => {
      stub.handle((request) => {
        if (request.method === 'PUT') return { status: 405, body: { message: 'Pull Request is not mergeable' } }
        return { body: request.path.endsWith('/pulls/7') ? rawPull : { id: 42 } }
      })
      expect(await github.merge('42', 7, {})).toEqual({ merged: false, reason: 'Pull Request is not mergeable' })
    })
  })

  it('closes a pull request', async () => {
    route({ [`PATCH ${REPO}/pulls/7`]: rawPull })
    await github.closeMergeRequest('42', 7)
    expect(last()?.body).toEqual({ state: 'closed' })
  })

  describe('reverting a pull request', () => {
    const input = { branch: 'factorix/revert-7-x', title: 'ABC-1: revert', description: 'why' }

    it('asks GitHub to open the revert and returns it', async () => {
      route({
        [`GET ${REPO}/pulls/7`]: { ...rawPull, state: 'closed', merged: true },
        [`GET ${REPO}/pulls/8`]: { ...rawPull, number: 8 },
        'POST /api/graphql': { data: { revertPullRequest: { revertPullRequest: { number: 8 } } } },
      })
      expect(await github.revertMergeRequest('42', 7, input)).toMatchObject({ reverted: true, mergeRequest: { iid: 8 } })
      expect(sent('POST', '/api/graphql')?.body.variables).toEqual({ id: 'PR_1', title: 'ABC-1: revert', body: 'why' })
    })

    it('reports a conflict as a reason, and refuses a pull request that never merged', async () => {
      route({
        [`GET ${REPO}/pulls/7`]: { ...rawPull, state: 'closed', merged: true },
        'POST /api/graphql': { errors: [{ message: 'Could not revert: conflicts' }] },
      })
      expect(await github.revertMergeRequest('42', 7, input)).toEqual({ reverted: false, reason: 'Could not revert: conflicts' })
      route({ [`GET ${REPO}/pulls/7`]: rawPull })
      expect(await github.revertMergeRequest('42', 7, input)).toMatchObject({ reverted: false })
    })
  })

  it('registers a signed JSON webhook for the events it reads', async () => {
    route({ [`POST ${REPO}/hooks`]: { id: 5 } })
    expect(await github.registerWebhook('42', { url: 'https://fx.example/webhooks/github/1', secret: 's' })).toEqual({ id: '5' })
    expect(last()?.body).toMatchObject({
      name: 'web',
      events: expect.arrayContaining(['pull_request', 'pull_request_review_comment', 'check_suite']),
      config: { url: 'https://fx.example/webhooks/github/1', content_type: 'json', secret: 's' },
    })
  })
})

describe('GitHub webhook codec', () => {
  const repository = { id: 42 }
  const pull = { number: 7, html_url: 'u', head: { ref: 'factorix/abc-1-fix', sha: 'h' } }
  const parse = (event: string, payload: Record<string, unknown>) => githubWebhookCodec.parse({ 'x-github-event': event }, { repository, ...payload })

  it('verifies the HMAC signature of the raw body', () => {
    const body = Buffer.from('{"a":1}')
    const signature = `sha256=${createHmac('sha256', 's').update(body).digest('hex')}`
    expect(githubWebhookCodec.verify(body, { 'x-hub-signature-256': signature }, 's')).toBe(true)
    expect(githubWebhookCodec.verify(body, { 'x-hub-signature-256': signature }, 'other')).toBe(false)
    expect(githubWebhookCodec.verify(Buffer.from('{"a":2}'), { 'x-hub-signature-256': signature }, 's')).toBe(false)
    expect(githubWebhookCodec.verify(body, {}, 's')).toBe(false)
    expect(githubWebhookCodec.verify(body, { 'x-hub-signature-256': signature }, '')).toBe(false)
    expect(githubWebhookCodec.deliveryId({ 'x-github-delivery': 'd1' }, body)).toBe('d1')
  })

  it('maps pull request actions', () => {
    const event = { repoId: '42', iid: 7, url: 'u', sourceBranch: 'factorix/abc-1-fix', sha: 'h' }
    expect(parse('pull_request', { action: 'opened', pull_request: pull })).toEqual({ kind: 'mr.opened', ...event })
    expect(parse('pull_request', { action: 'synchronize', pull_request: pull })).toEqual({ kind: 'mr.updated', ...event })
    expect(parse('pull_request', { action: 'closed', pull_request: { ...pull, merged: true } })).toEqual({ kind: 'mr.merged', ...event })
    expect(parse('pull_request', { action: 'closed', pull_request: pull })).toEqual({ kind: 'mr.closed', ...event })
    expect(parse('pull_request', { action: 'labeled', pull_request: pull }).kind).toBe('ignored')
  })

  it('maps comments to the ids polling gives them', () => {
    const comment = { id: 56, in_reply_to_id: 55, body: 'because', user: { login: 'sam' }, path: 'a.ts', line: 4, created_at: 'now' }
    expect(parse('pull_request_review_comment', { action: 'created', pull_request: pull, comment })).toEqual({
      kind: 'mr.note',
      repoId: '42',
      iid: 7,
      discussionId: 'r55',
      note: { id: 'r56', body: 'because', author: 'sam', system: false, path: 'a.ts', line: 4, createdAt: 'now', resolvable: true, resolved: false },
    })
    const first = parse('pull_request_review_comment', {
      action: 'created',
      pull_request: pull,
      comment: { ...comment, id: 55, in_reply_to_id: undefined },
    })
    expect(first).toMatchObject({ discussionId: 'r55', note: { id: 'r55' } })

    const conversation = { action: 'created', comment: { id: 9, body: 'hello', user: { login: 'sam' }, created_at: 'now' } }
    expect(parse('issue_comment', { ...conversation, issue: { number: 7, pull_request: {} } })).toMatchObject({
      kind: 'mr.note',
      iid: 7,
      discussionId: 'c9',
      note: { id: 'c9', resolvable: false },
    })
    expect(parse('issue_comment', { ...conversation, issue: { number: 7 } }).kind).toBe('ignored')
  })

  it('reads the text of a review as a comment, and an approval without text as an approval', () => {
    const review = { id: 3, body: 'needs work', state: 'changes_requested', user: { login: 'sam' }, submitted_at: 'now' }
    expect(parse('pull_request_review', { action: 'submitted', pull_request: pull, review })).toMatchObject({
      kind: 'mr.note',
      discussionId: 'v3',
      note: { id: 'v3' },
    })
    expect(parse('pull_request_review', { action: 'submitted', pull_request: pull, review: { ...review, body: null, state: 'approved' } }).kind).toBe(
      'mr.approved',
    )
    expect(parse('pull_request_review', { action: 'submitted', pull_request: pull, review: { ...review, body: '', state: 'commented' } }).kind).toBe(
      'ignored',
    )
  })

  it('reports finished checks and commit statuses as pipelines', () => {
    const suite = { id: 5, head_branch: 'factorix/abc-1-fix', head_sha: 'h', conclusion: 'failure', pull_requests: [{ number: 7 }] }
    expect(parse('check_suite', { action: 'completed', check_suite: suite })).toEqual({
      kind: 'pipeline',
      repoId: '42',
      iid: 7,
      ref: 'factorix/abc-1-fix',
      sha: 'h',
      status: 'failed',
      pipelineId: '5',
    })
    expect(parse('check_suite', { action: 'requested', check_suite: suite }).kind).toBe('ignored')
    expect(parse('status', { id: 6, sha: 'h', state: 'success', branches: [{ name: 'factorix/abc-1-fix' }] })).toMatchObject({
      kind: 'pipeline',
      iid: null,
      ref: 'factorix/abc-1-fix',
      status: 'success',
    })
    expect(parse('ping', {}).kind).toBe('ignored')
  })
})
