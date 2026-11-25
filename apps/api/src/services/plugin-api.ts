import type {
  PluginActivity,
  PluginActivityIssue,
  PluginAgent,
  PluginMember,
  PluginRun,
  PluginTicket,
  PluginTicketProject,
} from '@factorix/connectors'
import {
  type AccountRow,
  type AgentRow,
  type Db,
  type IssueMergeRequestRow,
  type IssueRow,
  json,
  type PluginRow,
  type PluginTicketRow,
  type ProjectRow,
  type RunRow,
} from '@factorix/db'
import type { PluginRunInput, PluginTicketInput } from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { isTrackerClosed } from '../dto'
import { writeAudit } from '../lib/audit'
import { badRequest, conflict, notFound } from '../lib/errors'
import { emit } from '../lib/outbox'
import { buildAgentSnapshot } from './agents'
import { assignIssue } from './assign'
import { getConnection, trackerFor } from './connections'
import { recordEcho } from './echo'
import { readSettings } from './settings'
import { upsertIssueMirror } from './tracker-sync'

const DAY_MS = 86_400_000
export const MAX_ACTIVITY_DAYS = 31
const MAX_ISSUES = 2000
const MAX_REPORT_CHARS = 1000
const MAX_SCHEMA_CHARS = 20_000
const MAX_UNFINISHED_RUNS = 3
const FINISHED = ['succeeded', 'failed', 'cancelled']
const REPORTED_PHASES = ['plan', 'implement', 'address_review', 'resolve_conflicts', 'review', 'task', 'prompt']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Tickets with a person or an agent on them that changed since `since` or are still open, with the merges and agent
 * reports of the same period. The plugin decides what to make of them.
 */
export async function pluginActivity(db: Db, orgId: string, since: Date, now = new Date()): Promise<PluginActivity> {
  if (since.getTime() < now.getTime() - MAX_ACTIVITY_DAYS * DAY_MS) throw badRequest(`since reaches back at most ${MAX_ACTIVITY_DAYS} days`)
  const rows = (await db('issues')
    .join('projects', 'issues.project_id', 'projects.id')
    .where({ 'issues.org_id': orgId })
    .where((builder) => builder.whereNotNull('issues.assignee_name').orWhereNotNull('issues.assigned_agent_id'))
    .where((builder) =>
      builder
        .whereRaw('COALESCE(issues.tracker_updated_at, issues.updated_at) >= ?', [since])
        .orWhereRaw(`COALESCE(issues.tracker_state_type, '') NOT IN ('completed', 'canceled') AND issues.factory_state NOT IN ('done', 'cancelled')`),
    )
    .select('issues.*', 'projects.name as project_name')
    .orderByRaw('COALESCE(issues.tracker_updated_at, issues.updated_at) DESC')
    .limit(MAX_ISSUES + 1)) as (IssueRow & { projectName: string })[]
  const issues = rows.slice(0, MAX_ISSUES)
  const agents = (await db('accounts').where({ orgId, kind: 'agent' }).select('id', 'handle', 'displayName')) as Pick<
    AccountRow,
    'id' | 'handle' | 'displayName'
  >[]
  const agentOf = new Map(agents.map((agent) => [agent.id, agent]))
  const ids = issues.map((issue) => issue.id)
  const merged =
    ids.length === 0
      ? []
      : await db<IssueMergeRequestRow>('issue_merge_requests')
          .where({ orgId, mrState: 'merged' })
          .whereIn('issueId', ids)
          .where('updatedAt', '>=', since)
          .orderBy('updatedAt', 'desc')
  const reports =
    ids.length === 0
      ? []
      : await db<RunRow>('runs')
          .where({ orgId, state: 'succeeded' })
          .whereIn('issueId', ids)
          .whereIn('phase', REPORTED_PHASES)
          .whereNotNull('summary')
          .where('finishedAt', '>=', since)
          .orderBy('finishedAt', 'desc')
          .select('issueId', 'agentId', 'phase', 'summary', 'finishedAt')
  return {
    issues: issues.map((issue): PluginActivityIssue => {
      const agent = issue.assignedAgentId ? agentOf.get(issue.assignedAgentId) : undefined
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.trackerUrl,
        project: issue.projectName,
        priority: issue.priority,
        status: issue.trackerStateName,
        statusType: issue.trackerStateType,
        factoryState: issue.factoryState,
        assignee: issue.assigneeName ? { id: issue.assigneeTrackerId, name: issue.assigneeName } : null,
        agent: agent ? { id: agent.id, handle: agent.handle, name: agent.displayName } : null,
        updatedAt: (issue.trackerUpdatedAt ?? issue.updatedAt).toISOString(),
      }
    }),
    merges: merged.map((mr) => ({ issueId: mr.issueId, url: mr.mrUrl, mergedAt: mr.updatedAt.toISOString() })),
    reports: reports.map((run) => ({
      issueId: run.issueId as string,
      agent: agentOf.get(run.agentId)?.handle ?? 'agent',
      phase: run.phase,
      summary: String(run.summary).slice(0, MAX_REPORT_CHARS),
      finishedAt: (run.finishedAt as Date).toISOString(),
    })),
    truncated: rows.length > MAX_ISSUES,
  }
}

