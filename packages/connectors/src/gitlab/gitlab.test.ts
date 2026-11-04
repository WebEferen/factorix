import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type StubServer, startStubServer } from '../testing/stub-server'
import { GitlabConnector, mapCiStatus } from './client'
import { gitlabWebhookCodec } from './webhook'

const rawMr = {
  id: 100,
  iid: 7,
  web_url: 'https://gitlab.example/g/r/-/merge_requests/7',
  state: 'opened',
  draft: false,
  title: 'ABC-1: Fix',
  description: 'body',
  source_branch: 'factorix/abc-1-fix',
  target_branch: 'main',
  sha: 'abc',
  has_conflicts: false,
  diff_refs: { base_sha: 'b', head_sha: 'h', start_sha: 's' },
}

describe('GitlabConnector against a stub REST server', () => {
  let stub: StubServer
  let gitlab: GitlabConnector

  beforeAll(async () => {
    stub = await startStubServer()
    gitlab = new GitlabConnector({ token: 'glpat-test', host: stub.url })
  })
  afterAll(() => stub.close())

  const route = (routes: Record<string, unknown>) =>
    stub.handle((request) => {
      const key = `${request.method} ${request.path}`
      const body = routes[key]
      return body === undefined ? undefined : { body }
    })
  const last = () => stub.requests.at(-1)

  it('authenticates with PRIVATE-TOKEN and maps repos', async () => {
    route({
      'GET /api/v4/projects': [
        {
          id: 42,
          name: 'r',
          path_with_namespace: 'g/r',
          http_url_to_repo: 'https://gitlab.example/g/r.git',
          web_url: 'https://gitlab.example/g/r',
          default_branch: 'main',
        },
      ],
    })
    expect(await gitlab.listRepos('r')).toEqual([
      { id: '42', path: 'g/r', name: 'r', cloneUrl: 'https://gitlab.example/g/r.git', webUrl: 'https://gitlab.example/g/r', defaultBranch: 'main' },
    ])
    expect(last()?.headers['private-token']).toBe('glpat-test')
    expect(last()?.query.get('membership')).toBe('true')
  })

  it('opens a merge request that removes its source branch', async () => {
    route({ 'POST /api/v4/projects/42/merge_requests': rawMr })
    const mr = await gitlab.openMergeRequest({
      repoId: '42',
      sourceBranch: 'factorix/abc-1-fix',
      targetBranch: 'main',
      title: 'ABC-1: Fix',
      description: 'body',
    })
    expect(mr).toMatchObject({ iid: 7, state: 'opened', diffRefs: { baseSha: 'b', headSha: 'h', startSha: 's' } })
    expect(last()?.body).toMatchObject({
      source_branch: 'factorix/abc-1-fix',
      target_branch: 'main',
      title: 'ABC-1: Fix',
      description: 'body',
      remove_source_branch: true,
    })
  })

  it('finds an existing open merge request so a retry does not open a second one', async () => {
    route({ 'GET /api/v4/projects/42/merge_requests': [{ iid: 7 }], 'GET /api/v4/projects/42/merge_requests/7': rawMr })
    expect((await gitlab.findOpenMergeRequest('42', 'factorix/abc-1-fix'))?.iid).toBe(7)
    expect(stub.requests.at(-2)?.query.get('source_branch')).toBe('factorix/abc-1-fix')
    expect(stub.requests.at(-2)?.query.get('state')).toBe('opened')
    route({ 'GET /api/v4/projects/42/merge_requests': [] })
    expect(await gitlab.findOpenMergeRequest('42', 'x')).toBeNull()
  })

  it('posts a diff discussion with GitLab position fields', async () => {
    route({ 'POST /api/v4/projects/42/merge_requests/7/discussions': { id: 'd1' } })
    const refs = { baseSha: 'b', headSha: 'h', startSha: 's' }
    expect(await gitlab.postDiffDiscussion('42', 7, { path: 'a.ts', line: 3, side: 'new', body: 'bug', diffRefs: refs })).toEqual({
      discussionId: 'd1',
    })
    const fields = () => {
      const pairs = [...(last()?.rawBody ?? '').matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)].map((match) => [match[1], match[2]])
      return Object.fromEntries(pairs)
    }
    expect(fields()).toEqual({
      body: 'bug',
      'position[position_type]': 'text',
      'position[base_sha]': 'b',
      'position[head_sha]': 'h',
      'position[start_sha]': 's',
      'position[new_path]': 'a.ts',
      'position[old_path]': 'a.ts',
      'position[new_line]': '3',
    })
    await gitlab.postDiffDiscussion('42', 7, { path: 'a.ts', line: 9, side: 'old', body: 'bug', diffRefs: refs })
    expect(fields()['position[old_line]']).toBe('9')
    expect(fields()['position[new_line]']).toBeUndefined()
  })

  it('replies to and resolves discussions', async () => {
    route({
      'POST /api/v4/projects/42/merge_requests/7/discussions/d1/notes': { id: 1 },
      'PUT /api/v4/projects/42/merge_requests/7/discussions/d1': { id: 'd1' },
    })
    await gitlab.replyDiscussion('42', 7, 'd1', 'done')
    expect(last()?.body).toEqual({ body: 'done' })
    await gitlab.resolveDiscussion('42', 7, 'd1', true)
    expect(last()?.body?.resolved ?? last()?.query.get('resolved')).toBeTruthy()
  })

  it('maps discussion notes including their diff position', async () => {
    route({
      'GET /api/v4/projects/42/merge_requests/7/discussions': [
        {
          id: 'd1',
          notes: [
            {
              id: 5,
              body: 'why',
              author: { username: 'sam' },
              system: false,
              created_at: 'now',
              resolvable: true,
              resolved: false,
              position: { new_path: 'a.ts', new_line: 4 },
            },
          ],
        },
      ],
    })
    expect(await gitlab.listDiscussions('42', 7)).toEqual([
      {
        id: 'd1',
        notes: [{ id: '5', body: 'why', author: 'sam', system: false, path: 'a.ts', line: 4, createdAt: 'now', resolvable: true, resolved: false }],
      },
    ])
  })

  it('treats a refused self-approval as a soft failure', async () => {
    stub.handle((request) => (request.path.endsWith('/approve') ? { status: 401, body: { message: '401 Unauthorized' } } : undefined))
    expect(await gitlab.approve('42', 7)).toBe(false)
    route({ 'POST /api/v4/projects/42/merge_requests/7/approve': { id: 1 } })
    expect(await gitlab.approve('42', 7)).toBe(true)
  })

  it('reports CI as none, then pending, then failed with job log tails', async () => {
    route({ 'GET /api/v4/projects/42/merge_requests/7/pipelines': [] })
    expect(await gitlab.getCiStatus('42', 7)).toEqual({ status: 'none', failedJobs: [] })

    route({ 'GET /api/v4/projects/42/merge_requests/7/pipelines': [{ id: 9, status: 'created', web_url: 'u' }] })
    expect((await gitlab.getCiStatus('42', 7)).status).toBe('pending')

    route({
      'GET /api/v4/projects/42/merge_requests/7/pipelines': [{ id: 9, status: 'failed', web_url: 'u' }],
      'GET /api/v4/projects/42/pipelines/9/jobs': [{ id: 3, name: 'test', stage: 'test', web_url: 'j' }],
      'GET /api/v4/projects/42/jobs/3/trace': 'boom',
    })
    const failed = await gitlab.getCiStatus('42', 7)
    expect(failed.status).toBe('failed')
    expect(failed.failedJobs[0]).toMatchObject({ name: 'test', stage: 'test', webUrl: 'j' })
  })

  it('merges with the expected sha and reports refusals instead of throwing', async () => {
    route({ 'PUT /api/v4/projects/42/merge_requests/7/merge': { ...rawMr, state: 'merged' } })
    expect(await gitlab.merge('42', 7, { sha: 'abc', squash: true })).toEqual({ merged: true, reason: undefined })
    expect(last()?.body).toMatchObject({ sha: 'abc', squash: true, should_remove_source_branch: true })

    stub.handle((request) => (request.path.endsWith('/merge') ? { status: 405, body: { message: 'Method Not Allowed' } } : undefined))
    expect((await gitlab.merge('42', 7, {})).merged).toBe(false)
  })

  it('registers a project webhook with the shared secret', async () => {
    route({ 'POST /api/v4/projects/42/hooks': { id: 11 } })
    expect(await gitlab.registerWebhook('42', { url: 'https://x/webhooks/gitlab/c', secret: 's' })).toEqual({ id: '11' })
    expect(last()?.body).toMatchObject({
      url: 'https://x/webhooks/gitlab/c',
      token: 's',
      merge_requests_events: true,
      note_events: true,
      pipeline_events: true,
    })
  })
})

