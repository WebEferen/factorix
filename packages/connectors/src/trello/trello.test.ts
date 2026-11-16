import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type StubServer, startStubServer } from '../testing/stub-server'
import { TrelloConnector, trelloBoardKey, trelloStateType } from './client'
import { trelloMarkup } from './markup'
import { trelloWebhookCodec } from './webhook'

const card = {
  id: '65a000000000000000000001',
  idShort: 12,
  name: 'Add a cart',
  desc: 'Why **now**',
  shortUrl: 'https://trello.com/c/abc',
  idBoard: 'b1',
  idList: 'l2',
  closed: false,
  dateLastActivity: '2026-01-03T10:00:00.000Z',
  labels: [
    { id: 'lb1', name: 'agent:engineer-1' },
    { id: 'lb2', name: '', color: 'red' },
  ],
  members: [{ id: 'm1', fullName: 'Sam' }],
}
const lists = [
  { id: 'l3', name: 'Done', pos: 3, closed: false },
  { id: 'l1', name: 'To do', pos: 1, closed: false },
  { id: 'l2', name: 'In progress', pos: 2, closed: false },
  { id: 'l9', name: 'Old', pos: 9, closed: true },
]

describe('Trello naming', () => {
  it('makes a prefix from the board name and a status type from the list name', () => {
    expect(trelloBoardKey('Web app')).toBe('WA')
    expect(trelloBoardKey('shop')).toBe('SHOP')
    expect(trelloBoardKey('2024 roadmap')).toBe('R')
    expect(trelloBoardKey('!!!')).toBe('CARD')
    expect(['Backlog', 'To do', 'In review', 'Done', "Won't do"].map(trelloStateType)).toEqual([
      'backlog',
      'unstarted',
      'started',
      'completed',
      'canceled',
    ])
  })

  it('knows an upload by its download address', () => {
    expect(trelloMarkup.isMediaUrl('https://api.trello.com/1/cards/c1/attachments/a1/download/a.png')).toBe(true)
    expect(trelloMarkup.isMediaUrl('https://evil.example/1/cards/c1/attachments/a1/download/a.png')).toBe(false)
  })
})