const agentQuery = (db: Db, orgId: string) =>
  db('agents')
    .join('accounts', 'agents.account_id', 'accounts.id')
    .where({ 'agents.org_id': orgId })
    .select('agents.*', 'accounts.handle', 'accounts.display_name', 'accounts.status')

export async function pluginAgents(db: Db, orgId: string): Promise<PluginAgent[]> {
  const rows = (await agentQuery(db, orgId).orderBy('accounts.display_name')) as (AgentRow & AccountRow)[]
  return rows.map((agent) => ({
    id: agent.accountId,
    handle: agent.handle,
    name: agent.displayName,
    status: agent.status,
    runtime: agent.runtime,
    model: agent.model,
  }))
}

function pluginRunDto(run: RunRow, publicUrl: string): PluginRun {
  return {
    id: run.id,
    state: run.state,
    finished: FINISHED.includes(run.state),
    agentId: run.agentId,
    output: run.state === 'succeeded' ? (run.structuredOutput ?? null) : null,
    error: run.error?.message ?? null,
    url: `${publicUrl}/runs/${run.id}`,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  }
}

const pluginRuns = (db: Db, orgId: string, pluginId: string) =>
  db<RunRow>('runs').where({ orgId, phase: 'plugin' }).whereRaw("trigger->>'pluginId' = ?", [pluginId])

/**
 * Hands a plugin's request to one of the organization's agents, in a run with no ticket and no repository. The answer
 * stays on the run until the plugin reads it.
 */
export async function startPluginRun(deps: Pick<AppDeps, 'db' | 'env'>, plugin: PluginRow, orgId: string, input: PluginRunInput): Promise<PluginRun> {
  const { db } = deps
  const schema = input.outputSchema
  if (schema && (schema.type !== 'object' || JSON.stringify(schema).length > MAX_SCHEMA_CHARS))
    throw badRequest(`outputSchema must be the JSON Schema of an object, in at most ${MAX_SCHEMA_CHARS} characters`)
  const agent = (await agentQuery(db, orgId).where({ 'agents.account_id': input.agentId }).first()) as (AgentRow & AccountRow) | undefined
  if (!agent) throw notFound('Agent')
  if (agent.status !== 'active') throw conflict(`${agent.handle} is disabled`)
  const [unfinished] = await pluginRuns(db, orgId, plugin.id).whereNotIn('state', FINISHED).count({ count: '*' })
  if (Number(unfinished?.count ?? 0) >= MAX_UNFINISHED_RUNS)
    throw conflict(`${plugin.name} already has ${MAX_UNFINISHED_RUNS} runs going. Wait for one to finish`)

  const snapshot = await buildAgentSnapshot(db, agent)
  const run = await db.transaction(async (trx) => {
    const [row] = await trx<RunRow>('runs')
      .insert({
        orgId,
        agentId: agent.accountId,
        agentSnapshot: json(snapshot) as never,
        phase: 'plugin',
        trigger: json({ pluginId: plugin.id, plugin: plugin.name, prompt: input.prompt, ...(schema ? { outputSchema: schema } : {}) }) as never,
        runtime: agent.runtime,
        model: agent.model,
      })
      .returning('*')
    if (!row) throw new Error('Run insert returned nothing')
    await writeAudit(trx, {
      orgId,
      actorKind: 'system',
      action: 'run.created',
      targetType: 'run',
      targetId: row.id,
      metadata: { phase: 'plugin', via: 'plugin', plugin: plugin.name, pluginId: plugin.id, agent: agent.handle },
    })
    await emit(trx, orgId, { type: 'run.enqueue', runId: row.id })
    await emit(trx, orgId, { type: 'notify', kind: 'run', id: row.id })
    return row
  })
  return pluginRunDto(run, (await readSettings(deps)).publicUrl)
}

