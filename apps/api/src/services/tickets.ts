import {
  type CreateIssueInput,
  FACTORIX_STATES,
  type Page,
  type TrackerComment,
  type TrackerConnector,
  type TrackerIssue,
  type TrackerLabel,
  type TrackerState,
  type TrackerTeam,
} from '@factorix/connectors'
import { type ConnectionRow, type Db, json, plainText } from '@factorix/db'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLOSED_STATES = FACTORIX_STATES.filter((state) => state.type === 'completed' || state.type === 'canceled').map((state) => state.id)

interface TicketRow {
  id: string
  boardId: string
  boardKey: string
  number: number
  title: string
  description: string | null
  priority: number
  stateId: string
  labelIds: string[]
  creatorName: string | null
  createdAt: Date
  updatedAt: Date
}

function stateOf(id: string): TrackerState {
  const state = FACTORIX_STATES.find((candidate) => candidate.id === id)
  if (!state) throw new Error(`Built-in tickets have no status ${id}`)
  return state
}

/**
 * Built-in tickets, behind the contract every tracker implements. Each query goes through the connection's own boards,
 * so an id from another organization finds nothing.
 */
export class FactorixTracker implements TrackerConnector {
  readonly kind = 'factorix' as const

  constructor(
    private readonly db: Db,
    private readonly connection: Pick<ConnectionRow, 'id' | 'orgId'>,
  ) {}

  private tickets() {
    return this.db('tickets')
      .join('ticket_boards', 'tickets.board_id', 'ticket_boards.id')
      .where({ 'ticket_boards.connection_id': this.connection.id })
      .select('tickets.*', 'ticket_boards.key as board_key')
  }

  private async toIssues(rows: TicketRow[]): Promise<TrackerIssue[]> {
    const boardIds = [...new Set(rows.map((row) => row.boardId))]
    const labels = boardIds.length > 0 ? ((await this.db('ticket_labels').whereIn('boardId', boardIds)) as LabelRow[]) : []
    const byId = new Map(labels.map((label) => [label.id, mapLabel(label)]))
    return rows.map((row) => {
      const state = stateOf(row.stateId)
      return {
        id: row.id,
        identifier: `${row.boardKey}-${row.number}`,
        title: row.title,
        description: row.description,
        url: null,
        priority: row.priority,
        teamId: row.boardId,
        projectId: null,
        stateId: state.id,
        stateName: state.name,
        stateType: state.type,
        assigneeId: null,
        assigneeName: null,
        creatorId: null,
        creatorName: row.creatorName,
        labels: row.labelIds.flatMap((id) => byId.get(id) ?? []),
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
        archivedAt: null,
      }
    })
  }

  private async board(teamId: string): Promise<{ id: string } | undefined> {
    if (!UUID.test(teamId)) return undefined
    return this.db('ticket_boards').where({ id: teamId, connectionId: this.connection.id }).first('id')
  }

  private async requireBoard(teamId: string): Promise<{ id: string }> {
    const board = await this.board(teamId)
    if (!board) throw new Error('Unknown ticket board')
    return board
  }

  private async requireTicket(id: string): Promise<TicketRow> {
    const row = UUID.test(id) ? ((await this.tickets().where({ 'tickets.id': id }).first()) as TicketRow | undefined) : undefined
    if (!row) throw new Error('Unknown ticket')
    return row
  }

  async viewer() {
    return { id: this.connection.id, name: 'Factorix', email: null }
  }

  async listTeams(): Promise<TrackerTeam[]> {
    return this.db('ticket_boards').where({ connectionId: this.connection.id }).orderBy('name').select('id', 'key', 'name')
  }

  async createBoard(input: { key: string; name: string }): Promise<TrackerTeam> {
    const [row] = await this.db('ticket_boards')
      .insert({ orgId: this.connection.orgId, connectionId: this.connection.id, key: input.key, name: input.name })
      .returning(['id', 'key', 'name'])
    return row as TrackerTeam
  }

  async listProjects() {
    return []
  }

  async listWorkflowStates(teamId: string): Promise<TrackerState[]> {
    return (await this.board(teamId)) ? FACTORIX_STATES : []
  }

  async listLabels(teamId: string): Promise<TrackerLabel[]> {
    const board = await this.board(teamId)
    return board ? ((await this.db('ticket_labels').where({ boardId: board.id }).orderBy('name')) as LabelRow[]).map(mapLabel) : []
  }

  async listIssues(query: Parameters<TrackerConnector['listIssues']>[0]): Promise<Page<TrackerIssue>> {
    const board = await this.board(query.teamId)
    if (!board) return { nodes: [], nextCursor: null }
    const offset = Number(query.cursor ?? 0)
    const limit = query.limit ?? 50
    const rows = (await this.tickets()
      .where({ 'tickets.board_id': board.id })
      .modify((builder) => {
        if (query.updatedAfter) builder.where('tickets.updated_at', '>', query.updatedAfter)
        const since = query.closedSince
        if (since) builder.where((open) => open.whereNotIn('tickets.state_id', CLOSED_STATES).orWhere('tickets.updated_at', '>', since))
      })
      .orderBy([{ column: 'tickets.updated_at' }, { column: 'tickets.id' }])
      .offset(offset)
      .limit(limit + 1)) as TicketRow[]
    return { nodes: await this.toIssues(rows.slice(0, limit)), nextCursor: rows.length > limit ? String(offset + limit) : null }
  }

