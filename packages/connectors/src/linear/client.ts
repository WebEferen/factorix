import { LinearClient } from '@linear/sdk'
import type {
  CreateIssueInput,
  Page,
  TrackerComment,
  TrackerConnector,
  TrackerIssue,
  TrackerLabel,
  TrackerMedia,
  TrackerProject,
  TrackerState,
  TrackerStateType,
  TrackerTeam,
} from '../tracker'

const ISSUE_FIELDS = `
  id identifier title description url priority createdAt updatedAt archivedAt
  team { id }
  project { id }
  state { id name type }
  assignee { id displayName }
  creator { id displayName }
  labels(first: 50) { nodes { id name parent { id } } }
`

interface RawIssue {
  id: string
  identifier: string
  title: string
  description?: string | null
  url?: string | null
  priority?: number | null
  createdAt?: string | null
  updatedAt: string
  archivedAt?: string | null
  team: { id: string }
  project?: { id: string } | null
  state: { id: string; name: string; type: string }
  assignee?: { id: string; displayName: string } | null
  creator?: { id: string; displayName: string } | null
  labels?: { nodes: { id: string; name: string; parent?: { id: string } | null }[] }
}

function mapIssue(raw: RawIssue): TrackerIssue {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description ?? null,
    url: raw.url ?? null,
    priority: raw.priority ?? 0,
    teamId: raw.team.id,
    projectId: raw.project?.id ?? null,
    stateId: raw.state.id,
    stateName: raw.state.name,
    stateType: raw.state.type as TrackerStateType,
    assigneeId: raw.assignee?.id ?? null,
    assigneeName: raw.assignee?.displayName ?? null,
    creatorId: raw.creator?.id ?? null,
    creatorName: raw.creator?.displayName ?? null,
    labels: (raw.labels?.nodes ?? []).map((label) => ({ id: label.id, name: label.name, parentId: label.parent?.id ?? null })),
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt,
    archivedAt: raw.archivedAt ?? null,
  }
}

export class LinearConnector implements TrackerConnector {
  readonly kind = 'linear' as const
  private readonly client: LinearClient
  private readonly apiKey: string

  constructor(options: { apiKey: string; apiUrl?: string }) {
    this.apiKey = options.apiKey
    this.client = new LinearClient({ apiKey: options.apiKey, apiUrl: options.apiUrl })
  }