/** A plugin reads only the runs it started itself. */
export async function getPluginRun(deps: Pick<AppDeps, 'db' | 'env'>, plugin: PluginRow, orgId: string, runId: string): Promise<PluginRun> {
  const run = UUID.test(runId) ? await pluginRuns(deps.db, orgId, plugin.id).where({ id: runId }).first() : undefined
  if (!run) throw notFound('Run')
  return pluginRunDto(run, (await readSettings(deps)).publicUrl)
}

export async function pluginMembers(db: Db, orgId: string): Promise<PluginMember[]> {
  const rows = (await db<AccountRow>('accounts')
    .where({ orgId })
    .orderBy('displayName')
    .select('id', 'kind', 'displayName', 'handle', 'role', 'status')) as Pick<
    AccountRow,
    'id' | 'kind' | 'displayName' | 'handle' | 'role' | 'status'
  >[]
  return rows.map((account) => ({
    id: account.id,
    kind: account.kind === 'agent' ? 'agent' : 'person',
    name: account.displayName,
    handle: account.handle,
    role: account.role,
    status: account.status,
  }))
}

export async function pluginProjects(db: Db, orgId: string): Promise<PluginTicketProject[]> {
  return db<ProjectRow>('projects').where({ orgId }).orderBy('name').select('id', 'name')
}

function pluginTicketDto(issue: IssueRow): PluginTicket {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.trackerUrl,
    status: issue.trackerStateName,
    statusType: issue.trackerStateType,
    closed: isTrackerClosed(issue),
  }
}

/** Creates a ticket in the tracker the project follows, the way a workflow's Create ticket block does, and remembers it as this plugin's. */
export async function createPluginTicket(
  deps: Pick<AppDeps, 'db' | 'secrets' | 'connectors'>,
  plugin: PluginRow,
  orgId: string,
  input: PluginTicketInput,
): Promise<PluginTicket> {
  const { db } = deps
  const project = await db<ProjectRow>('projects').where({ id: input.projectId, orgId }).first()
  if (!project) throw notFound('Project')
  let handle: string | null = null
  if (input.agentId) {
    const agent = (await agentQuery(db, orgId).where({ 'agents.account_id': input.agentId }).first()) as (AgentRow & AccountRow) | undefined
    if (!agent) throw notFound('Agent')
    if (agent.status !== 'active') throw conflict(`${agent.handle} is disabled`)
    handle = agent.handle
  }
  const tracker = trackerFor(deps, await getConnection(db, orgId, project.trackerConnectionId))
  await recordEcho(db, 'linear', 'issue', 'create', 'title', input.title)
  const created = await tracker.createIssue({
    teamId: project.trackerTeamId,
    projectId: project.trackerProjectId,
    title: input.title,
    description: input.description,
    priority: input.priority ?? 0,
    creatorName: plugin.name,
  })
  const { row } = await upsertIssueMirror(deps, project, created, { announce: true })
  await db.transaction(async (trx) => {
    await trx<PluginTicketRow>('plugin_tickets').insert({ pluginId: plugin.id, orgId, issueId: row.id })
    await writeAudit(trx, {
      orgId,
      actorKind: 'system',
      action: 'issue.created',
      targetType: 'issue',
      targetId: row.id,
      metadata: { identifier: created.identifier, via: 'plugin', plugin: plugin.name, pluginId: plugin.id, assignedTo: handle },
    })
    await emit(trx, orgId, { type: 'notify', kind: 'issue', id: row.id, projectId: project.id })
  })
  if (input.agentId) await assignIssue(deps, row, input.agentId, { accountId: null, via: 'plugin' })
  return pluginTicketDto(row)
}

/** A plugin reads only the tickets it created itself. */
export async function getPluginTicket(db: Db, plugin: PluginRow, orgId: string, ticketId: string): Promise<PluginTicket> {
  const issue = UUID.test(ticketId)
    ? ((await db('issues')
        .join('plugin_tickets', 'plugin_tickets.issue_id', 'issues.id')
        .where({ 'issues.id': ticketId, 'issues.org_id': orgId, 'plugin_tickets.plugin_id': plugin.id })
        .select('issues.*')
        .first()) as IssueRow | undefined)
    : undefined
  if (!issue) throw notFound('Ticket')
  return pluginTicketDto(issue)
}
