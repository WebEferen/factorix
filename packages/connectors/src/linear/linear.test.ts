import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type StubServer, startStubServer } from '../testing/stub-server'
import { LinearConnector } from './client'
import { linearWebhookCodec } from './webhook'

const rawIssue = {
  id: 'i1',
  identifier: 'ABC-1',
  title: 'Fix it',
  description: 'desc',
  url: 'https://linear.app/x/issue/ABC-1',
  priority: 2,
  createdAt: '2025-12-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null,
  team: { id: 't1' },
  project: { id: 'p1' },
  state: { id: 's1', name: 'Todo', type: 'unstarted' },
  assignee: { id: 'u1', displayName: 'Sam' },
  labels: { nodes: [{ id: 'l1', name: 'engineer-1', parent: { id: 'g1' } }] },
}

describe('LinearConnector against a stub GraphQL server', () => {
  let stub: StubServer
  let linear: LinearConnector

  beforeAll(async () => {
    stub = await startStubServer()
    linear = new LinearConnector({ apiKey: 'lin_api_test', apiUrl: `${await Promise.resolve(stub.url)}/graphql` })
  })
  afterAll(() => stub.close())

  const respond = (data: unknown) => stub.handle(() => ({ body: { data } }))
  const last = () => stub.requests.at(-1)

  it('authenticates with the raw API key', async () => {
    respond({ viewer: { id: 'u', name: 'Me', email: 'me@example.com' } })
    expect(await linear.viewer()).toEqual({ id: 'u', name: 'Me', email: 'me@example.com' })
    expect(last()?.headers.authorization).toBe('lin_api_test')
  })

  it('normalizes a page of issues and passes the filter through', async () => {
    respond({ issues: { nodes: [rawIssue], pageInfo: { hasNextPage: true, endCursor: 'c2' } } })
    const page = await linear.listIssues({ teamId: 't1', projectId: 'p1', updatedAfter: '2026-01-01T00:00:00Z', limit: 10 })
    expect(page.nextCursor).toBe('c2')
    expect(page.nodes[0]).toMatchObject({
      createdAt: '2025-12-01T00:00:00.000Z',
      identifier: 'ABC-1',
      teamId: 't1',
      projectId: 'p1',
      stateType: 'unstarted',
      assigneeName: 'Sam',
      labels: [{ id: 'l1', name: 'engineer-1', parentId: 'g1' }],
    })
    expect(last()?.body.variables.filter).toEqual({
      team: { id: { eq: 't1' } },
      project: { id: { eq: 'p1' } },
      updatedAt: { gt: '2026-01-01T00:00:00Z' },
    })
  })

  it('leaves out issues that closed before the window, but never open ones', async () => {
    respond({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } })
    await linear.listIssues({ teamId: 't1', closedSince: '2026-01-01T00:00:00Z' })
    expect(last()?.body.variables.filter).toEqual({
      team: { id: { eq: 't1' } },
      or: [{ state: { type: { nin: ['completed', 'canceled'] } } }, { updatedAt: { gt: '2026-01-01T00:00:00Z' } }],
    })
  })

  it('returns no next cursor on the last page', async () => {
    respond({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: 'x' } } })
    expect((await linear.listIssues({ teamId: 't1' })).nextCursor).toBeNull()
  })

  it('sorts workflow states by position', async () => {
    respond({
      team: {
        states: {
          nodes: [
            { id: 'b', name: 'B', type: 'started', position: 2 },
            { id: 'a', name: 'A', type: 'unstarted', position: 1 },
          ],
        },
      },
    })
    expect((await linear.listWorkflowStates('t1')).map((state) => state.id)).toEqual(['a', 'b'])
  })

  it('writes issues, comments, labels, and webhooks through mutations', async () => {
    respond({ issueCreate: { success: true, issue: rawIssue } })
    expect((await linear.createIssue({ teamId: 't1', title: 'Fix it', labelIds: ['l1'] })).identifier).toBe('ABC-1')
    expect(last()?.body.variables.input).toMatchObject({ teamId: 't1', title: 'Fix it', labelIds: ['l1'] })

    respond({ issueUpdate: { success: true } })
    await linear.updateIssueState('i1', 's2')
    expect(last()?.body.variables).toEqual({ id: 'i1', input: { stateId: 's2' } })
    await linear.updateIssueLabels('i1', { add: ['l1'], remove: ['l2'] })
    expect(last()?.body.variables.input).toEqual({ addedLabelIds: ['l1'], removedLabelIds: ['l2'] })

    respond({ commentCreate: { comment: { id: 'c1' } } })
    expect(await linear.comment('i1', 'hello')).toEqual({ id: 'c1' })

    respond({ issueLabelCreate: { issueLabel: { id: 'g1', name: 'Agent', isGroup: true, parent: null } } })
    expect(await linear.createLabel({ teamId: 't1', name: 'Agent', isGroup: true })).toEqual({
      id: 'g1',
      name: 'Agent',
      isGroup: true,
      parentId: null,
    })

    respond({ webhookCreate: { webhook: { id: 'w1' } } })
    expect(await linear.registerWebhook({ teamId: 't1', url: 'https://x/webhooks/linear/c', secret: 's' })).toEqual({ id: 'w1' })
    expect(last()?.body.variables.input.resourceTypes).toEqual(['Issue', 'Comment'])
  })

  it('reads the documents and links attached to an issue', async () => {
    respond({
      issue: {
        documents: { nodes: [{ title: 'ABC-1 Spec', url: 'https://linear.app/x/document/spec-1', content: '# Spec\nDo it.' }] },
        attachments: { nodes: [{ title: 'Design', subtitle: 'Figma', url: 'https://figma.com/file/1' }] },
      },
    })
    expect(await linear.listResources('i1')).toEqual([
      { kind: 'document', title: 'ABC-1 Spec', url: 'https://linear.app/x/document/spec-1', subtitle: null, content: '# Spec\nDo it.' },
      { kind: 'link', title: 'Design', url: 'https://figma.com/file/1', subtitle: 'Figma', content: null },
    ])
    expect(last()?.body.variables).toEqual({ id: 'i1' })
    expect(last()?.body.query).toContain('documents(first: 25)')
  })

  it('surfaces GraphQL errors', async () => {
    stub.handle(() => ({ body: { errors: [{ message: 'Authentication required', extensions: { type: 'authentication error' } }] } }))
    await expect(linear.viewer()).rejects.toThrow()
  })
})

