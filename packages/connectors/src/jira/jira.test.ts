import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type StubServer, startStubServer } from '../testing/stub-server'
import { JiraConnector, jiraStateType } from './client'
import { jiraMarkup, jiraToMarkdown, markdownToJira } from './markup'
import { jiraWebhookCodec } from './webhook'

const rawIssue = (self: string) => ({
  id: '10001',
  key: 'SHOP-1',
  self: `${self}/rest/api/2/issue/10001`,
  fields: {
    summary: 'Add a cart',
    description: 'h2. Why\n*now*',
    status: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    priority: { name: 'High' },
    assignee: { accountId: 'a1', displayName: 'Sam' },
    creator: { accountId: 'a2', displayName: 'Kim' },
    labels: ['agent:engineer-1', 'frontend'],
    created: '2026-01-02T10:00:00.000+0100',
    updated: '2026-01-03T10:00:00.000+0100',
    project: { id: '10000' },
  },
})

describe('Jira markup', () => {
  it('reads wiki markup as Markdown', () => {
    const wiki = [
      'h2. Plan',
      '*bold* and _italic_ and {{code}} and -gone-',
      '* one',
      '** nested',
      '# first',
      '[docs|https://x.example/a] and [~accountid:abc]',
      '{code:ts}',
      'const a = *1*',
      '{code}',
      '{quote}',
      'said',
      '{quote}',
      'bq. short',
      '||A||B||',
      '|1|2|',
      'a - b - c and x_y_z',
    ].join('\n')
    expect(jiraToMarkdown(wiki)).toBe(
      [
        '## Plan',
        '**bold** and *italic* and `code` and ~~gone~~',
        '- one',
        '  - nested',
        '1. first',
        '[docs](https://x.example/a) and @abc',
        '```ts',
        'const a = *1*',
        '```',
        '> said',
        '> short',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        'a - b - c and x_y_z',
      ].join('\n'),
    )
  })

  it('writes Markdown as wiki markup', () => {
    const markdown = [
      '## Plan',
      '**bold**, *italic*, `a*b`',
      '- one',
      '  - nested',
      '1. first',
      '[docs](https://x.example/a)',
      '```ts',
      'const **a**',
      '```',
      '> said',
    ].join('\n')
    expect(markdownToJira(markdown)).toBe(
      [
        'h2. Plan',
        '*bold*, _italic_, {{a*b}}',
        '* one',
        '** nested',
        '# first',
        '[docs|https://x.example/a]',
        '{code:ts}',
        'const **a**',
        '{code}',
        'bq. said',
      ].join('\n'),
    )
  })

  it('keeps the way the factory signs its comments readable both ways', () => {
    const wiki = markdownToJira('**[Factorix · engineer-1]** Opened [!7](https://x.example/7)')
    expect(wiki).toBe('*\\[Factorix · engineer-1\\]* Opened [!7|https://x.example/7]')
    expect(jiraToMarkdown(wiki)).toBe('**[Factorix · engineer-1]** Opened [!7](https://x.example/7)')
  })

  it('knows an attachment by its path', () => {
    expect(jiraMarkup.isMediaUrl('https://acme.atlassian.net/rest/api/2/attachment/content/10010')).toBe(true)
    expect(jiraMarkup.isMediaUrl('https://acme.atlassian.net/browse/SHOP-1')).toBe(false)
  })
})