describe('gitlabWebhookCodec', () => {
  it('verifies the shared token in constant time and rejects anything else', () => {
    const raw = Buffer.from('{}')
    expect(gitlabWebhookCodec.verify(raw, { 'x-gitlab-token': 'secret' }, 'secret')).toBe(true)
    expect(gitlabWebhookCodec.verify(raw, { 'x-gitlab-token': 'wrong' }, 'secret')).toBe(false)
    expect(gitlabWebhookCodec.verify(raw, {}, 'secret')).toBe(false)
    expect(gitlabWebhookCodec.verify(raw, { 'x-gitlab-token': '' }, '')).toBe(false)
  })

  it('dedupes on the event UUID', () => {
    expect(gitlabWebhookCodec.deliveryId({ 'x-gitlab-event-uuid': 'u1' }, Buffer.from('x'))).toBe('u1')
  })

  it('parses merge request actions', () => {
    const payload = (action: string) => ({
      object_kind: 'merge_request',
      project: { id: 42 },
      object_attributes: { action, iid: 7, url: 'u', source_branch: 'b', last_commit: { id: 'sha' } },
    })
    const headers = { 'x-gitlab-event': 'Merge Request Hook' }
    expect(gitlabWebhookCodec.parse(headers, payload('merge'))).toEqual({
      kind: 'mr.merged',
      repoId: '42',
      iid: 7,
      url: 'u',
      sourceBranch: 'b',
      sha: 'sha',
    })
    expect(gitlabWebhookCodec.parse(headers, payload('close')).kind).toBe('mr.closed')
    expect(gitlabWebhookCodec.parse(headers, payload('approved')).kind).toBe('mr.approved')
    expect(gitlabWebhookCodec.parse(headers, payload('unapproved')).kind).toBe('ignored')
  })

  it('parses MR notes with their position and ignores notes elsewhere', () => {
    const event = gitlabWebhookCodec.parse(
      { 'x-gitlab-event': 'Note Hook' },
      {
        object_kind: 'note',
        project_id: 42,
        user: { username: 'sam' },
        merge_request: { iid: 7 },
        object_attributes: {
          id: 5,
          note: 'fix this',
          noteable_type: 'MergeRequest',
          discussion_id: 'd1',
          system: false,
          created_at: 'now',
          position: { new_path: 'a.ts', new_line: 2 },
        },
      },
    )
    expect(event).toMatchObject({
      kind: 'mr.note',
      repoId: '42',
      iid: 7,
      discussionId: 'd1',
      note: { id: '5', body: 'fix this', author: 'sam', path: 'a.ts', line: 2, system: false },
    })
    expect(
      gitlabWebhookCodec.parse({ 'x-gitlab-event': 'Note Hook' }, { object_kind: 'note', object_attributes: { noteable_type: 'Issue' } }).kind,
    ).toBe('ignored')
  })

  it('parses pipeline events', () => {
    expect(
      gitlabWebhookCodec.parse(
        { 'x-gitlab-event': 'Pipeline Hook' },
        {
          object_kind: 'pipeline',
          project: { id: 42 },
          merge_request: { iid: 7 },
          object_attributes: { id: 9, ref: 'b', sha: 's', status: 'failed' },
        },
      ),
    ).toEqual({ kind: 'pipeline', repoId: '42', iid: 7, ref: 'b', sha: 's', status: 'failed', pipelineId: '9' })
  })

  it('maps every GitLab pipeline status', () => {
    expect(mapCiStatus('waiting_for_resource')).toBe('pending')
    expect(mapCiStatus('canceling')).toBe('canceled')
    expect(mapCiStatus(undefined)).toBe('none')
  })
})
