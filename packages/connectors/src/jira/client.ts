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
  UpdateIssueInput,
} from '../tracker'
import { markdownToJira } from './markup'

// biome-ignore lint/suspicious/noExplicitAny: Jira response bodies, read field by field
type Loose = Record<string, any>

const ISSUE_FIELDS = ['summary', 'description', 'status', 'priority', 'assignee', 'creator', 'reporter', 'labels', 'created', 'updated', 'project']
const AGENT_GROUP = 'Agent'
const AGENT_PREFIX = 'agent:'
const PRIORITY_NAMES: Record<number, string> = { 1: 'Highest', 2: 'High', 3: 'Medium', 4: 'Low' }

export function jiraStateType(status: Loose | undefined): TrackerStateType {
  const name = String(status?.name ?? '')
  const category = status?.statusCategory?.key
  if (category === 'done') return /cancel|won.?t|reject|declin|duplicate/i.test(name) ? 'canceled' : 'completed'
  if (category === 'indeterminate') return 'started'
  return /backlog/i.test(name) ? 'backlog' : 'unstarted'
}

function mapPriority(priority: Loose | null | undefined): number {
  const name = String(priority?.name ?? '').toLowerCase()
  if (!name) return 0
  if (/highest|blocker|critical|urgent/.test(name)) return 1
  if (/high|major/.test(name)) return 2
  if (/medium|normal/.test(name)) return 3
  return /low|minor|trivial/.test(name) ? 4 : 0
}

/* Jira labels are plain words with no groups. An agent's label is written agent:handle, and reads as a child of one Agent group. */
export function mapJiraLabel(label: string): TrackerLabel {
  return label.startsWith(AGENT_PREFIX)
    ? { id: label, name: label.slice(AGENT_PREFIX.length), parentId: AGENT_GROUP }
    : { id: label, name: label, parentId: null }
}

const iso = (value: string | undefined | null): string | null => (value ? new Date(value).toISOString() : null)

export function mapJiraIssue(raw: Loose): TrackerIssue {
  const fields = (raw.fields ?? {}) as Loose
  const creator = (fields.creator ?? fields.reporter) as Loose | undefined
  return {
    id: String(raw.id),
    identifier: raw.key,
    title: fields.summary ?? '',
    description: typeof fields.description === 'string' ? fields.description : null,
    url: raw.self ? `${new URL(raw.self).origin}/browse/${raw.key}` : null,
    priority: mapPriority(fields.priority),
    teamId: String(fields.project?.id ?? ''),
    projectId: null,
    stateId: String(fields.status?.id ?? ''),
    stateName: fields.status?.name ?? '',
    stateType: jiraStateType(fields.status),
    assigneeId: fields.assignee?.accountId ?? fields.assignee?.name ?? null,
    assigneeName: fields.assignee?.displayName ?? null,
    creatorId: creator?.accountId ?? creator?.name ?? null,
    creatorName: creator?.displayName ?? null,
    labels: ((fields.labels as string[]) ?? []).map(mapJiraLabel),
    createdAt: iso(fields.created),
    updatedAt: iso(fields.updated) ?? new Date().toISOString(),
    archivedAt: null,
  }
}

/** A comment is only reachable through its issue, so its id carries both. */
export function mapJiraComment(raw: Loose, issueId: string): TrackerComment {
  return {
    id: `${issueId}:${raw.id}`,
    issueId,
    // The factory knows its own comments by how they start, which wiki markup writes with one asterisk and escaped brackets.
    body: typeof raw.body === 'string' ? raw.body.replace(/^\s*\*\\?\[(Factorix · [^\]\\]+)\\?\]\*/, '**[$1]**') : '',
    authorId: raw.author?.accountId ?? raw.author?.name ?? null,
    authorName: raw.author?.displayName ?? null,
    createdAt: iso(raw.created) ?? new Date().toISOString(),
  }
}

export class JiraConnector implements TrackerConnector {
  readonly kind = 'jira' as const
  private readonly origin: string
  private readonly authorization: string
  private readonly cloud: boolean

  /** With an email this is a Cloud API token. Without one it is a Data Center personal access token. */
  constructor(options: { token: string; host: string; email?: string }) {
    this.origin = new URL(options.host).origin
    this.cloud = Boolean(options.email)
    this.authorization = options.email ? `Basic ${Buffer.from(`${options.email}:${options.token}`).toString('base64')}` : `Bearer ${options.token}`
  }

