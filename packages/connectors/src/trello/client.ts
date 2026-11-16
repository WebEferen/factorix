import type {
  CreateIssueInput,
  Page,
  TrackerComment,
  TrackerConnector,
  TrackerIssue,
  TrackerLabel,
  TrackerMedia,
  TrackerProject,
  TrackerResource,
  TrackerState,
  TrackerStateType,
  TrackerTeam,
} from '../tracker'

// biome-ignore lint/suspicious/noExplicitAny: Trello response bodies, read field by field
type Loose = Record<string, any>

const API = 'https://api.trello.com'
const AGENT_GROUP = 'Agent'
const AGENT_PREFIX = 'agent:'
const CARD_FIELDS = 'name,desc,idShort,shortUrl,idBoard,idList,labels,closed,dateLastActivity'
const PAGE_SIZE = 1000

/** A Trello list is only a name, so its place in the workflow is read from the words people usually give one. */
export function trelloStateType(name: string): TrackerStateType {
  if (/cancel|won.?t|reject|declin/i.test(name)) return 'canceled'
  if (/done|complete|shipped|released|closed|merged|live/i.test(name)) return 'completed'
  if (/backlog|icebox|ideas|someday|later/i.test(name)) return 'backlog'
  return /progress|doing|review|block|test|qa|working|started/i.test(name) ? 'started' : 'unstarted'
}

/** Cards are numbered per board and have no prefix, so one is made from the board's name: Web app gives WA-12. */
export function trelloBoardKey(name: string): string {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
  const key = (words.length > 1 ? words.map((word) => word[0]).join('') : (words[0] ?? '')).replace(/^[0-9]+/, '').slice(0, 5)
  return key || 'CARD'
}

/* Trello labels have no groups. An agent's label is named agent:handle, and reads as a child of one Agent group. */
export function mapTrelloLabel(raw: Loose): TrackerLabel {
  const name = String(raw.name || raw.color || 'label')
  return name.startsWith(AGENT_PREFIX)
    ? { id: raw.id, name: name.slice(AGENT_PREFIX.length), parentId: AGENT_GROUP }
    : { id: raw.id, name, parentId: null }
}

/** The first eight hex digits of a Trello id are the second it was created. */
function createdAt(id: string): string | null {
  const seconds = Number.parseInt(String(id).slice(0, 8), 16)
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null
}

function mapCard(card: Loose, list: { name: string } | undefined, boardName: string): TrackerIssue {
  const listed = trelloStateType(list?.name ?? '')
  const member = (card.members as Loose[] | undefined)?.[0]
  return {
    id: card.id,
    identifier: `${trelloBoardKey(boardName)}-${card.idShort}`,
    title: card.name ?? '',
    description: card.desc || null,
    url: card.shortUrl ?? null,
    priority: 0,
    teamId: card.idBoard,
    projectId: null,
    stateId: card.idList,
    stateName: list?.name ?? '',
    // People archive finished cards to tidy a board. Only an archived card that was not finished counts as dropped.
    stateType: card.closed && listed !== 'completed' ? 'canceled' : listed,
    assigneeId: member?.id ?? null,
    assigneeName: member?.fullName ?? member?.username ?? null,
    creatorId: null,
    creatorName: null,
    labels: ((card.labels as Loose[]) ?? []).map(mapTrelloLabel),
    createdAt: createdAt(card.id),
    updatedAt: card.dateLastActivity ?? new Date().toISOString(),
    archivedAt: card.closed ? (card.dateLastActivity ?? null) : null,
  }
}

export function mapTrelloComment(action: Loose): TrackerComment {
  return {
    id: action.id,
    issueId: action.data?.card?.id,
    body: action.data?.text ?? '',
    authorId: action.memberCreator?.id ?? action.idMemberCreator ?? null,
    authorName: action.memberCreator?.fullName ?? action.memberCreator?.username ?? null,
    createdAt: action.date ?? new Date().toISOString(),
  }
}

export class TrelloConnector implements TrackerConnector {
  readonly kind = 'trello' as const
  private readonly authorization: string
  private readonly api: string