  async getIssue(id: string): Promise<TrackerIssue | null> {
    if (!UUID.test(id)) return null
    const row = (await this.tickets().where({ 'tickets.id': id }).first()) as TicketRow | undefined
    return row ? ((await this.toIssues([row]))[0] ?? null) : null
  }

  async listComments(issueId: string): Promise<TrackerComment[]> {
    const ticket = await this.requireTicket(issueId)
    const rows = (await this.db('ticket_comments').where({ ticketId: ticket.id }).orderBy('created_at')) as {
      id: string
      body: string
      authorName: string | null
      createdAt: Date
    }[]
    return rows.map((row) => ({
      id: row.id,
      issueId: ticket.id,
      body: row.body,
      authorId: null,
      authorName: row.authorName,
      createdAt: new Date(row.createdAt).toISOString(),
    }))
  }

  async listResources() {
    return []
  }

  async createIssue(input: CreateIssueInput): Promise<TrackerIssue> {
    const board = await this.requireBoard(input.teamId)
    const stateId = stateOf(input.stateId ?? 'todo').id
    const id = await this.db.transaction(async (trx) => {
      // The update locks the board's row, so two tickets created at once cannot share a number.
      const [{ nextNumber }] = (await trx('ticket_boards')
        .where({ id: board.id })
        .update({ nextNumber: trx.raw('next_number + 1') })
        .returning('next_number')) as [{ nextNumber: number }]
      const [row] = await trx('tickets')
        .insert({
          boardId: board.id,
          number: nextNumber - 1,
          title: plainText(input.title),
          description: plainText(input.description) ?? null,
          priority: input.priority ?? 0,
          stateId,
          labelIds: json(input.labelIds ?? []),
          creatorName: input.creatorName ?? null,
        })
        .returning('id')
      return row.id as string
    })
    return (await this.getIssue(id)) as TrackerIssue
  }

  /** What a person changes on a ticket. Every other tracker has its own screen for this. */
  async updateIssue(id: string, change: { title?: string; description?: string | null; priority?: number; stateId?: string }): Promise<TrackerIssue> {
    const ticket = await this.requireTicket(id)
    await this.db('tickets')
      .where({ id: ticket.id })
      .update({
        ...(change.title === undefined ? {} : { title: change.title }),
        ...(change.description === undefined ? {} : { description: change.description }),
        ...(change.priority === undefined ? {} : { priority: change.priority }),
        ...(change.stateId === undefined ? {} : { stateId: stateOf(change.stateId).id }),
        updatedAt: this.db.fn.now(),
      })
    return (await this.getIssue(ticket.id)) as TrackerIssue
  }

  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    await this.updateIssue(issueId, { stateId })
  }

  async updateIssueLabels(issueId: string, change: { add?: string[]; remove?: string[] }): Promise<void> {
    const ticket = await this.requireTicket(issueId)
    const remove = new Set(change.remove ?? [])
    const labelIds = [...new Set([...ticket.labelIds.filter((id) => !remove.has(id)), ...(change.add ?? [])])]
    await this.db('tickets')
      .where({ id: ticket.id })
      .update({ labelIds: json(labelIds), updatedAt: this.db.fn.now() })
  }

  async createLabel(input: { teamId: string; name: string; parentId?: string; isGroup?: boolean }): Promise<TrackerLabel> {
    const board = await this.requireBoard(input.teamId)
    const [row] = await this.db('ticket_labels')
      .insert({ boardId: board.id, name: input.name, parentId: input.parentId ?? null, isGroup: input.isGroup ?? false })
      .returning('*')
    return mapLabel(row as LabelRow)
  }

  async comment(issueId: string, body: string): Promise<{ id: string }> {
    const ticket = await this.requireTicket(issueId)
    const [row] = await this.db('ticket_comments')
      .insert({ ticketId: ticket.id, body: plainText(body) })
      .returning('id')
    return { id: row.id as string }
  }

  async updateComment(commentId: string, body: string): Promise<void> {
    if (!UUID.test(commentId)) return
    await this.db('ticket_comments')
      .whereIn('ticket_id', this.tickets().clearSelect().select('tickets.id'))
      .where({ id: commentId })
      .update({ body: plainText(body) })
  }

  async registerWebhook() {
    return { id: 'built-in' }
  }

  async fetchMedia() {
    return null
  }
}

interface LabelRow {
  id: string
  name: string
  parentId: string | null
  isGroup: boolean
}

function mapLabel(row: LabelRow): TrackerLabel {
  return { id: row.id, name: row.name, parentId: row.parentId, isGroup: row.isGroup }
}