  private async send(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: this.authorization,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.ok || response.status === 206) return response
    const failure = (await response.json().catch(() => ({}))) as Loose
    const messages = [...((failure.errorMessages as string[]) ?? []), ...Object.values((failure.errors as Record<string, string>) ?? {})]
    throw new Error(messages.join(' ') || failure.message || `Jira answered ${response.status}`)
  }

  private async request(method: string, path: string, body?: unknown): Promise<Loose> {
    const response = await this.send(method, `${this.origin}${path}`, body)
    return (response.status === 204 ? {} : await response.json().catch(() => ({}))) as Loose
  }

  async viewer(): Promise<{ id: string; name: string; email: string | null }> {
    const user = await this.request('GET', '/rest/api/2/myself')
    return { id: user.accountId ?? user.name, name: user.displayName, email: user.emailAddress ?? null }
  }

  async listTeams(): Promise<TrackerTeam[]> {
    if (!this.cloud) {
      const projects = (await this.request('GET', '/rest/api/2/project')) as unknown as Loose[]
      return projects.map((project) => ({ id: String(project.id), key: project.key, name: project.name }))
    }
    const teams: TrackerTeam[] = []
    for (let startAt = 0; startAt < 1000; startAt += 50) {
      const page = await this.request('GET', `/rest/api/2/project/search?startAt=${startAt}&maxResults=50&orderBy=name`)
      teams.push(...((page.values as Loose[]) ?? []).map((project) => ({ id: String(project.id), key: project.key, name: project.name })))
      if (page.isLast !== false) break
    }
    return teams
  }

  /** A Jira project is the team here, and it has nothing smaller that issues are filed under. */
  async listProjects(): Promise<TrackerProject[]> {
    return []
  }

  async listWorkflowStates(teamId: string): Promise<TrackerState[]> {
    const types = (await this.request('GET', `/rest/api/2/project/${encodeURIComponent(teamId)}/statuses`)) as unknown as Loose[]
    const order: TrackerStateType[] = ['backlog', 'unstarted', 'started', 'completed', 'canceled']
    const states = new Map<string, TrackerState>()
    for (const status of types.flatMap((type) => (type.statuses as Loose[]) ?? [])) {
      if (!states.has(String(status.id)))
        states.set(String(status.id), { id: String(status.id), name: status.name, type: jiraStateType(status), position: 0 })
    }
    return [...states.values()].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type)).map((state, position) => ({ ...state, position }))
  }

  async listLabels(): Promise<TrackerLabel[]> {
    const group: TrackerLabel = { id: AGENT_GROUP, name: AGENT_GROUP, parentId: null, isGroup: true }
    // Only Cloud lists labels. A label exists once an issue carries it, so nothing depends on this list being complete.
    const page = this.cloud ? await this.request('GET', '/rest/api/2/label?maxResults=1000').catch(() => ({}) as Loose) : {}
    return [group, ...((page.values as string[]) ?? []).map(mapJiraLabel)]
  }

  async listIssues(query: Parameters<TrackerConnector['listIssues']>[0]): Promise<Page<TrackerIssue>> {
    // JQL reads a bare number as epoch milliseconds, which sidesteps the account's time zone. A minute of overlap costs nothing.
    const after = (date: string) => new Date(date).getTime() - 60_000
    const clauses = [`project = ${Number(query.teamId)}`]
    if (query.updatedAfter) clauses.push(`updated > ${after(query.updatedAfter)}`)
    if (query.closedSince) clauses.push(`(statusCategory != Done OR updated > ${after(query.closedSince)})`)
    const jql = `${clauses.join(' AND ')} ORDER BY updated ASC, id ASC`
    const maxResults = query.limit ?? 50
    if (this.cloud) {
      const page = await this.request('POST', '/rest/api/2/search/jql', {
        jql,
        fields: ISSUE_FIELDS,
        maxResults,
        ...(query.cursor ? { nextPageToken: query.cursor } : {}),
      })
      return { nodes: ((page.issues as Loose[]) ?? []).map(mapJiraIssue), nextCursor: page.nextPageToken ?? null }
    }
    const startAt = Number(query.cursor ?? 0)
    const page = await this.request('POST', '/rest/api/2/search', { jql, fields: ISSUE_FIELDS, maxResults, startAt })
    const issues = (page.issues as Loose[]) ?? []
    return { nodes: issues.map(mapJiraIssue), nextCursor: startAt + issues.length < Number(page.total ?? 0) ? String(startAt + issues.length) : null }
  }

  async getIssue(id: string): Promise<TrackerIssue | null> {
    try {
      return mapJiraIssue(await this.request('GET', `/rest/api/2/issue/${encodeURIComponent(id)}?fields=${ISSUE_FIELDS.join(',')}`))
    } catch {
      return null
    }
  }

  async listComments(issueId: string): Promise<TrackerComment[]> {
    const page = await this.request('GET', `/rest/api/2/issue/${encodeURIComponent(issueId)}/comment?maxResults=200`)
    return ((page.comments as Loose[]) ?? []).map((comment) => mapJiraComment(comment, issueId))
  }

  async listResources(issueId: string): Promise<TrackerResource[]> {
    const path = `/rest/api/2/issue/${encodeURIComponent(issueId)}`
    const [issue, links] = await Promise.all([
      this.request('GET', `${path}?fields=attachment`),
      this.request('GET', `${path}/remotelink`).catch(() => []) as Promise<unknown>,
    ])
    const files: TrackerResource[] = ((issue.fields?.attachment as Loose[]) ?? []).map((file) => ({
      kind: 'file',
      title: file.filename,
      url: file.content,
      subtitle: file.author?.displayName ?? null,
      content: null,
      mimeType: file.mimeType ?? null,
      size: file.size ?? null,
    }))
    const remote: TrackerResource[] = (Array.isArray(links) ? (links as Loose[]) : [])
      .filter((link) => link.object?.url)
      .map((link) => ({
        kind: 'link',
        title: link.object.title ?? link.object.url,
        url: link.object.url,
        subtitle: link.object.summary ?? null,
        content: null,
      }))
    return [...files, ...remote]
  }

  async createIssue(input: CreateIssueInput): Promise<TrackerIssue> {
    const fields = (priority: boolean) => ({
      project: { id: input.teamId },
      issuetype: { name: 'Task' },
      summary: input.title,
      ...(input.description ? { description: markdownToJira(input.description) } : {}),
      ...(input.labelIds?.length ? { labels: input.labelIds } : {}),
      ...(priority && input.priority ? { priority: { name: PRIORITY_NAMES[input.priority] } } : {}),
    })
    // A project can hide the priority field or name its priorities differently, and the issue matters more than its priority.
    const created = await this.request('POST', '/rest/api/2/issue', { fields: fields(true) }).catch((error) => {
      if (!input.priority) throw error
      return this.request('POST', '/rest/api/2/issue', { fields: fields(false) })
    })
    if (input.stateId) await this.updateIssueState(String(created.id), input.stateId).catch(() => undefined)
    const issue = await this.getIssue(String(created.id))
    if (!issue) throw new Error(`Jira created ${created.key} but would not return it`)
    return issue
  }

  async updateIssue(issueId: string, change: UpdateIssueInput): Promise<TrackerIssue> {
    const { title, description, priority } = change
    await this.request('PUT', `/rest/api/2/issue/${encodeURIComponent(issueId)}`, {
      fields: {
        summary: title,
        description: description == null ? description : markdownToJira(description),
        priority: priority === undefined ? undefined : priority === 0 ? null : { name: PRIORITY_NAMES[priority] },
      },
    })
    const issue = await this.getIssue(issueId)
    if (!issue) throw new Error('Jira updated the issue but would not return it')
    return issue
  }

  /** Jira moves an issue along its workflow's transitions, so a status is only reachable when one leads there. */
  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    const path = `/rest/api/2/issue/${encodeURIComponent(issueId)}/transitions`
    const { transitions } = await this.request('GET', path)
    const transition = ((transitions as Loose[]) ?? []).find((candidate) => String(candidate.to?.id) === stateId)
    if (!transition) throw new Error('The workflow in Jira has no transition to that status from where the issue is now')
    await this.request('POST', path, { transition: { id: transition.id } })
  }

  async updateIssueLabels(issueId: string, change: { add?: string[]; remove?: string[] }): Promise<void> {
    const labels = [...(change.remove ?? []).map((remove) => ({ remove })), ...(change.add ?? []).map((add) => ({ add }))]
    if (labels.length > 0) await this.request('PUT', `/rest/api/2/issue/${encodeURIComponent(issueId)}`, { update: { labels } })
  }

  /** Nothing to call: a Jira label comes into being when an issue first carries it. Spaces are not allowed in one. */
  async createLabel(input: { teamId: string; name: string; parentId?: string; isGroup?: boolean }): Promise<TrackerLabel> {
    if (input.isGroup) return { id: AGENT_GROUP, name: AGENT_GROUP, parentId: null, isGroup: true }
    const name = input.name.trim().replace(/\s+/g, '-')
    return mapJiraLabel(input.parentId === AGENT_GROUP ? `${AGENT_PREFIX}${name}` : name)
  }

  async comment(issueId: string, body: string): Promise<{ id: string }> {
    const comment = await this.request('POST', `/rest/api/2/issue/${encodeURIComponent(issueId)}/comment`, { body: markdownToJira(body) })
    return { id: `${issueId}:${comment.id}` }
  }

  async updateComment(commentId: string, body: string): Promise<void> {
    const [issueId, id] = commentId.split(':')
    if (!issueId || !id) throw new Error('Unknown comment')
    await this.request('PUT', `/rest/api/2/issue/${encodeURIComponent(issueId)}/comment/${encodeURIComponent(id)}`, { body: markdownToJira(body) })
  }

  async registerWebhook(input: { teamId: string; url: string; secret: string }): Promise<{ id: string }> {
    const hook = await this.request('POST', '/rest/webhooks/1.0/webhook', {
      name: 'Factorix',
      url: input.url,
      secret: input.secret,
      events: JIRA_WEBHOOK_EVENTS,
      filters: { 'issue-related-events-section': `project = ${Number(input.teamId)}` },
      excludeBody: false,
    })
    return {
      id: String(hook.self ?? hook.name ?? 'webhook')
        .split('/')
        .pop() as string,
    }
  }

  async fetchMedia(url: string, options?: { range?: string }): Promise<TrackerMedia | null> {
    // The token goes only to the site it belongs to, whatever the link says.
    if (new URL(url).origin !== this.origin) return null
    const response = await this.send('GET', url, undefined, { accept: '*/*', ...(options?.range ? { range: options.range } : {}) }).catch(() => null)
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

export const JIRA_WEBHOOK_EVENTS = ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted', 'comment_created', 'comment_updated']