describe('TrelloConnector against a stub server', () => {
  let stub: StubServer
  let trello: TrelloConnector

  beforeAll(async () => {
    stub = await startStubServer()
    trello = new TrelloConnector({ apiKey: 'key', token: 'tok', apiUrl: stub.url })
  })
  afterAll(() => stub.close())

  const route = (routes: Record<string, unknown>) =>
    stub.handle((request) => {
      const body = routes[`${request.method} ${request.path}`]
      return body === undefined ? undefined : { body }
    })
  const last = () => stub.requests.at(-1)
  const sent = (method: string, path: string) => stub.requests.findLast((request) => request.method === method && request.path === path)

  it('sends the key and token in a header, never in the address', async () => {
    route({ 'GET /1/members/me': { id: 'm1', fullName: 'Sam' } })
    expect(await trello.viewer()).toEqual({ id: 'm1', name: 'Sam', email: null })
    expect(last()?.headers.authorization).toBe('OAuth oauth_consumer_key="key", oauth_token="tok"')
    expect(last()?.query.get('token')).toBeNull()
  })

  it('lists boards as teams and open lists as statuses in board order', async () => {
    route({ 'GET /1/members/me/boards': [{ id: 'b1', name: 'Web app' }], 'GET /1/boards/b1/lists': lists })
    expect(await trello.listTeams()).toEqual([{ id: 'b1', key: 'WA', name: 'Web app' }])
    expect((await trello.listWorkflowStates('b1')).map((state) => [state.id, state.type, state.position])).toEqual([
      ['l1', 'unstarted', 0],
      ['l2', 'started', 1],
      ['l3', 'completed', 2],
    ])
  })

  it('maps cards, filters by change date itself, and treats an archived unfinished card as dropped', async () => {
    const archived = { ...card, id: '65a000000000000000000002', idShort: 13, closed: true, dateLastActivity: '2025-01-01T00:00:00.000Z' }
    route({ 'GET /1/boards/b1/cards/all': [card, archived], 'GET /1/boards/b1/lists': lists, 'GET /1/boards/b1': { name: 'Web app' } })
    const page = await trello.listIssues({ teamId: 'b1' })
    expect(page.nextCursor).toBeNull()
    expect(page.nodes[0]).toMatchObject({
      id: card.id,
      identifier: 'WA-12',
      title: 'Add a cart',
      description: 'Why **now**',
      url: 'https://trello.com/c/abc',
      teamId: 'b1',
      stateId: 'l2',
      stateName: 'In progress',
      stateType: 'started',
      assigneeName: 'Sam',
      labels: [
        { id: 'lb1', name: 'engineer-1', parentId: 'Agent' },
        { id: 'lb2', name: 'red', parentId: null },
      ],
      createdAt: new Date(0x65a00000 * 1000).toISOString(),
    })
    expect(page.nodes[1]).toMatchObject({ identifier: 'WA-13', stateType: 'canceled' })
    expect((await trello.listIssues({ teamId: 'b1', updatedAfter: '2025-06-01T00:00:00.000Z' })).nodes).toHaveLength(1)
    expect((await trello.listIssues({ teamId: 'b1', closedSince: '2025-06-01T00:00:00.000Z' })).nodes).toHaveLength(1)
  })

  it('creates a card in the first list that has not started, and moves it by list', async () => {
    route({
      'GET /1/boards/b1/lists': lists,
      'POST /1/cards': { id: card.id },
      [`GET /1/cards/${card.id}`]: { ...card, list: { name: 'To do' }, board: { name: 'Web app' } },
      [`PUT /1/cards/${card.id}`]: {},
    })
    const issue = await trello.createIssue({ teamId: 'b1', title: 'Add a cart', description: 'Why', labelIds: ['lb1'] })
    expect(issue).toMatchObject({ identifier: 'WA-12', stateName: 'To do' })
    expect(sent('POST', '/1/cards')?.body).toMatchObject({ idList: 'l1', name: 'Add a cart', desc: 'Why', idLabels: ['lb1'] })
    await trello.updateIssueState(card.id, 'l3')
    expect(last()?.body).toEqual({ idList: 'l3' })
  })

  it('names agent labels agent:handle and changes labels one at a time', async () => {
    route({
      'POST /1/labels': { id: 'lb9', name: 'agent:reviewer-1' },
      'GET /1/boards/b1/labels': [{ id: 'lb1', name: 'agent:engineer-1' }],
      [`POST /1/cards/${card.id}/idLabels`]: {},
      [`DELETE /1/cards/${card.id}/idLabels/lb1`]: {},
    })
    expect(await trello.createLabel({ teamId: 'b1', name: 'Agent', isGroup: true })).toMatchObject({ id: 'Agent', isGroup: true })
    expect(await trello.createLabel({ teamId: 'b1', name: 'reviewer-1', parentId: 'Agent' })).toEqual({
      id: 'lb9',
      name: 'reviewer-1',
      parentId: 'Agent',
    })
    expect(sent('POST', '/1/labels')?.body).toMatchObject({ idBoard: 'b1', name: 'agent:reviewer-1' })
    expect((await trello.listLabels('b1')).map((label) => [label.id, label.name])).toEqual([
      ['Agent', 'Agent'],
      ['lb1', 'engineer-1'],
    ])
    await trello.updateIssueLabels(card.id, { add: ['lb9'], remove: ['lb1'] })
    expect(stub.requests.slice(-2).map((request) => request.method)).toEqual(['DELETE', 'POST'])
    expect(last()?.body).toEqual({ value: 'lb9' })
  })

  it('comments, edits a comment, and lists comments oldest first', async () => {
    route({
      [`POST /1/cards/${card.id}/actions/comments`]: { id: 'a2' },
      'PUT /1/actions/a2': {},
      [`GET /1/cards/${card.id}/actions`]: [
        { id: 'a2', data: { text: 'second', card: { id: card.id } }, memberCreator: { fullName: 'Sam' }, date: '2026-01-03T10:00:00.000Z' },
        { id: 'a1', data: { text: 'first', card: { id: card.id } }, memberCreator: { fullName: 'Kim' }, date: '2026-01-02T10:00:00.000Z' },
      ],
    })
    expect(await trello.comment(card.id, 'hello')).toEqual({ id: 'a2' })
    expect(last()?.body).toEqual({ text: 'hello' })
    await trello.updateComment('a2', 'again')
    expect(last()?.body).toEqual({ text: 'again' })
    expect((await trello.listComments(card.id)).map((comment) => [comment.id, comment.body, comment.authorName])).toEqual([
      ['a1', 'first', 'Kim'],
      ['a2', 'second', 'Sam'],
    ])
  })

  it('lists uploads and links, and sends its token only to Trello', async () => {
    route({
      [`GET /1/cards/${card.id}/attachments`]: [
        { id: 'at1', name: 'a.png', fileName: 'a.png', isUpload: true, mimeType: 'image/png', bytes: 3 },
        { id: 'at2', name: 'Spec', url: 'https://docs.example/spec', isUpload: false },
      ],
      [`GET /1/cards/${card.id}/attachments/at1/download/a.png`]: 'png',
    })
    const resources = await trello.listResources(card.id)
    expect(resources.map((resource) => [resource.kind, resource.title])).toEqual([
      ['file', 'a.png'],
      ['link', 'Spec'],
    ])
    expect((await trello.fetchMedia(resources[0]?.url as string))?.status).toBe(200)
    const before = stub.requests.length
    expect(await trello.fetchMedia('https://evil.example/1/cards/c/attachments/a/download/a.png')).toBeNull()
    expect(stub.requests.length).toBe(before)
  })

  it('registers a webhook on the board', async () => {
    route({ 'POST /1/webhooks': { id: 'w1' } })
    expect(await trello.registerWebhook({ teamId: 'b1', url: 'https://fx.example/webhooks/trello/1', secret: 's' })).toEqual({ id: 'w1' })
    expect(last()?.body).toMatchObject({ callbackURL: 'https://fx.example/webhooks/trello/1', idModel: 'b1' })
  })
})

