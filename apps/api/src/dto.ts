import { egressHostsOf } from '@factorix/connectors'
import type { RunState } from '@factorix/core'
import { TERMINAL_RUN_STATES } from '@factorix/core'
import type {
  AccountRow,
  ApprovalRow,
  ArchetypeRow,
  ConnectionRow,
  Db,
  IssueRow,
  OrganizationRow,
  ProjectRepoRow,
  ProjectRow,
  RunRow,
  SkillRow,
  WorkflowRunRow,
  WorkflowStepRow,
} from '@factorix/db'
import type {
  AccountDto,
  ApprovalDto,
  ArchetypeDto,
  AuditEntryDto,
  ConnectionDto,
  IssueDto,
  MergeRequestDto,
  NetworkSettings,
  ProjectDto,
  ProjectRepoDto,
  RunDto,
  SkillDto,
  WorkflowDefinition,
  WorkflowDto,
  WorkflowRunDetailDto,
  WorkflowRunDto,
} from '@factorix/schemas'
import { isTriggerBlock } from '@factorix/schemas'

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null)

export function accountDto(row: AccountRow): AccountDto {
  return {
    id: row.id,
    kind: row.kind,
    role: row.role,
    handle: row.handle,
    displayName: row.displayName,
    email: row.email,
    avatarUrl: row.avatarUrl,
    status: row.status,
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

export function archetypeDto(row: ArchetypeRow, agents: ArchetypeDto['agents']): ArchetypeDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    role: row.role,
    systemPrompt: row.systemPrompt,
    agents,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function skillDto(row: SkillRow): SkillDto {
  return { id: row.id, slug: row.slug, name: row.name, markdown: row.markdown, updatedAt: new Date(row.updatedAt).toISOString() }
}

export function networkSettingsDto(row: OrganizationRow): NetworkSettings {
  return { mode: row.networkMode, hosts: row.networkAllowlist }
}

export function connectionDto(row: ConnectionRow, publicUrl: string, admin: boolean): ConnectionDto {
  const { webhookSecret, ...config } = row.config as { webhookSecret?: string }
  const hasWebhook = row.kind === 'linear' || row.kind === 'gitlab'
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    config,
    hasSecret: row.secretCiphertext !== null,
    agentVisible: row.agentVisible,
    webhookUrl: hasWebhook ? `${publicUrl.replace(/\/$/, '')}/webhooks/${row.kind}/${row.id}` : null,
    webhookSecret: hasWebhook && admin ? (webhookSecret ?? null) : null,
    egressHosts: egressHostsOf(row.kind, config),
    updatedAt: new Date(row.updatedAt).toISOString(),
  }
}

export function projectRepoDto(repo: ProjectRepoRow): ProjectRepoDto {
  return {
    id: repo.id,
    scmRepoId: repo.scmRepoId,
    scmRepoPath: repo.scmRepoPath,
    scmCloneUrl: repo.scmCloneUrl,
    defaultBranch: repo.defaultBranch,
    name: repo.name,
    setupCommands: repo.setupCommands,
    checkCommands: repo.checkCommands,
  }
}

export function projectDto(row: ProjectRow, repos: ProjectRepoRow[], extra: Partial<ProjectDto> = {}): ProjectDto {
  return {
    repos: repos.map(projectRepoDto),
    id: row.id,
    name: row.name,
    trackerConnectionId: row.trackerConnectionId,
    trackerTeamId: row.trackerTeamId,
    trackerProjectId: row.trackerProjectId,
    scmConnectionId: row.scmConnectionId,
    autonomy: row.autonomy,
    stateMap: row.stateMap as Record<string, string>,
    trigger: row.trigger,
    agentLabels: row.agentLabels,
    syncState: row.syncState,
    syncError: row.syncError,
    syncedIssueCount: row.syncedIssueCount,
    lastSyncedAt: row.lastSyncedAt ? new Date(row.lastSyncedAt).toISOString() : null,
    sandboxImage: row.sandboxImage,
    networkPolicy: row.networkPolicy,
    networkAllowlist: row.networkAllowlist,
    runTimeoutMinutes: row.runTimeoutMinutes,
    monthlyBudgetUsd: row.monthlyBudgetUsd,
    defaultEngineerAgentId: row.defaultEngineerAgentId,
    defaultReviewerAgentId: row.defaultReviewerAgentId,
    updatedAt: new Date(row.updatedAt).toISOString(),
    ...extra,
  }
}

/** In merge order. Select it wherever a row reaches issueDto, or the merge requests come back empty. */
export const MERGE_REQUESTS_SQL = `COALESCE((
  SELECT json_agg(json_build_object('repoPath', mr.repo_path, 'iid', mr.mr_iid, 'url', mr.mr_url, 'state', mr.mr_state) ORDER BY mr.merge_position NULLS LAST, mr_repo.position NULLS LAST, mr.created_at)
  FROM issue_merge_requests mr LEFT JOIN project_repos mr_repo ON mr_repo.id = mr.repo_id
  WHERE mr.issue_id = issues.id
), '[]'::json) AS merge_requests`

export const CLOSED_STATE_TYPES = ['completed', 'canceled']
export const CLOSED_SQL = `COALESCE(issues.tracker_state_type, '') IN ('completed', 'canceled')`

export function isTrackerClosed(row: Pick<IssueRow, 'trackerStateType'>): boolean {
  return CLOSED_STATE_TYPES.includes(row.trackerStateType ?? '')
}

export function issueDto(row: IssueRow & { mergeRequests?: MergeRequestDto[]; projectName?: string; assignedAgentHandle?: string | null }): IssueDto {
  return {
    id: row.id,
    projectId: row.projectId,
    projectName: row.projectName,
    trackerIssueId: row.trackerIssueId,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
    priority: row.priority,
    trackerStateId: row.trackerStateId,
    trackerStateName: row.trackerStateName,
    trackerStateType: row.trackerStateType,
    labels: row.labels,
    assigneeName: row.assigneeName,
    authorName: row.authorName,
    trackerUrl: row.trackerUrl,
    factoryState: row.factoryState,
    group: row.factoryState === 'untracked' && isTrackerClosed(row) ? 'closed' : row.factoryState,
    closed: isTrackerClosed(row),
    assignedAgentId: row.assignedAgentId,
    assignedAgentHandle: row.assignedAgentHandle,
    pipelineStep: row.cursor?.step ?? null,
    waitingFor: row.cursor?.waitingFor ?? null,
    branchName: row.branchName,
    mergeRequests: row.mergeRequests ?? [],
    activeRunId: row.lockedByRunId,
    updatedAt: new Date(row.updatedAt).toISOString(),
    createdAt: new Date(row.trackerCreatedAt ?? row.createdAt).toISOString(),
  }
}

export function runDto(row: RunRow & { issueIdentifier?: string | null; issueTitle?: string | null; projectName?: string | null }): RunDto {
  const snapshot = row.agentSnapshot as { handle?: string; displayName?: string }
  return {
    id: row.id,
    issueId: row.issueId,
    issueIdentifier: row.issueIdentifier,
    issueTitle: row.issueTitle,
    projectId: row.projectId,
    projectName: row.projectName,
    agentId: row.agentId,
    agentHandle: snapshot.handle ?? 'agent',
    agentDisplayName: snapshot.displayName,
    phase: row.phase,
    pipelineStep: row.pipelineStep,
    state: row.state,
    attempt: row.attempt,
    runtime: row.runtime,
    model: row.model,
    outcome: row.outcome,
    result: row.result,
    summary: row.summary,
    structuredOutput: row.structuredOutput,
    usage: row.usage,
    costUsd: row.costUsd,
    costEstimated: row.costEstimated,
    hasDiff: Boolean(row.diff),
    error: row.error,
    lastSeq: row.lastSeq,
    adHocPrompt: row.adHoc?.prompt ?? null,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

export function approvalDto(
  row: ApprovalRow & { issueIdentifier?: string | null; issueTitle?: string | null; agentHandle?: string | null; decidedByName?: string | null },
): ApprovalDto {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    payload: row.payload as Record<string, unknown>,
    runId: row.runId,
    issueId: row.issueId,
    issueIdentifier: row.issueIdentifier,
    issueTitle: row.issueTitle,
    agentHandle: row.agentHandle,
    requestedAt: new Date(row.requestedAt).toISOString(),
    expiresAt: iso(row.expiresAt),
    decidedByName: row.decidedByName,
    decidedAt: iso(row.decidedAt),
    decision: row.decision as Record<string, unknown> | null,
  }
}

// biome-ignore lint/suspicious/noExplicitAny: a joined row with extra columns
export function auditDto(row: Record<string, any>): AuditEntryDto {
  return {
    id: String(row.id),
    actorAccountId: row.actorAccountId,
    actorName: row.actorName ?? null,
    actorKind: row.actorKind,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: row.metadata,
    ts: new Date(row.ts).toISOString(),
  }
}

export const RUN_LIST_COLUMNS = (db: Db) => [
  'runs.id',
  'runs.org_id',
  'runs.issue_id',
  'runs.project_id',
  'runs.agent_id',
  'runs.agent_snapshot',
  'runs.phase',
  'runs.pipeline_step',
  'runs.state',
  'runs.attempt',
  'runs.ad_hoc',
  'runs.runtime',
  'runs.model',
  'runs.outcome',
  'runs.result',
  'runs.summary',
  'runs.structured_output',
  'runs.usage',
  'runs.cost_usd',
  'runs.cost_estimated',
  'runs.error',
  'runs.last_seq',
  'runs.started_at',
  'runs.finished_at',
  'runs.created_at',
  db.raw('(runs.diff IS NOT NULL) AS diff'),
  'issues.identifier as issue_identifier',
  'issues.title as issue_title',
  'projects.name as project_name',
]

export function isTerminalRun(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state)
}

// biome-ignore lint/suspicious/noExplicitAny: joined and computed columns come from the route's select
export function workflowDto(row: any): WorkflowDto {
  const graph: WorkflowDefinition = row.publishedDefinition ?? row.definition
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    projectId: row.projectId,
    projectName: row.projectName ?? null,
    enabled: row.enabled,
    definition: row.definition,
    publishedVersion: row.publishedVersion,
    publishedAt: iso(row.publishedAt),
    hasUnpublishedChanges: Boolean(row.hasUnpublishedChanges),
    triggers: graph.nodes.filter((node) => isTriggerBlock(node.type)).map((node) => node.type),
    runCount: Number(row.runCount ?? 0),
    lastRunAt: iso(row.lastRunAt),
    lastRunStatus: row.lastRunStatus ?? null,
    createdAt: iso(row.createdAt) as string,
    updatedAt: iso(row.updatedAt) as string,
  }
}

// biome-ignore lint/suspicious/noExplicitAny: joined columns come from the route's select
export function workflowRunDto(row: any): WorkflowRunDto {
  return {
    id: row.id,
    workflowId: row.workflowId,
    workflowName: row.workflowName,
    workflowVersion: row.workflowVersion,
    issueId: row.issueId,
    issueIdentifier: row.issueIdentifier,
    issueTitle: row.issueTitle,
    status: row.status,
    trigger: row.trigger,
    startedByName: row.startedByName ?? null,
    error: row.error,
    createdAt: iso(row.createdAt) as string,
    finishedAt: iso(row.finishedAt),
  }
}

export function workflowRunDetailDto(row: WorkflowRunRow & Record<string, unknown>, steps: WorkflowStepRow[]): WorkflowRunDetailDto {
  return {
    ...workflowRunDto(row),
    definition: row.definition as WorkflowDefinition,
    steps: steps.map((step) => ({
      nodeId: step.nodeId,
      block: step.block,
      status: step.status,
      handle: step.handle,
      output: step.output,
      error: step.error,
      wakeAt: iso(step.wakeAt),
      startedAt: iso(step.startedAt),
      finishedAt: iso(step.finishedAt),
    })),
  }
}
