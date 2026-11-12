export type TrackerStateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'

export interface TrackerTeam {
  id: string
  key: string
  name: string
}

export interface TrackerProject {
  id: string
  name: string
  url: string | null
}

export interface TrackerState {
  id: string
  name: string
  type: TrackerStateType
  position: number
}

export interface TrackerLabel {
  id: string
  name: string
  parentId: string | null
  isGroup?: boolean
}

export interface TrackerIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  url: string | null
  priority: number
  teamId: string
  projectId: string | null
  stateId: string
  stateName: string
  stateType: TrackerStateType
  assigneeId: string | null
  assigneeName: string | null
  creatorId: string | null
  creatorName: string | null
  labels: TrackerLabel[]
  createdAt: string | null
  updatedAt: string
  archivedAt: string | null
}

export interface TrackerComment {
  id: string
  issueId: string
  body: string
  authorId: string | null
  authorName: string | null
  createdAt: string
}

/** Something people attached to an issue: a tracker document with its text, a link to another tool, or an uploaded file. */
export interface TrackerResource {
  kind: 'document' | 'link' | 'file'
  title: string
  /** For a file, where `fetchMedia` reads its bytes with this connection's credentials. */
  url: string
  subtitle: string | null
  /** A document's text in the source's dialect. Links and files have none. */
  content: string | null
  /** A file's type and size, when the source knows them before reading it. */
  mimeType?: string | null
  size?: number | null
}

export interface Page<T> {
  nodes: T[]
  nextCursor: string | null
}

export type TrackerWebhookEvent =
  | { kind: 'issue.upserted'; issue: TrackerIssue; previousStateId?: string; previousLabelIds?: string[] }
  | { kind: 'issue.removed'; issueId: string }
  | { kind: 'comment.upserted'; comment: TrackerComment; action: 'create' | 'update' }
  | { kind: 'ignored'; reason: string }

export interface CreateIssueInput {
  teamId: string
  projectId?: string | null
  title: string
  description?: string
  priority?: number
  stateId?: string
  labelIds?: string[]
}

export type Headers = Record<string, string | string[] | undefined>

export interface TrackerMedia {
  status: number
  contentType: string | null
  contentLength: string | null
  contentRange: string | null
  body: ReadableStream<Uint8Array>
}

export interface TrackerConnector {
  readonly kind: 'linear'
  viewer(): Promise<{ id: string; name: string; email: string | null }>
  listTeams(): Promise<TrackerTeam[]>
  listProjects(teamId: string): Promise<TrackerProject[]>
  listWorkflowStates(teamId: string): Promise<TrackerState[]>
  listLabels(teamId: string): Promise<TrackerLabel[]>
  listIssues(query: {
    teamId: string
    projectId?: string | null
    updatedAfter?: string
    /** Leaves out issues that closed before this date. Open issues always come back. */
    closedSince?: string
    cursor?: string | null
    limit?: number
  }): Promise<Page<TrackerIssue>>
  getIssue(id: string): Promise<TrackerIssue | null>
  listComments(issueId: string): Promise<TrackerComment[]>
  listResources(issueId: string): Promise<TrackerResource[]>
  createIssue(input: CreateIssueInput): Promise<TrackerIssue>
  updateIssueState(issueId: string, stateId: string): Promise<void>
  updateIssueLabels(issueId: string, change: { add?: string[]; remove?: string[] }): Promise<void>
  createLabel(input: { teamId: string; name: string; parentId?: string; isGroup?: boolean; color?: string }): Promise<TrackerLabel>
  comment(issueId: string, body: string): Promise<{ id: string }>
  updateComment(commentId: string, body: string): Promise<void>
  registerWebhook(input: { teamId: string; url: string; secret: string }): Promise<{ id: string }>
  /** Reads an upload or a file resource with this connection's credentials. Callers check an upload's host through the source's markup first. */
  fetchMedia(url: string, options?: { range?: string }): Promise<TrackerMedia | null>
}

export interface TrackerWebhookCodec {
  deliveryId(headers: Headers, rawBody: Buffer): string
  /** Rejects bad signatures and stale timestamps. */
  verify(rawBody: Buffer, headers: Headers, secret: string): boolean
  parse(payload: unknown): TrackerWebhookEvent
}