  private async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await this.client.client.rawRequest<T, Record<string, unknown>>(query, variables)
    if (!response.data) throw new Error('Linear returned no data')
    return response.data
  }

  async fetchMedia(url: string, options: { range?: string } = {}): Promise<TrackerMedia | null> {
    const range: Record<string, string> = options.range ? { Range: options.range } : {}
    // Personal keys go bare on the API and OAuth tokens take Bearer, and the upload host's choice is not documented per key type.
    let response = await fetch(url, { headers: { Authorization: this.apiKey, ...range } })
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel()
      response = await fetch(url, { headers: { Authorization: `Bearer ${this.apiKey}`, ...range } })
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      return null
    }
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'),
      contentRange: response.headers.get('content-range'),
      body: response.body,
    }
  }

  async viewer(): Promise<{ id: string; name: string; email: string | null }> {
    const { viewer } = await this.request<{ viewer: { id: string; name: string; email: string | null } }>('query Viewer { viewer { id name email } }')
    return viewer
  }

  async listTeams(): Promise<TrackerTeam[]> {
    const { teams } = await this.request<{ teams: { nodes: TrackerTeam[] } }>('query Teams { teams(first: 100) { nodes { id key name } } }')
    return teams.nodes
  }

  async listProjects(teamId: string): Promise<TrackerProject[]> {
    const { team } = await this.request<{ team: { projects: { nodes: { id: string; name: string; url?: string | null }[] } } }>(
      'query TeamProjects($id: String!) { team(id: $id) { projects(first: 200) { nodes { id name url } } } }',
      { id: teamId },
    )
    return team.projects.nodes.map((project) => ({ id: project.id, name: project.name, url: project.url ?? null }))
  }

  async listWorkflowStates(teamId: string): Promise<TrackerState[]> {
    const { team } = await this.request<{ team: { states: { nodes: { id: string; name: string; type: string; position: number }[] } } }>(
      'query TeamStates($id: String!) { team(id: $id) { states(first: 100) { nodes { id name type position } } } }',
      { id: teamId },
    )
    return team.states.nodes.map((state) => ({ ...state, type: state.type as TrackerStateType })).sort((a, b) => a.position - b.position)
  }

  async listLabels(teamId: string): Promise<TrackerLabel[]> {
    const { team } = await this.request<{
      team: { labels: { nodes: { id: string; name: string; isGroup: boolean; parent?: { id: string } | null }[] } }
    }>('query TeamLabels($id: String!) { team(id: $id) { labels(first: 250) { nodes { id name isGroup parent { id } } } } }', { id: teamId })
    return team.labels.nodes.map((label) => ({ id: label.id, name: label.name, isGroup: label.isGroup, parentId: label.parent?.id ?? null }))
  }

  async listIssues(query: {
    teamId: string
    projectId?: string | null
    updatedAfter?: string
    closedSince?: string
    cursor?: string | null
    limit?: number
  }): Promise<Page<TrackerIssue>> {
    const filter: Record<string, unknown> = { team: { id: { eq: query.teamId } } }
    if (query.projectId) filter.project = { id: { eq: query.projectId } }
    if (query.updatedAfter) filter.updatedAt = { gt: query.updatedAfter }
    if (query.closedSince) filter.or = [{ state: { type: { nin: ['completed', 'canceled'] } } }, { updatedAt: { gt: query.closedSince } }]
    const { issues } = await this.request<{ issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } } }>(
      `query Issues($filter: IssueFilter, $first: Int, $after: String) {
        issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { filter, first: query.limit ?? 50, after: query.cursor ?? undefined },
    )
    return { nodes: issues.nodes.map(mapIssue), nextCursor: issues.pageInfo.hasNextPage ? (issues.pageInfo.endCursor ?? null) : null }
  }

  async getIssue(id: string): Promise<TrackerIssue | null> {
    try {
      const { issue } = await this.request<{ issue: RawIssue | null }>(`query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id })
      return issue ? mapIssue(issue) : null
    } catch (error) {
      if (/not found|Entity not found/i.test(String((error as Error).message))) return null
      throw error
    }
  }

  async listComments(issueId: string): Promise<TrackerComment[]> {
    const { issue } = await this.request<{
      issue: { comments: { nodes: { id: string; body: string; createdAt: string; user?: { id: string; displayName: string } | null }[] } }
    }>('query IssueComments($id: String!) { issue(id: $id) { comments(first: 100) { nodes { id body createdAt user { id displayName } } } } }', {
      id: issueId,
    })
    return issue.comments.nodes.map((comment) => ({
      id: comment.id,
      issueId,
      body: comment.body,
      authorId: comment.user?.id ?? null,
      authorName: comment.user?.displayName ?? null,
      createdAt: comment.createdAt,
    }))
  }

  async createIssue(input: CreateIssueInput): Promise<TrackerIssue> {
    const { issueCreate } = await this.request<{ issueCreate: { success: boolean; issue: RawIssue } }>(
      `mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
      {
        input: {
          teamId: input.teamId,
          projectId: input.projectId ?? undefined,
          title: input.title,
          description: input.description,
          priority: input.priority,
          stateId: input.stateId,
          labelIds: input.labelIds,
        },
      },
    )
    return mapIssue(issueCreate.issue)
  }

  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    await this.request('mutation IssueState($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', {
      id: issueId,
      input: { stateId },
    })
  }

  async updateIssueLabels(issueId: string, change: { add?: string[]; remove?: string[] }): Promise<void> {
    await this.request('mutation IssueLabels($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', {
      id: issueId,
      input: { addedLabelIds: change.add, removedLabelIds: change.remove },
    })
  }

  async createLabel(input: { teamId: string; name: string; parentId?: string; isGroup?: boolean; color?: string }): Promise<TrackerLabel> {
    const { issueLabelCreate } = await this.request<{
      issueLabelCreate: { issueLabel: { id: string; name: string; isGroup: boolean; parent?: { id: string } | null } }
    }>('mutation LabelCreate($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id name isGroup parent { id } } } }', {
      input,
    })
    const label = issueLabelCreate.issueLabel
    return { id: label.id, name: label.name, isGroup: label.isGroup, parentId: label.parent?.id ?? null }
  }

  async comment(issueId: string, body: string): Promise<{ id: string }> {
    const { commentCreate } = await this.request<{ commentCreate: { comment: { id: string } } }>(
      'mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }',
      { input: { issueId, body } },
    )
    return { id: commentCreate.comment.id }
  }

  async updateComment(commentId: string, body: string): Promise<void> {
    await this.request('mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }', {
      id: commentId,
      input: { body },
    })
  }

  async registerWebhook(input: { teamId: string; url: string; secret: string }): Promise<{ id: string }> {
    const { webhookCreate } = await this.request<{ webhookCreate: { webhook: { id: string } } }>(
      'mutation WebhookCreate($input: WebhookCreateInput!) { webhookCreate(input: $input) { webhook { id } } }',
      { input: { url: input.url, secret: input.secret, teamId: input.teamId, label: 'Factorix', resourceTypes: ['Issue', 'Comment'] } },
    )
    return { id: webhookCreate.webhook.id }
  }
}
