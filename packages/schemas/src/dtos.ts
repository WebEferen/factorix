import type { AgentHelper, PermissionPolicy, RunEvent, RuntimeCapabilities, RuntimeId, RuntimeModel, UsageSnapshot } from '@factorix/runtime'
import type { ApiTokenScope, ConnectionKind, IssueSort } from './inputs'

export interface AccountDto {
  id: string
  kind: 'human' | 'agent'
  role: 'admin' | 'member'
  handle: string
  displayName: string
  email: string | null
  avatarUrl: string | null
  status: 'active' | 'disabled'
  createdAt: string
}

export interface ApiTokenDto {
  id: string
  name: string
  /** The start of the token, enough to tell two apart. The rest is shown once, when it is created. */
  prefix: string
  scopes: ApiTokenScope[]
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

export interface PluginFieldDto {
  key: string
  label: string
  type: 'text' | 'url' | 'secret'
  required?: boolean
  placeholder?: string
  hint?: string
}

export interface PluginDto {
  id: string
  name: string
  version: string
  description: string | null
  /** Shown to an installation admin only. */
  url: string | null
  provides: 'tracker'[]
  connectionFields: PluginFieldDto[]
  settingsFields: PluginFieldDto[]
  pages: { key: string; label: string; placement: 'sidebar' | 'settings' }[]
  /** What it may ask of Factorix, and whether this organization allowed each. Saving its settings allows them all. */
  permissions: { id: string; description: string; granted: boolean }[]
  /** Ships with this installation and registers itself, so it cannot be removed. */
  bundled: boolean
  /** Whether this organization has turned it on, and what it set. Secret settings are named, never returned. */
  enabled: boolean
  settings: Record<string, string>
  secretSettings: string[]
  /** Set for a package this organization uploaded, which Factorix runs for it. */
  package: PluginInstanceDto | null
}

export interface PluginInstanceDto {
  state: 'starting' | 'ready' | 'failed' | 'removing'
  error: string | null
  version: string
  sha256: string
  database: boolean
  egress: string[]
  /** The runner it runs on, or null for Factorix's own machine. */
  runner: { id: string; name: string } | null
  readyAt: string | null
}

/** What an uploaded package asks for, shown before anything from it runs. */
export interface PluginPackageDto {
  /** A plugin Factorix runs, or content it imports. */
  kind: 'plugin' | 'content'
  name: string
  version: string
  description: string | null
  publisher: string | null
  permissions: { id: string; description: string }[]
  egress: string[]
  database: boolean
  memoryMb: number
  files: number
  size: number
  sha256: string
  /** The version this organization runs now, when the upload would replace it. */
  replaces: string | null
  /** For content, what importing it would do to each item. */
  items: ContentPackPlanDto[]
}

export type ContentPackItemKind = 'skill' | 'archetype' | 'workflow'

/**
 * `update` rewrites an item nobody changed since the package wrote it, `keep` leaves one that someone changed or used,
 * `gone` does not bring back one that someone deleted, and `release` leaves one a newer version dropped as it is.
 * `conflict` means the organization already has another with that name, and nothing is imported.
 */
export interface ContentPackPlanDto {
  kind: ContentPackItemKind
  key: string
  name: string
  action: 'create' | 'update' | 'keep' | 'gone' | 'release' | 'conflict'
}

export interface ContentPackDto {
  id: string
  name: string
  version: string
  description: string | null
  publisher: string | null
  /** What it imported, as it is now. `id` is null once someone deleted it. */
  items: { kind: ContentPackItemKind; key: string; id: string | null; name: string | null }[]
  updatedAt: string
}

export interface RunnerDto {
  id: string
  name: string
  prefix: string
  online: boolean
  lastSeenAt: string | null
  projectCount: number
  createdAt: string
}

export interface OrgDto {
  id: string
  name: string
  slug: string
}

export interface ArchetypeDto {
  id: string
  name: string
  description: string
  role: 'engineer' | 'reviewer' | 'other'
  systemPrompt: string
  agents: { id: string; displayName: string }[]
  updatedAt: string
}

export interface AgentDto {
  id: string
  handle: string
  displayName: string
  status: 'active' | 'disabled'
  archetype: { id: string; name: string; role: 'engineer' | 'reviewer' | 'other' }
  description: string
  systemPrompt: string
  runtime: RuntimeId
  model: string | null
  reasoningEffort: string | null
  maxBudgetUsd: number | null
  maxTurns: number | null
  policy: PermissionPolicy
  helpers: AgentHelper[]
  capabilities: RuntimeCapabilities
  version: number
  skillIds: string[]
  connectionIds: string[]
  activeRunCount?: number
  updatedAt: string
}

export interface RuntimeDto {
  id: RuntimeId
  label: string
  capabilities: RuntimeCapabilities
  defaultModel: string | null
  models: RuntimeModel[]
}

export interface SkillDto {
  id: string
  slug: string
  name: string
  markdown: string
  updatedAt: string
}

export interface ConnectionDto {
  id: string
  kind: ConnectionKind
  name: string
  config: Record<string, unknown>
  hasSecret: boolean
  webhookUrl: string | null
  webhookSecret: string | null
  egressHosts: string[]
  /** Set when an agent can act through this connection as its own account. */
  accountRole: 'scm' | 'tracker' | null
  updatedAt: string
}

export interface ProjectRepoDto {
  id: string
  scmRepoId: string
  scmRepoPath: string
  scmCloneUrl: string
  defaultBranch: string
  name: string
  setupCommands: string[]
  checkCommands: string[]
}

export interface MergeRequestDto {
  repoPath: string
  iid: number
  url: string
  state: string
  /** Why the factory could not merge it on the last attempt. */
  error?: string
  revert?: { state: 'open' | 'merged' | 'failed'; url?: string; error?: string }
}

export interface ProjectDto {
  /** In merge order. */
  repos: ProjectRepoDto[]
  id: string
  /** Open tickets that arrived since this account last opened the project. */
  newIssueCount?: number
  name: string
  trackerConnectionId: string
  trackerTeamId: string
  trackerProjectId: string | null
  scmConnectionId: string
  autonomy: 'plan_first' | 'human_merge' | 'full_auto'
  stateMap: Record<string, string>
  trigger: { states: string[] }
  agentLabels: Record<string, string>
  syncState: 'idle' | 'syncing' | 'failed'
  syncError: string | null
  syncedIssueCount: number
  lastSyncedAt: string | null
  sandboxImage: string | null
  networkPolicy: 'restricted' | 'open' | 'none'
  networkAllowlist: string[]
  networkBypass: string[]
  /** 'summary' keeps a review to one note per merge request, with no threads on the diff. */
  reviewComments: 'inline' | 'summary'
  /** The runner its sandboxes start on, or null for the machine Factorix runs on. */
  runnerId: string | null
  runTimeoutMinutes: number
  monthlyBudgetUsd: number | null
  defaultEngineerAgentId: string | null
  defaultReviewerAgentId: string | null
  issueCount?: number
  activeIssueCount?: number
  spendThisMonthUsd?: number
  updatedAt: string
}

export type FactoryStateDto = 'untracked' | 'queued' | 'active' | 'waiting_human' | 'awaiting_merge' | 'done' | 'failed' | 'cancelled'

/** Where an issue sits in a list. An issue closed in the tracker that the factory never touched is not waiting for anyone. */
export type IssueGroupDto = FactoryStateDto | 'closed'

export const ISSUE_GROUP_ORDER: IssueGroupDto[] = [
  'waiting_human',
  'failed',
  'active',
  'queued',
  'awaiting_merge',
  'untracked',
  'done',
  'cancelled',
  'closed',
]

export interface IssueListDto {
  issues: IssueDto[]
  total: number
  counts: Partial<Record<IssueGroupDto, number>>
  page: number
  limit: number
}

export interface IssueFilterOptionDto {
  value: string
  label: string
  count: number
  meta?: string | null
}

export interface IssueFilterDto {
  key: string
  label: string
  kind: 'text' | 'multi'
  options: IssueFilterOptionDto[]
}

export interface IssueSortDto {
  key: IssueSort
  label: string
  asc: string
  desc: string
}

export interface IssueDto {
  id: string
  projectId: string
  projectName?: string
  trackerIssueId: string
  identifier: string
  title: string
  description: string | null
  priority: number
  trackerStateId: string | null
  trackerStateName: string | null
  trackerStateType: string | null
  labels: { id: string; name: string }[]
  assigneeName: string | null
  authorName: string | null
  trackerUrl: string | null
  factoryState: FactoryStateDto
  group: IssueGroupDto
  closed: boolean
  assignedAgentId: string | null
  assignedAgentHandle?: string | null
  pipelineStep: string | null
  waitingFor: string | null
  branchName: string | null
  mergeRequests: MergeRequestDto[]
  activeRunId: string | null
  updatedAt: string
  createdAt: string
}

export type RunStateDto = 'queued' | 'preparing' | 'running' | 'waiting_approval' | 'suspended' | 'finalizing' | 'succeeded' | 'failed' | 'cancelled'

export interface RunDto {
  id: string
  issueId: string | null
  issueIdentifier?: string | null
  issueTitle?: string | null
  projectId: string | null
  projectName?: string | null
  agentId: string
  agentHandle: string
  agentDisplayName?: string
  phase: string
  pipelineStep: string | null
  state: RunStateDto
  attempt: number
  runtime: RuntimeId
  model: string | null
  outcome: string | null
  result: string | null
  summary: string | null
  structuredOutput: unknown
  usage: Partial<UsageSnapshot>
  costUsd: number | null
  costEstimated: boolean
  hasDiff: boolean
  error: { code?: string; message: string } | null
  lastSeq: number
  adHocPrompt?: string | null
  adHocRef?: string | null
  /** The branch an ad-hoc run pushed its commits to, when it was asked to and changed something. */
  resultBranch?: string | null
  capabilities?: RuntimeCapabilities
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export interface ApprovalDto {
  id: string
  kind: 'plan' | 'tool' | 'question' | 'merge' | 'partial_merge' | 'revert_blocked'
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  payload: Record<string, unknown>
  runId: string | null
  issueId: string | null
  issueIdentifier?: string | null
  issueTitle?: string | null
  agentHandle?: string | null
  requestedAt: string
  expiresAt: string | null
  decidedByName?: string | null
  decidedAt: string | null
  decision: Record<string, unknown> | null
}

export interface DiscussionDto {
  id: string
  repoPath: string | null
  discussionId: string
  noteId: string
  author: string
  origin: 'factory' | 'human' | 'system'
  body: string
  path: string | null
  line: number | null
  resolved: boolean
  createdAt: string
}

export interface IssueDetailDto extends IssueDto {
  /** A built-in ticket, which is edited in Factorix. Any other tracker owns its own. */
  editable: boolean
  /** The description as written, for the editor of a built-in ticket. */
  descriptionSource: string | null
  runs: RunDto[]
  approvals: ApprovalDto[]
  discussions: DiscussionDto[]
  instructions: { id: string; author: string | null; body: string; createdAt: string; consumed: boolean }[]
  timeline: AuditEntryDto[]
  project: ProjectDto
  /** The branch its agents work on. It may not exist yet. */
  workBranch: string
}

export interface AuditEntryDto {
  id: string
  actorAccountId: string | null
  actorName: string | null
  actorKind: 'human' | 'agent' | 'system'
  action: string
  targetType: string
  targetId: string | null
  metadata: Record<string, unknown>
  ts: string
}

export interface InboxDto {
  approvals: ApprovalDto[]
  failedIssues: IssueDto[]
}

export interface SpendRowDto {
  key: string
  label: string
  runs: number
  costUsd: number
  estimatedCostUsd: number
  inputTokens: number
  outputTokens: number
}

export interface SpendDto {
  from: string
  to: string
  totalUsd: number
  byAgent: SpendRowDto[]
  byProject: SpendRowDto[]
}

export interface MembershipDto extends OrgDto {
  role: 'admin' | 'member'
}

export interface MeDto {
  account: AccountDto
  org: OrgDto
  /** Every organization this person can switch to, the current one included. */
  orgs: MembershipDto[]
  /** May create organizations and change the installation's settings. */
  installationAdmin: boolean
}

export interface OrgSummaryDto extends OrgDto {
  memberCount: number
  projectCount: number
  createdAt: string
}

export type RunStreamMessage =
  | { kind: 'event'; event: RunEvent }
  | { kind: 'state'; run: Pick<RunDto, 'id' | 'state' | 'outcome' | 'result' | 'costUsd' | 'usage' | 'error'> }

export type OrgStreamMessage = {
  kind: 'issue' | 'run' | 'approval' | 'project' | 'agent' | 'network' | 'settings'
  id: string
  projectId?: string | null
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown }
}