describe('linearWebhookCodec', () => {
  const secret = 'whsec'
  const sign = (body: Buffer) => createHmac('sha256', secret).update(body).digest('hex')
  const body = (overrides: Record<string, unknown> = {}) =>
    Buffer.from(JSON.stringify({ type: 'Issue', action: 'update', webhookTimestamp: Date.now(), data: {}, ...overrides }))

  it('accepts a correct signature', () => {
    const raw = body()
    expect(linearWebhookCodec.verify(raw, { 'linear-signature': sign(raw) }, secret)).toBe(true)
  })

  it('rejects a wrong signature, a missing signature, and an empty secret', () => {
    const raw = body()
    expect(linearWebhookCodec.verify(raw, { 'linear-signature': 'deadbeef' }, secret)).toBe(false)
    expect(linearWebhookCodec.verify(raw, {}, secret)).toBe(false)
    expect(linearWebhookCodec.verify(raw, { 'linear-signature': sign(raw) }, '')).toBe(false)
  })

  it('rejects a replayed delivery with a stale timestamp even when signed', () => {
    const raw = body({ webhookTimestamp: Date.now() - 120_000 })
    expect(linearWebhookCodec.verify(raw, { 'linear-signature': sign(raw) }, secret)).toBe(false)
  })

  it('dedupes on the delivery header and falls back to a body hash', () => {
    const raw = body()
    expect(linearWebhookCodec.deliveryId({ 'linear-delivery': 'd1' }, raw)).toBe('d1')
    expect(linearWebhookCodec.deliveryId({}, raw)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('parses an issue update with what changed', () => {
    const event = linearWebhookCodec.parse({
      type: 'Issue',
      action: 'update',
      updatedFrom: { stateId: 's0', labelIds: [] },
      data: {
        id: 'i1',
        identifier: 'ABC-1',
        title: 'T',
        teamId: 't1',
        stateId: 's1',
        state: { id: 's1', name: 'Todo', type: 'unstarted' },
        labels: [{ id: 'l1', name: 'engineer-1', parentId: 'g1' }],
        createdAt: '2025-12-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    })
    expect(event).toMatchObject({
      kind: 'issue.upserted',
      previousStateId: 's0',
      previousLabelIds: [],
      issue: { identifier: 'ABC-1', stateName: 'Todo', labels: [{ id: 'l1', parentId: 'g1' }], createdAt: '2025-12-01T00:00:00Z' },
    })
  })

  it('parses removals and comments, and ignores everything else', () => {
    expect(linearWebhookCodec.parse({ type: 'Issue', action: 'remove', data: { id: 'i1' } })).toEqual({ kind: 'issue.removed', issueId: 'i1' })
    expect(
      linearWebhookCodec.parse({
        type: 'Comment',
        action: 'create',
        data: { id: 'c1', body: 'hi', issueId: 'i1', userId: 'u1', user: { id: 'u1', name: 'Sam' }, createdAt: 'now' },
      }),
    ).toEqual({
      kind: 'comment.upserted',
      action: 'create',
      comment: { id: 'c1', issueId: 'i1', body: 'hi', authorId: 'u1', authorName: 'Sam', createdAt: 'now' },
    })
    expect(
      linearWebhookCodec.parse({ type: 'Comment', action: 'create', data: { id: 'c2', body: 'x', projectUpdateId: 'pu', createdAt: 'now' } }).kind,
    ).toBe('ignored')
    expect(linearWebhookCodec.parse({ type: 'Reaction', action: 'create', data: {} }).kind).toBe('ignored')
  })
})