describe('JiraConnector against a stub server', () => {
  let stub: StubServer
  let jira: JiraConnector

  beforeAll(async () => {
    stub = await startStubServer()
    jira = new JiraConnector({ token: 'tok', host: stub.url, email: 'me@acme.com' })
  })
  afterAll(() => stub.close())

  const route = (routes: Record<string, unknown>) =>
    stub.handle((request) => {
      const body = routes[`${request.method} ${request.path}`]
      return body === undefined ? undefined : { body }
    })
  const last = () => stub.requests.at(-1)
  const sent = (method: string, path: string) => stub.requests.findLast((request) => request.method === method && request.path === path)

  it('signs in with the email and token on Cloud, and with a bearer token on Data Center', async () => {
    route({ 'GET /rest/api/2/myself': { accountId: 'a1', displayName: 'Sam', emailAddress: 'me@acme.com' } })
    expect(await jira.viewer()).toEqual({ id: 'a1', name: 'Sam', email: 'me@acme.com' })
    expect(last()?.headers.authorization).toBe(`Basic ${Buffer.from('me@acme.com:tok').toString('base64')}`)
    await new JiraConnector({ token: 'pat', host: stub.url }).viewer()
    expect(last()?.headers.authorization).toBe('Bearer pat')
  })

  it('lists projects as teams and their statuses by category', async () => {
    route({
      'GET /rest/api/2/project/search': { values: [{ id: '10000', key: 'SHOP', name: 'Shop' }], isLast: true },
      'GET /rest/api/2/project/10000/statuses': [
        {
          statuses: [
            { id: '5', name: 'Done', statusCategory: { key: 'done' } },
            { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
            { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
          ],
        },
        {
          statuses: [
            { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
            { id: '6', name: "Won't Do", statusCategory: { key: 'done' } },
          ],
        },
      ],
    })
    expect(await jira.listTeams()).toEqual([{ id: '10000', key: 'SHOP', name: 'Shop' }])
    expect((await jira.listWorkflowStates('10000')).map((state) => [state.id, state.type])).toEqual([
      ['1', 'unstarted'],
      ['3', 'started'],
      ['5', 'completed'],
      ['6', 'canceled'],
    ])
    expect(jiraStateType({ name: 'Backlog', statusCategory: { key: 'new' } })).toBe('backlog')
  })

  it('maps issues and pages through a search', async () => {
    route({ 'POST /rest/api/2/search/jql': { issues: [rawIssue(stub.url)], nextPageToken: 'next' } })
    const page = await jira.listIssues({
      teamId: '10000',
      updatedAfter: '2026-01-01T00:00:00.000Z',
      closedSince: '2026-01-01T00:00:00.000Z',
      cursor: 'p1',
    })
    expect(page.nextCursor).toBe('next')
    expect(page.nodes[0]).toMatchObject({
      id: '10001',
      identifier: 'SHOP-1',
      title: 'Add a cart',
      description: 'h2. Why\n*now*',
      url: `${stub.url}/browse/SHOP-1`,
      priority: 2,
      teamId: '10000',
      stateId: '3',
      stateType: 'started',
      assigneeName: 'Sam',
      creatorName: 'Kim',
      labels: [
        { id: 'agent:engineer-1', name: 'engineer-1', parentId: 'Agent' },
        { id: 'frontend', name: 'frontend', parentId: null },
      ],
      createdAt: '2026-01-02T09:00:00.000Z',
      updatedAt: '2026-01-03T09:00:00.000Z',
    })
    const after = new Date('2026-01-01T00:00:00.000Z').getTime() - 60_000
    expect(last()?.body).toMatchObject({
      jql: `project = 10000 AND updated > ${after} AND (statusCategory != Done OR updated > ${after}) ORDER BY updated ASC, id ASC`,
      nextPageToken: 'p1',
      maxResults: 50,
    })
  })

  it('creates an issue as wiki markup, and without a priority when the project refuses it', async () => {
    let attempts = 0
    stub.handle((request) => {
      if (request.method === 'GET') return { body: rawIssue(stub.url) }
      attempts += 1
      return attempts === 1
        ? { status: 400, body: { errors: { priority: 'Field priority cannot be set' } } }
        : { body: { id: '10001', key: 'SHOP-1' } }
    })
    const issue = await jira.createIssue({
      teamId: '10000',
      title: 'Add a cart',
      description: '**now**',
      priority: 2,
      labelIds: ['agent:engineer-1'],
    })
    expect(issue.identifier).toBe('SHOP-1')
    const posts = stub.requests.filter((request) => request.method === 'POST' && request.path === '/rest/api/2/issue').slice(-2)
    expect(posts[0]?.body.fields).toMatchObject({ project: { id: '10000' }, summary: 'Add a cart', description: '*now*', priority: { name: 'High' } })
    expect(posts[1]?.body.fields.priority).toBeUndefined()
    expect(posts[1]?.body.fields.labels).toEqual(['agent:engineer-1'])
  })

  it('moves an issue by the transition that leads to the status', async () => {
    route({
      'GET /rest/api/2/issue/10001/transitions': {
        transitions: [
          { id: '21', to: { id: '3' } },
          { id: '31', to: { id: '5' } },
        ],
      },
      'POST /rest/api/2/issue/10001/transitions': {},
    })
    await jira.updateIssueState('10001', '5')
    expect(last()?.body).toEqual({ transition: { id: '31' } })
    await expect(jira.updateIssueState('10001', '9')).rejects.toThrow('no transition')
  })

  it('writes agent labels as plain Jira labels', async () => {
    route({ 'PUT /rest/api/2/issue/10001': {}, 'GET /rest/api/2/label': { values: ['agent:engineer-1', 'frontend'] } })
    expect(await jira.createLabel({ teamId: '10000', name: 'Agent', isGroup: true })).toMatchObject({ id: 'Agent', isGroup: true })
    expect(await jira.createLabel({ teamId: '10000', name: 'engineer-1', parentId: 'Agent' })).toEqual({
      id: 'agent:engineer-1',
      name: 'engineer-1',
      parentId: 'Agent',
    })
    expect(await jira.createLabel({ teamId: '10000', name: 'needs design' })).toMatchObject({ id: 'needs-design' })
    expect((await jira.listLabels()).map((label) => label.id)).toEqual(['Agent', 'agent:engineer-1', 'frontend'])
    await jira.updateIssueLabels('10001', { add: ['agent:engineer-1'], remove: ['agent:reviewer-1'] })
    expect(last()?.body).toEqual({ update: { labels: [{ remove: 'agent:reviewer-1' }, { add: 'agent:engineer-1' }] } })
  })

  it('comments in wiki markup and edits a comment through its issue', async () => {
    route({
      'POST /rest/api/2/issue/10001/comment': { id: '7' },
      'PUT /rest/api/2/issue/10001/comment/7': {},
      'GET /rest/api/2/issue/10001/comment': {
        comments: [{ id: '7', body: '*\\[Factorix · engineer-1\\]* done', author: { displayName: 'Bot' }, created: '2026-01-03T10:00:00.000+0000' }],
      },
    })
    expect(await jira.comment('10001', '**done**')).toEqual({ id: '10001:7' })
    expect(last()?.body).toEqual({ body: '*done*' })
    await jira.updateComment('10001:7', 'again')
    expect(last()?.path).toBe('/rest/api/2/issue/10001/comment/7')
    expect((await jira.listComments('10001'))[0]).toMatchObject({
      id: '10001:7',
      issueId: '10001',
      body: '**[Factorix · engineer-1]** done',
      authorName: 'Bot',
    })
  })

  it('lists attachments and links, and sends its token only to its own site', async () => {
    route({
      'GET /rest/api/2/issue/10001': {
        fields: { attachment: [{ filename: 'a.png', content: `${stub.url}/rest/api/2/attachment/content/9`, mimeType: 'image/png', size: 3 }] },
      },
      'GET /rest/api/2/issue/10001/remotelink': [{ object: { url: 'https://docs.example/spec', title: 'Spec' } }],
      'GET /rest/api/2/attachment/content/9': 'png',
    })
    expect((await jira.listResources('10001')).map((resource) => [resource.kind, resource.title])).toEqual([
      ['file', 'a.png'],
      ['link', 'Spec'],
    ])
    expect((await jira.fetchMedia(`${stub.url}/rest/api/2/attachment/content/9`))?.status).toBe(200)
    const before = stub.requests.length
    expect(await jira.fetchMedia('https://evil.example/rest/api/2/attachment/content/9')).toBeNull()
    expect(stub.requests.length).toBe(before)
  })

  it('registers a signed webhook for one project', async () => {
    route({ 'POST /rest/webhooks/1.0/webhook': { self: `${stub.url}/rest/webhooks/1.0/webhook/12` } })
    expect(await jira.registerWebhook({ teamId: '10000', url: 'https://fx.example/webhooks/jira/1', secret: 's' })).toEqual({ id: '12' })
    expect(sent('POST', '/rest/webhooks/1.0/webhook')?.body).toMatchObject({
      url: 'https://fx.example/webhooks/jira/1',
      secret: 's',
      filters: { 'issue-related-events-section': 'project = 10000' },
    })
  })
})

describe('Jira webhook codec', () => {
  it('verifies the signature of the raw body', () => {
    const body = Buffer.from('{"a":1}')
    const signature = `sha256=${createHmac('sha256', 's').update(body).digest('hex')}`
    expect(jiraWebhookCodec.verify(body, { 'x-hub-signature': signature }, 's')).toBe(true)
    expect(jiraWebhookCodec.verify(body, { 'x-hub-signature': signature }, 'other')).toBe(false)
    expect(jiraWebhookCodec.verify(body, {}, 's')).toBe(false)
  })

  it('maps issue and comment events', () => {
    const issue = rawIssue('https://acme.atlassian.net')
    const updated = jiraWebhookCodec.parse({
      webhookEvent: 'jira:issue_updated',
      issue,
      changelog: { items: [{ field: 'status', from: '1', to: '3' }] },
    })
    expect(updated).toMatchObject({
      kind: 'issue.upserted',
      previousStateId: '1',
      issue: { identifier: 'SHOP-1', url: 'https://acme.atlassian.net/browse/SHOP-1' },
    })
    expect(jiraWebhookCodec.parse({ webhookEvent: 'jira:issue_deleted', issue: { id: '10001' } })).toEqual({
      kind: 'issue.removed',
      issueId: '10001',
    })
    const comment = { id: '7', body: 'please also do X', author: { displayName: 'Sam' }, created: '2026-01-03T10:00:00.000+0000' }
    expect(jiraWebhookCodec.parse({ webhookEvent: 'comment_created', comment, issue: { id: '10001' } })).toMatchObject({
      kind: 'comment.upserted',
      action: 'create',
      comment: { id: '10001:7', issueId: '10001', body: 'please also do X' },
    })
    expect(jiraWebhookCodec.parse({ webhookEvent: 'sprint_started' }).kind).toBe('ignored')
  })
})
