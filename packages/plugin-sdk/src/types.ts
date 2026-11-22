export const PROTOCOL = 1

/**
 * What a plugin may ask of Factorix beyond its own connections and settings. An organization's admin sees them when
 * turning the plugin on, and Factorix answers only what that admin allowed.
 *
 * - `activity:read`: what happened on tickets, through `factorix().activity`.
 * - `agents:run`: the organization's agents, and runs of them with no ticket and no repository, through `agents`, `startRun`, and `getRun`.
 * - `members:read`: the people and agents of the organization, through `members`.
 * - `tickets:write`: the organization's projects, and tickets the plugin creates in them, through `projects`, `createTicket`, and `getTicket`.
 */
export type Permission = 'activity:read' | 'agents:run' | 'members:read' | 'tickets:write'

export interface Field {
  key: string
  label: string
  /** A secret field is stored encrypted by Factorix and reaches the plugin under `secrets`. */
  type: 'text' | 'url' | 'secret'
  required?: boolean
  placeholder?: string
  hint?: string
}

export interface Manifest {
  protocol: number
  name: string
  version: string
  description?: string
  provides: 'tracker'[]
  permissions: Permission[]
  connection: { fields: Field[] }
  settings: { fields: Field[] }
  pages: { key: string; label: string; path: string; placement: 'sidebar' | 'settings' }[]
}

/** One account of the service behind the plugin, as an admin connected it in Factorix. */
export interface Connection {
  id: string
  config: Record<string, string>
  secrets: Record<string, string>
}

/** Who opened a page, as Factorix signed it. */
export interface PageContext {
  exp: number
  page: string
  /** Your plugin's id in that Factorix, which `factorix({ pluginId })` needs. */
  plugin: { id: string }
  org: { id: string; name: string }
  account: { id: string; name: string; role: string }
  /** What the organization set for the plugin, without the secret fields. */
  settings: Record<string, string>
}

export type StateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'

export interface Team {
  id: string
  /** The prefix of issue identifiers, as in ABC-12. */
  key: string
  name: string
}

export interface Project {
  id: string
  name: string
  url: string | null
}

export interface State {
  id: string
  name: string
  type: StateType
  position: number
}

export interface Label {
  id: string
  name: string
  /** Factorix assigns agents through labels in a group named Agent. A tracker with flat labels can fake the group. */
  parentId: string | null
  isGroup?: boolean
}

export interface Issue {
  id: string
  identifier: string
  title: string
  /** Markdown. */
  description: string | null
  url: string | null
  /** 0 for none, then 1 (most urgent) to 4. */
  priority: number
  teamId: string
  projectId: string | null
  stateId: string
  stateName: string
  stateType: StateType
  assigneeId: string | null
  assigneeName: string | null
  creatorId: string | null
  creatorName: string | null
  labels: Label[]
  createdAt: string | null
  updatedAt: string
  archivedAt: string | null
}

export interface Comment {
  id: string
  issueId: string
  /** Markdown. */
  body: string
  authorId: string | null
  authorName: string | null
  createdAt: string
}

export interface Resource {
  kind: 'document' | 'link'
  title: string
  url: string
  subtitle: string | null
  content: string | null
}

export interface Page<T> {
  nodes: T[]
  nextCursor: string | null
}

export interface IssueQuery {
  teamId: string
  projectId?: string | null
  /** Only issues that changed after this moment. */
  updatedAfter?: string
  /** Leaves out issues that closed before this moment. Open issues always come back. */
  closedSince?: string
  cursor?: string | null
  limit?: number
}

export interface NewIssue {
  teamId: string
  projectId?: string | null
  title: string
  description?: string
  priority?: number
  stateId?: string
  labelIds?: string[]
  creatorName?: string
}