describe('Trello webhook codec', () => {
  const url = 'https://fx.example/webhooks/trello/1'

  it('verifies the signature of the body and the address together', () => {
    const body = Buffer.from('{"action":{"id":"a1"}}')
    const signature = createHmac('sha1', 'api-secret').update(`${body.toString()}${url}`).digest('base64')
    expect(trelloWebhookCodec.verify(body, { 'x-trello-webhook': signature }, 'api-secret', url)).toBe(true)
    expect(trelloWebhookCodec.verify(body, { 'x-trello-webhook': signature }, 'api-secret', `${url}x`)).toBe(false)
    expect(trelloWebhookCodec.verify(body, { 'x-trello-webhook': signature }, 'other', url)).toBe(false)
    expect(trelloWebhookCodec.verify(body, { 'x-trello-webhook': signature }, 'api-secret')).toBe(false)
    expect(trelloWebhookCodec.deliveryId({}, body)).toBe('a1')
  })

  it('names the card that changed and leaves the rest to be read', () => {
    const data = {
      card: { id: 'c1', name: 'Add a cart', idShort: 12 },
      board: { id: 'b1', name: 'Web app' },
      listBefore: { id: 'l1' },
      listAfter: { id: 'l2' },
    }
    expect(trelloWebhookCodec.parse({ action: { id: 'a1', type: 'updateCard', date: '2026-01-03T10:00:00.000Z', data } })).toMatchObject({
      kind: 'issue.upserted',
      previousStateId: 'l1',
      issue: { id: 'c1', teamId: 'b1', stateId: 'l2', stateName: '', identifier: '' },
    })
    expect(trelloWebhookCodec.parse({ action: { type: 'deleteCard', data } })).toEqual({ kind: 'issue.removed', issueId: 'c1' })
    expect(
      trelloWebhookCodec.parse({
        action: { id: 'a2', type: 'commentCard', date: 'now', memberCreator: { fullName: 'Sam' }, data: { ...data, text: 'please' } },
      }),
    ).toMatchObject({ kind: 'comment.upserted', action: 'create', comment: { id: 'a2', issueId: 'c1', body: 'please', authorName: 'Sam' } })
    expect(trelloWebhookCodec.parse({ action: { type: 'updateBoard', data: {} } }).kind).toBe('ignored')
  })
})