  constructor(options: { apiKey: string; token: string; apiUrl?: string }) {
    // The header keeps the key and token out of URLs, which end up in logs.
    this.authorization = `OAuth oauth_consumer_key="${options.apiKey}", oauth_token="${options.token}"`
    this.api = (options.apiUrl ?? API).replace(/\/$/, '')
  }

  private async send(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const response = await fetch(url, {
      method,
      headers: { authorization: this.authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.ok || response.status === 206) return response
    const text = await response.text().catch(() => '')
    let message = text
    try {
      message = (JSON.parse(text) as Loose).message ?? text
    } catch {}
    throw new Error(message.slice(0, 300) || `Trello answered ${response.status}`)
  }

  private async request<T = Loose>(
    method: string,
    path: string,
    options: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ) {
    const url = new URL(`${this.api}/1${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value))
    return (await (await this.send(method, url.toString(), options.body)).json()) as T
  }

  private lists(boardId: string): Promise<Loose[]> {
    return this.request<Loose[]>('GET', `/boards/${encodeURIComponent(boardId)}/lists`, { query: { filter: 'all', fields: 'name,pos,closed' } })
  }

  async viewer(): Promise<{ id: string; name: string; email: string | null }> {
    const member = await this.request('GET', '/members/me', { query: { fields: 'fullName,username,email' } })
    return { id: member.id, name: member.fullName ?? member.username, email: member.email ?? null }
  }

  async listTeams(): Promise<TrackerTeam[]> {
    const boards = await this.request<Loose[]>('GET', '/members/me/boards', { query: { filter: 'open', fields: 'name' } })
    return boards.map((board) => ({ id: board.id, key: trelloBoardKey(board.name), name: board.name }))
  }

  /** A board is the team here, and its lists are the statuses. */
  async listProjects(): Promise<TrackerProject[]> {
    return []
  }

  async listWorkflowStates(teamId: string): Promise<TrackerState[]> {
    const open = (await this.lists(teamId)).filter((list) => !list.closed).sort((a, b) => a.pos - b.pos)
    return open.map((list, position) => ({ id: list.id, name: list.name, type: trelloStateType(list.name), position }))
  }

  async listLabels(teamId: string): Promise<TrackerLabel[]> {
    const labels = await this.request<Loose[]>('GET', `/boards/${encodeURIComponent(teamId)}/labels`, { query: { limit: 1000 } })
    return [{ id: AGENT_GROUP, name: AGENT_GROUP, parentId: null, isGroup: true }, ...labels.map(mapTrelloLabel)]
  }

  async listIssues(query: Parameters<TrackerConnector['listIssues']>[0]): Promise<Page<TrackerIssue>> {
    const board = encodeURIComponent(query.teamId)
    // Trello pages by when a card was made, newest first, and cannot filter by when it changed.
    const [cards, lists, { name }] = await Promise.all([
      this.request<Loose[]>('GET', `/boards/${board}/cards/all`, {
        query: { fields: CARD_FIELDS, members: true, member_fields: 'fullName,username', limit: PAGE_SIZE, before: query.cursor ?? undefined },
      }),
      this.lists(query.teamId),
      this.request('GET', `/boards/${board}`, { query: { fields: 'name' } }),
    ])
    const byId = new Map(lists.map((list) => [list.id as string, list as { name: string }]))
    const nodes = cards
      .map((card) => mapCard(card, byId.get(card.idList), name))
      .filter((issue) => !query.updatedAfter || issue.updatedAt > query.updatedAfter)
      .filter((issue) => !query.closedSince || !['completed', 'canceled'].includes(issue.stateType) || issue.updatedAt > query.closedSince)
    return { nodes, nextCursor: cards.length === PAGE_SIZE ? (cards.at(-1)?.id ?? null) : null }
  }

  async getIssue(id: string): Promise<TrackerIssue | null> {
    try {
      const card = await this.request('GET', `/cards/${encodeURIComponent(id)}`, {
        query: { fields: CARD_FIELDS, members: true, member_fields: 'fullName,username', list: true, board: true, board_fields: 'name' },
      })
      return mapCard(card, card.list, card.board?.name ?? '')
    } catch {
      return null
    }
  }

  async listComments(issueId: string): Promise<TrackerComment[]> {
    const actions = await this.request<Loose[]>('GET', `/cards/${encodeURIComponent(issueId)}/actions`, {
      query: { filter: 'commentCard', limit: 200 },
    })
    return actions.map((action) => ({ ...mapTrelloComment(action), issueId })).reverse()
  }

  async listResources(issueId: string): Promise<TrackerResource[]> {
    const card = encodeURIComponent(issueId)
    const attachments = await this.request<Loose[]>('GET', `/cards/${card}/attachments`)
    return attachments.map((file) =>
      file.isUpload
        ? {
            kind: 'file' as const,
            title: file.name,
            url: `${this.api}/1/cards/${card}/attachments/${file.id}/download/${encodeURIComponent(file.fileName ?? file.name)}`,
            subtitle: null,
            content: null,
            mimeType: file.mimeType || null,
            size: file.bytes ?? null,
          }
        : { kind: 'link' as const, title: file.name ?? file.url, url: file.url, subtitle: null, content: null },
    )
  }

  async createIssue(input: CreateIssueInput): Promise<TrackerIssue> {
    const states = input.stateId ? [] : await this.listWorkflowStates(input.teamId)
    const idList = input.stateId ?? (states.find((state) => state.type === 'unstarted') ?? states[0])?.id
    if (!idList) throw new Error('This Trello board has no list to put a card in')
    const card = await this.request('POST', '/cards', {
      body: { idList, name: input.title, desc: input.description ?? '', idLabels: input.labelIds ?? [], pos: 'top' },
    })
    const issue = await this.getIssue(card.id)
    if (!issue) throw new Error('Trello created the card but would not return it')
    return issue
  }

  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    await this.request('PUT', `/cards/${encodeURIComponent(issueId)}`, { body: { idList: stateId } })
  }

  async updateIssueLabels(issueId: string, change: { add?: string[]; remove?: string[] }): Promise<void> {
    const card = encodeURIComponent(issueId)
    // Trello answers an error for a label the card already has, or one it never had, and neither is a failure here.
    for (const id of change.remove ?? []) await this.request('DELETE', `/cards/${card}/idLabels/${encodeURIComponent(id)}`).catch(() => undefined)
    for (const value of change.add ?? []) await this.request('POST', `/cards/${card}/idLabels`, { body: { value } }).catch(() => undefined)
  }

  async createLabel(input: { teamId: string; name: string; parentId?: string; isGroup?: boolean }): Promise<TrackerLabel> {
    if (input.isGroup) return { id: AGENT_GROUP, name: AGENT_GROUP, parentId: null, isGroup: true }
    const name = input.parentId === AGENT_GROUP ? `${AGENT_PREFIX}${input.name}` : input.name
    return mapTrelloLabel(
      await this.request('POST', '/labels', { body: { idBoard: input.teamId, name, color: input.parentId === AGENT_GROUP ? 'blue' : null } }),
    )
  }

  async comment(issueId: string, body: string): Promise<{ id: string }> {
    const action = await this.request('POST', `/cards/${encodeURIComponent(issueId)}/actions/comments`, { body: { text: body } })
    return { id: action.id }
  }

  async updateComment(commentId: string, body: string): Promise<void> {
    await this.request('PUT', `/actions/${encodeURIComponent(commentId)}`, { body: { text: body } })
  }

  /** Trello signs with the API secret of the key, not with a secret given here, and calls the address once to check it answers. */
  async registerWebhook(input: { teamId: string; url: string; secret: string }): Promise<{ id: string }> {
    const hook = await this.request('POST', '/webhooks', { body: { callbackURL: input.url, idModel: input.teamId, description: 'Factorix' } })
    return { id: hook.id }
  }

  async fetchMedia(url: string, options?: { range?: string }): Promise<TrackerMedia | null> {
    // The key and token go only to Trello's own API, whatever the link says.
    if (new URL(url).origin !== new URL(this.api).origin) return null
    const response = await this.send('GET', url, undefined, options?.range ? { range: options.range } : {}).catch(() => null)
    if (!response?.body) return null
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'),
      contentRange: response.headers.get('content-range'),
      body: response.body,
    }
  }
}