/** What Factorix asks of a tracker. Ids are yours and opaque to Factorix. */
export interface Tracker {
  viewer(): Promise<{ id: string; name: string; email: string | null }>
  listTeams(): Promise<Team[]>
  listWorkflowStates(teamId: string): Promise<State[]>
  listLabels(teamId: string): Promise<Label[]>
  /** Ordered by when issues last changed, oldest first, so a sync can stop and pick up again. */
  listIssues(query: IssueQuery): Promise<Page<Issue>>
  getIssue(id: string): Promise<Issue | null>
  listComments(issueId: string): Promise<Comment[]>
  createIssue(input: NewIssue): Promise<Issue>
  updateIssueState(issueId: string, stateId: string): Promise<void>
  updateIssueLabels(issueId: string, change: { add?: string[]; remove?: string[] }): Promise<void>
  createLabel(input: { teamId: string; name: string; parentId?: string; isGroup?: boolean }): Promise<Label>
  comment(issueId: string, body: string): Promise<{ id: string }>
  updateComment?(commentId: string, body: string): Promise<void>
  listProjects?(teamId: string): Promise<Project[]>
  listResources?(issueId: string): Promise<Resource[]>
  /**
   * Called when a project starts following a team. `url` is where your events go. Set up whatever tells you about
   * changes, and send them with `factorix().sendEvent`. Without this, Factorix polls every few minutes.
   */
  registerWebhook?(input: { teamId: string; url: string }): Promise<{ id: string }>
}

export type TrackerEvent =
  /** Only the id needs to be right. Factorix reads the issue back through `getIssue`. */
  | { kind: 'issue.upserted'; issue: { id: string }; previousStateId?: string }
  | { kind: 'issue.removed'; issueId: string }
  | { kind: 'comment.upserted'; comment: Comment; action: 'create' | 'update' }

/** One ticket in a read of activity. Titles and names come from trackers and people, so treat them as data. */
export interface ActivityIssue {
  id: string
  identifier: string
  title: string
  url: string | null
  project: string
  /** 0 for none, then 1 (most urgent) to 4. */
  priority: number
  status: string | null
  statusType: string | null
  /** Where Factorix's own pipeline is with it, `untracked` while no agent has it. */
  factoryState: string
  /** The person it is assigned to in the tracker. */
  assignee: { id: string | null; name: string } | null
  /** The agent it is assigned to in Factorix. */
  agent: { id: string; handle: string; name: string } | null
  updatedAt: string
}

/** What happened in an organization since a moment. Needs `activity:read`. */
export interface Activity {
  /** Tickets with an assignee or an agent that changed since then or are still open, most recently changed first. */
  issues: ActivityIssue[]
  /** Merge requests of those tickets merged since then. */
  merges: { issueId: string; url: string; mergedAt: string }[]
  /** What agents reported when their runs on those tickets succeeded since then. */
  reports: { issueId: string; agent: string; phase: string; summary: string; finishedAt: string }[]
  /** True when more tickets matched than one answer holds. */
  truncated: boolean
}

export interface Agent {
  id: string
  handle: string
  name: string
  /** `active`, or `disabled` for one that cannot run. */
  status: string
  runtime: string
  model: string | null
}

export interface RunRequest {
  agentId: string
  /** Everything the agent gets. Mark the data in it as data, since the agent follows what the prompt asks. */
  prompt: string
  /**
   * The JSON Schema of the answer, an object. Claude and Codex both have to be able to fill it, so give every object
   * `additionalProperties: false` and list every property under `required`. Without one the answer is `{ answer: string }`.
   */
  outputSchema?: Record<string, unknown>
}

/** A run your plugin started. Needs `agents:run`. */
export interface Run {
  id: string
  /** `queued` and `running` on the way, then `succeeded`, `failed`, or `cancelled`. */
  state: string
  /** True once the run succeeded, failed, or was cancelled. */
  finished: boolean
  agentId: string
  /** The agent's answer in the shape the plugin asked for, once the run succeeded. */
  output: unknown
  error: string | null
  /** The run's page in Factorix. */
  url: string
  createdAt: string
  finishedAt: string | null
}

/** A person or an agent of the organization. Needs `members:read`. */
export interface Member {
  id: string
  kind: 'person' | 'agent'
  name: string
  handle: string
  /** `admin` or `member`. */
  role: string
  /** `active`, or `disabled` for one that cannot sign in or run. */
  status: string
}

/** A project a ticket can be created in. Needs `tickets:write`. */
export interface TicketProject {
  id: string
  name: string
}

export interface TicketRequest {
  projectId: string
  title: string
  /** Markdown. */
  description?: string
  /** 0 for none, then 1 (most urgent) to 4. */
  priority?: number
  /** Hands the new ticket to this agent, as assigning it in Factorix does. */
  agentId?: string
}

/** A ticket your plugin created. Needs `tickets:write`. */
export interface Ticket {
  id: string
  identifier: string
  title: string
  /** The ticket in its tracker. */
  url: string | null
  status: string | null
  statusType: string | null
  /** True once its status is completed or canceled. */
  closed: boolean
}
