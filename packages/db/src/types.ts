import type { Autonomy, FactoryState, PipelineCursor, PipelineDefinition, RunState, TrackerStateKey } from '@factorix/core'
import type { PermissionPolicy, RunOutcome, RuntimeCapabilities, RuntimeId, UsageSnapshot } from '@factorix/runtime'

export type ConnectionKind = 'linear' | 'gitlab' | 'anthropic' | 'openai' | 'mcp_stdio' | 'mcp_http' | 'generic' | 'slack' | 'doppler'

export interface OrganizationRow {
  id: string
  name: string
  slug: string
  networkMode: 'extend' | 'replace'
  networkAllowlist: string[]
  createdAt: Date
}

export interface AccountRow {
  id: string
  orgId: string
  kind: 'human' | 'agent'
  role: 'admin' | 'member'
  handle: string
  displayName: string
  email: string | null
  passwordHash: string | null
  avatarUrl: string | null
  status: 'active' | 'disabled'
  createdAt: Date
  updatedAt: Date
}

export interface AuthSessionRow {
  id: string
  orgId: string
  accountId: string
  tokenHash: string
  expiresAt: Date
  ip: string | null
  userAgent: string | null
  createdAt: Date
  lastSeenAt: Date
}

export interface ArchetypeRow {
  id: string
  orgId: string
  name: string
  description: string
  role: 'engineer' | 'reviewer' | 'other'
  systemPrompt: string
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface AgentRow {
  accountId: string
  orgId: string
  archetypeId: string
  description: string
  systemPrompt: string
  runtime: RuntimeId
  model: string | null
  reasoningEffort: string | null
  maxBudgetUsd: number | null
  maxTurns: number | null
  policy: PermissionPolicy
  capabilitiesSnapshot: RuntimeCapabilities
  version: number
  updatedAt: Date
}

export interface SkillRow {
  id: string
  orgId: string
  slug: string
  name: string
  markdown: string
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface AgentSkillRow {
  agentId: string
  skillId: string
  position: number
}

export interface ConnectionRow {
  id: string
  orgId: string
  kind: ConnectionKind
  name: string
  config: Record<string, unknown>
  secretCiphertext: Buffer | null
  secretNonce: Buffer | null
  keyVersion: number
  agentVisible: boolean
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface AgentConnectionRow {
  agentId: string
  connectionId: string
  role: 'mcp' | 'model' | 'tool'
}

export interface AuditLogRow {
  id: string
  orgId: string
  actorAccountId: string | null
  actorKind: 'human' | 'agent' | 'system'
  action: string
  targetType: string
  targetId: string | null
  metadata: Record<string, unknown>
  ts: Date
}

export interface PipelineRow {
  id: string
  orgId: string
  name: string
  version: number
  definition: PipelineDefinition
  isBuiltin: boolean
  createdAt: Date
}

export type StateMap = Partial<Record<TrackerStateKey, string>>

export interface ProjectRow {
  id: string
  orgId: string
  name: string
  trackerConnectionId: string
  trackerTeamId: string
  trackerProjectId: string | null
  scmConnectionId: string
  autonomy: Autonomy
  pipelineId: string
  stateMap: StateMap
  trigger: { states: string[] }
  agentLabelGroupId: string | null
  agentLabels: Record<string, string>
  sandboxImage: string | null
  syncState: 'idle' | 'syncing' | 'failed'
  syncError: string | null
  syncedIssueCount: number
  syncHeartbeatAt: Date | null
  lastSyncedAt: Date | null
  networkPolicy: 'restricted' | 'open' | 'none'
  networkAllowlist: string[]
  networkBypass: string[]
  limits: { memoryMb?: number; cpus?: number }
  runTimeoutMinutes: number
  monthlyBudgetUsd: number | null
  defaultEngineerAgentId: string | null
  defaultReviewerAgentId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface IssueLabel {
  id: string
  name: string
}

export interface IssueRow {
  workflowDepth: number
  id: string
  orgId: string
  projectId: string
  trackerIssueId: string
  identifier: string
  title: string
  description: string | null
  priority: number
  trackerStateId: string | null
  trackerStateName: string | null
  trackerStateType: string | null
  labels: IssueLabel[]
  assigneeTrackerId: string | null
  assigneeName: string | null
  authorTrackerId: string | null
  authorName: string | null
  trackerCreatedAt: Date | null
  trackerUpdatedAt: Date | null
  trackerUrl: string | null
  lastFactoryStateId: string | null
  syncedAt: Date
  factoryState: FactoryState
  assignedAgentId: string | null
  cursor: PipelineCursor | null
  branchName: string | null
  lockedByRunId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface WorkspaceRow {
  id: string
  orgId: string
  issueId: string | null
  volumeName: string
  mirrorVolumeName: string
  state: 'ready' | 'in_use' | 'expired'
  headSha: string | null
  branch: string | null
  repoDocs: { path: string; content: string }[]
  lastUsedAt: Date
  expiresAt: Date | null
  createdAt: Date
}

export interface AdHocSpec {
  gitUrl: string
  prompt: string
  ref?: string
}

export interface RunRow {
  id: string
  orgId: string
  issueId: string | null
  projectId: string | null
  agentId: string
  agentSnapshot: Record<string, unknown>
  phase: string
  pipelineStep: string | null
  state: RunState
  attempt: number
  parentRunId: string | null
  trigger: Record<string, unknown>
  adHoc: AdHocSpec | null
  createdBy: string | null
  runtime: RuntimeId
  model: string | null
  sessionRef: string | null
  workspaceId: string | null
  containerId: string | null
  leaseOwner: string | null
  leaseExpiresAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
  outcome: RunOutcome | null
  result: string | null
  summary: string | null
  structuredOutput: unknown
  usage: Partial<UsageSnapshot>
  costUsd: number | null
  costEstimated: boolean
  diff: string | null
  error: { code?: string; message: string } | null
  lastSeq: number
  lastRunnerSeq: number
  cancelRequestedAt: Date | null
  discardOnCancel: boolean
  createdAt: Date
  updatedAt: Date
}

export interface RunEventRow {
  runId: string
  seq: number
  type: string
  payload: Record<string, unknown>
  ts: Date
}

export interface RunCommandRow {
  id: string
  runId: string
  payload: Record<string, unknown>
  createdBy: string | null
  createdAt: Date
  deliveredAt: Date | null
}

export interface ApprovalRow {
  id: string
  orgId: string
  runId: string | null
  issueId: string | null
  runnerApprovalId: string | null
  kind: 'plan' | 'tool' | 'question' | 'merge' | 'partial_merge' | 'revert_blocked'
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  payload: Record<string, unknown>
  requestedAt: Date
  expiresAt: Date | null
  decidedBy: string | null
  decidedAt: Date | null
  decision: Record<string, unknown> | null
  externalRef: Record<string, unknown> | null
}

export interface WebhookDeliveryRow {
  id: string
  connectionId: string
  source: 'linear' | 'gitlab'
  deliveryId: string
  eventType: string | null
  payload: unknown
  receivedAt: Date
  processedAt: Date | null
  status: 'pending' | 'processed' | 'ignored' | 'failed'
  error: string | null
}

export interface WorkflowGraphRow {
  nodes: { id: string; type: string; position: { x: number; y: number }; config: Record<string, unknown> }[]
  edges: { id: string; source: string; sourceHandle: string; target: string }[]
}

export interface WorkflowRow {
  id: string
  orgId: string
  projectId: string | null
  name: string
  description: string
  definition: WorkflowGraphRow
  publishedDefinition: WorkflowGraphRow | null
  publishedVersion: number
  publishedAt: Date | null
  enabled: boolean
  createdBy: string | null
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface WorkflowRunRow {
  id: string
  orgId: string
  workflowId: string
  workflowVersion: number
  issueId: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  definition: WorkflowGraphRow
  trigger: { nodeId: string; event: { kind: string } & Record<string, unknown> }
  triggerEventId: string | null
  startedBy: string | null
  error: string | null
  createdAt: Date
  finishedAt: Date | null
}

export interface WorkflowStepRow {
  runId: string
  nodeId: string
  block: string
  status: 'pending' | 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
  handle: string | null
  output: Record<string, unknown> | null
  error: string | null
  attempts: number
  wakeAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
  updatedAt: Date
}

export interface RuntimeModelRow {
  runtime: string
  defaultModel: string | null
  models: { id: string; label: string; description: string | null; efforts: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[] }[]
  fetchedAt: Date
}

export interface ProjectEnvironmentRow {
  projectId: string
  orgId: string
  source: string
  /** Parsed and validated when saved, so readers can trust its shape. */
  definition: Record<string, unknown> | null
  secretSets: {
    name: string
    connectionId: string
    project: string | null
    config: string | null
    only: string[]
    except: string[]
    agents: boolean
  }[]
  version: number
  updatedBy: string | null
  createdAt: Date
  updatedAt: Date
}

export type EnvironmentInstanceState = 'starting' | 'ready' | 'refreshing' | 'stopping' | 'stopped' | 'failed'

export interface EnvironmentServiceStatus {
  state: 'waiting' | 'starting' | 'ready' | 'failed' | 'stopped'
  containerId?: string
  message?: string
}

export interface EnvironmentInstanceRow {
  id: string
  orgId: string
  projectId: string
  issueId: string | null
  runId: string | null
  kind: 'preview' | 'run'
  slug: string
  state: EnvironmentInstanceState
  definition: Record<string, unknown> | null
  definitionVersion: number | null
  secretSets: ProjectEnvironmentRow['secretSets']
  commits: Record<string, { ref: string; sha: string }>
  services: Record<string, EnvironmentServiceStatus>
  source: 'branch' | 'worktree'
  dataGeneration: number
  error: string | null
  startedBy: string | null
  startedAt: Date | null
  readyAt: Date | null
  lastSeenAt: Date | null
  expiresAt: Date | null
  stoppedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface ProjectRepoRow {
  id: string
  orgId: string
  projectId: string
  scmRepoId: string
  scmRepoPath: string
  scmCloneUrl: string
  defaultBranch: string
  name: string
  setupCommands: string[]
  checkCommands: string[]
  position: number
  createdAt: Date
  updatedAt: Date
}

export interface IssueMergeRequestRow {
  id: string
  orgId: string
  issueId: string
  repoId: string | null
  repoPath: string
  mrId: string
  mrIid: number
  mrUrl: string
  mrState: string
  mergePosition: number | null
  createdAt: Date
  updatedAt: Date
  mergeError: string | null
  revertMrIid: number | null
  revertMrUrl: string | null
  revertState: 'open' | 'merged' | 'failed' | null
  revertError: string | null
}

export interface MrDiscussionRow {
  id: string
  orgId: string
  issueId: string
  repoId: string | null
  mrIid: number
  discussionId: string
  noteId: string
  authorLogin: string
  origin: 'factory' | 'human' | 'system'
  runId: string | null
  body: string
  path: string | null
  line: number | null
  resolved: boolean
  createdAt: Date
}

export interface IssueInstructionRow {
  id: string
  orgId: string
  issueId: string
  source: string
  externalId: string | null
  author: string | null
  body: string
  consumedByRunId: string | null
  createdAt: Date
}

export interface DomainEventRow {
  id: string
  orgId: string
  type: string
  payload: Record<string, unknown>
  ts: Date
  processedAt: Date | null
}
