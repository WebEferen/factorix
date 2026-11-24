import { TRACKER_SOURCES, type UpdateIssueInput } from '@factorix/connectors'
import { type ConditionRule, escapeMarkdown, evaluateRules, renderTemplate } from '@factorix/core'
import { type AccountRow, type AgentRow, type IssueRow, json, type ProjectRow, type RunRow, type SkillRow, type WorkflowRunRow } from '@factorix/db'
import { type BlockType, SLACK_REPLY, updateIssueInput } from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { isTrackerClosed } from '../dto'
import { writeAudit } from '../lib/audit'
import { emit } from '../lib/outbox'
import { buildAgentSnapshot } from './agents'
import { assignIssue, CLOSED_MESSAGE, STARTABLE } from './assign'
import { getConnection, notifierFor, trackerFor } from './connections'
import { recordEcho } from './echo'
import { advanceIssue } from './pipeline'
import { mergeRequestsOf } from './repos'
import { readSettings } from './settings'
import { applyTrackerIssue, changeIssueLabel, moveIssueToStatus, postTrackerComment, upsertIssueMirror } from './tracker-sync'

export const MAX_CREATED_TICKET_DEPTH = 3

const UNIT_MS: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }

export interface BlockContext {
  deps: Pick<AppDeps, 'db' | 'secrets' | 'connectors' | 'env'>
  run: WorkflowRunRow
  nodeId: string
  /** Null in a run a ticketless trigger started. Only blocks marked `needsTicket` may count on it. */
  issue: IssueRow | null
  /** The ticket's project, or the workflow's own when the run has no ticket. */
  project: ProjectRow | null
  config: Record<string, unknown>
  /** What `{{...}}` can reach in this block. */
  values: Record<string, unknown>
}

export type BlockResult =
  | { status: 'done'; handle?: string; output?: Record<string, unknown> }
  | { status: 'wait'; wakeAt?: Date; output?: Record<string, unknown> }

type ActionBlock = Exclude<BlockType, `trigger.${string}`>
type Handler = (context: BlockContext, agentHandle: string | null) => Promise<BlockResult>
type TicketContext = BlockContext & { issue: IssueRow; project: ProjectRow }

/** Validation keeps these blocks away from ticketless triggers, so this only catches a definition stored before that. */
const onTicket =
  (handler: (context: TicketContext, agentHandle: string | null) => Promise<BlockResult>): Handler =>
  (context, agentHandle) => {
    const { issue, project } = context
    if (!issue || !project) throw new Error('This block works on a ticket, and this run has none.')
    return handler({ ...context, issue, project }, agentHandle)
  }

const text = (context: BlockContext, key: string) => renderTemplate(String(context.config[key] ?? ''), context.values)
const markdown = (context: BlockContext, key: string) => renderTemplate(String(context.config[key] ?? ''), context.values, escapeMarkdown)
const optional = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null)

export function priorityLabel(priority: number): string {
  return TRACKER_SOURCES.linear.priorityLabels[priority] ?? String(priority)
}

export function issueFacts(issue: IssueRow, project: ProjectRow, agentHandle: string | null) {
  return {
    status: issue.trackerStateName,
    labels: issue.labels.map((label) => label.name),
    priority: priorityLabel(issue.priority),
    title: issue.title,
    description: issue.description,
    author: issue.authorName,
    assignee: issue.assigneeName,
    project: project.name,
    agent: agentHandle,
  }
}

export async function templateValues(
  deps: Pick<AppDeps, 'db' | 'env'>,
  run: WorkflowRunRow,
  workflowName: string,
  issue: IssueRow | null,
  project: ProjectRow | null,
) {
  const steps = await deps.db('workflow_steps').where({ runId: run.id }).whereNotNull('output').select('nodeId', 'output')
  const mergeRequests = issue ? (await mergeRequestsOf(deps.db, issue.id)).map((mr) => mr.mrUrl) : []
  const agent = issue?.assignedAgentId ? await deps.db('accounts').where({ id: issue.assignedAgentId }).first('handle') : null
  return {
    issue: issue && {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.trackerUrl,
      status: issue.trackerStateName,
      state: issue.factoryState,
      agent: agent?.handle ?? null,
      branch: issue.branchName,
      priority: priorityLabel(issue.priority),
      labels: issue.labels.map((label) => label.name),
      author: issue.authorName,
      assignee: issue.assigneeName,
      mergeRequests,
    },
    project: { name: project?.name ?? null },
    workflow: { name: workflowName },
    run: { url: `${(await readSettings(deps)).publicUrl}/workflows/${run.workflowId}/runs/${run.id}` },
    trigger: run.trigger.event,
    steps: Object.fromEntries(steps.map((step: { nodeId: string; output: unknown }) => [step.nodeId, step.output])),
  }
}

async function updateTicket({ deps, issue, project }: TicketContext, change: UpdateIssueInput): Promise<BlockResult> {
  const connection = await getConnection(deps.db, issue.orgId, project.trackerConnectionId)
  if (connection.kind === 'factorix') {
    const validation = updateIssueInput.safeParse(change)
    if (!validation.success) throw new Error(validation.error.issues[0]?.message ?? 'Invalid ticket update.')
  }
  const tracker = trackerFor(deps, connection)
  if (!tracker.updateIssue) throw new Error('This tracker does not support editing ticket fields from a workflow.')
  for (const [field, value] of Object.entries(change)) {
    await recordEcho(deps.db, connection.kind, 'issue', issue.trackerIssueId, field, value)
  }
  const fresh = await tracker.updateIssue(issue.trackerIssueId, change)
  await applyTrackerIssue(deps, project, fresh)
  return { status: 'done', handle: 'next' }
}

/** New blocks add a catalog entry and a handler here. The compiler refuses a catalog entry with no handler. */
export const BLOCK_HANDLERS: Record<ActionBlock, Handler> = {
  'logic.condition': onTicket(async ({ config, issue, project }, agentHandle) => ({
    status: 'done',
    handle: evaluateRules((config.rules ?? []) as ConditionRule[], config.match, issueFacts(issue, project, agentHandle)) ? 'true' : 'false',
  })),

  'logic.wait': async ({ config }) => ({
    status: 'wait',
    wakeAt: new Date(Date.now() + Number(config.amount) * (UNIT_MS[String(config.unit)] ?? UNIT_MS.hours ?? 0)),
  }),

  'logic.wait_for': async ({ config }) => ({
    status: 'wait',
    wakeAt: new Date(Date.now() + Number(config.timeoutHours ?? 72) * 3_600_000),
  }),

  'agent.run': onTicket(async ({ deps, issue, config }) => {
    const agentId = optional(config.agentId)
    if (isTrackerClosed(issue) && STARTABLE.includes(issue.factoryState)) throw new Error(CLOSED_MESSAGE)
    if (agentId) await assignIssue(deps, issue, agentId, { accountId: null, via: 'workflow' })
    else if (STARTABLE.includes(issue.factoryState)) await advanceIssue(deps.db, issue.id, { type: 'start' })
    if (issue.factoryState === 'awaiting_merge') return { status: 'done', handle: 'next', output: { result: 'succeeded' } }
    return { status: 'wait' }
  }),

  'agent.prompt': async (context) => {
    const { deps, run, nodeId, issue, config } = context
    const { db } = deps
    const prompt = text(context, 'prompt').trim()
    if (!prompt) throw new Error('The prompt came out empty.')
    // On a ticket the agent reads the ticket's project. Without one, the block's project, then the workflow's, then none.
    const projectId = issue ? null : optional(config.projectId)
    const project = projectId ? await db<ProjectRow>('projects').where({ id: projectId, orgId: run.orgId }).first() : context.project
    if (projectId && !project) throw new Error('The project in this block no longer exists.')
    const agentId = optional(config.agentId) ?? issue?.assignedAgentId ?? project?.defaultEngineerAgentId
    const agent = agentId
      ? ((await db('agents')
          .join('accounts', 'agents.account_id', 'accounts.id')
          .where({ 'agents.account_id': agentId, 'agents.org_id': run.orgId })
          .select('agents.*', 'accounts.handle', 'accounts.display_name', 'accounts.status')
          .first()) as (AgentRow & AccountRow) | undefined)
      : undefined
    if (!agent) throw new Error('There is no agent to ask. Pick one in the block.')
    if (agent.status !== 'active') throw new Error(`${agent.handle} is disabled.`)

    const snapshot = await buildAgentSnapshot(db, agent)
    const skillIds = Array.isArray(config.skillIds) ? [...new Set(config.skillIds.map(String))] : []
    if (skillIds.length > 0) {
      const extra = await db<SkillRow>('skills').where({ orgId: run.orgId }).whereIn('id', skillIds).select('name', 'markdown')
      if (extra.length !== skillIds.length) throw new Error('One of the skills in this block no longer exists.')
      const own = snapshot.skills as { name: string; markdown: string }[]
      snapshot.skills = [...own, ...extra.filter((skill) => !own.some((item) => item.name === skill.name))]
    }
    const model = optional(config.model) ?? agent.model
    snapshot.model = model

    const url = `${(await readSettings(deps)).publicUrl}/runs/`
    const started = await db.transaction(async (trx) => {
      const [row] = await trx<RunRow>('runs')
        .insert({
          orgId: run.orgId,
          issueId: issue?.id ?? null,
          projectId: project?.id ?? null,
          agentId: agent.accountId,
          agentSnapshot: json(snapshot) as never,
          phase: 'prompt',
          trigger: json({ workflowRunId: run.id, nodeId, prompt, post: config.post !== 'none' }) as never,
          runtime: agent.runtime,
          model,
        })
        .returning('*')
      if (!row) throw new Error('Run insert returned nothing')
      const locked = issue ? await trx('issues').where({ id: issue.id }).whereNull('lockedByRunId').update({ lockedByRunId: row.id }) : 1
      // Another run has the ticket's workspace. releaseIssueLock starts this one when it finishes.
      if (locked > 0) await emit(trx, run.orgId, { type: 'run.enqueue', runId: row.id })
      await writeAudit(trx, {
        orgId: run.orgId,
        actorAccountId: agent.accountId,
        actorKind: 'agent',
        action: 'run.created',
        targetType: 'run',
        targetId: row.id,
        metadata: { phase: 'prompt', issue: issue?.identifier ?? null, via: 'workflow', workflowId: run.workflowId, workflowRunId: run.id },
      })
      await emit(trx, run.orgId, { type: 'notify', kind: 'run', id: row.id, projectId: project?.id ?? null })
      return row
    })
    return { status: 'wait', output: { runId: started.id, url: `${url}${started.id}` } }
  },

  'tracker.comment': onTicket(async (context) => {
    await postTrackerComment(context.deps, {
      issueId: context.issue.id,
      template: 'workflow',
      agentHandle: 'workflow',
      body: markdown(context, 'body'),
    })
    return { status: 'done', handle: 'next' }
  }),

  'tracker.set_title': onTicket(async (context) => {
    const title = text(context, 'title').trim()
    if (!title) throw new Error('The ticket title came out empty.')
    return updateTicket(context, { title })
  }),

  'tracker.set_description': onTicket(async (context) => {
    const template = context.config.description
    if (template !== undefined && typeof template !== 'string') throw new Error('The ticket description must be text.')
    if (!template?.trim()) return updateTicket(context, { description: null })
    const description = renderTemplate(template, context.values, (value, path) => (path === 'issue.description' ? value : escapeMarkdown(value)))
    if (!description.trim()) throw new Error('The ticket description came out empty. Leave the field blank to clear it.')
    return updateTicket(context, { description })
  }),

  'tracker.set_priority': onTicket(async (context) => {
    const priority = Number(context.config.priority)
    if (!['0', '1', '2', '3', '4'].includes(String(context.config.priority))) throw new Error('Choose a ticket priority.')
    return updateTicket(context, { priority })
  }),

  'tracker.set_status': onTicket(async (context) => {
    await moveIssueToStatus(context.deps, context.issue, text(context, 'status'))
    return { status: 'done', handle: 'next' }
  }),

  'tracker.label': onTicket(async (context) => {
    await changeIssueLabel(context.deps, context.issue, context.config.action === 'remove' ? 'remove' : 'add', text(context, 'label'))
    return { status: 'done', handle: 'next' }
  }),

  'tracker.create_issue': async (context) => {
    const { deps, issue, config, run } = context
    const depth = issue?.workflowDepth ?? 0
    if (depth >= MAX_CREATED_TICKET_DEPTH) {
      throw new Error(`This ticket came from ${depth} workflow-created tickets in a row, so it will not create another.`)
    }
    const projectId = optional(config.projectId)
    const project = projectId ? await deps.db<ProjectRow>('projects').where({ id: projectId, orgId: run.orgId }).first() : context.project
    if (!project) {
      throw new Error(
        projectId ? 'The project for the new ticket no longer exists.' : 'This run has no ticket to take a project from. Pick one in the block.',
      )
    }
    const title = text(context, 'title').trim().slice(0, 255)
    if (!title) throw new Error('The ticket title came out empty.')
    const tracker = trackerFor(deps, await getConnection(deps.db, run.orgId, project.trackerConnectionId))
    await recordEcho(deps.db, 'linear', 'issue', 'create', 'title', title)
    const created = await tracker.createIssue({
      teamId: project.trackerTeamId,
      projectId: project.trackerProjectId,
      title,
      description: markdown(context, 'description'),
      priority: Number(config.priority ?? 0),
    })
    const { row } = await upsertIssueMirror(deps, project, created, { announce: true })
    await deps
      .db('issues')
      .where({ id: row.id })
      .update({ workflowDepth: depth + 1 })
    await writeAudit(deps.db, {
      orgId: run.orgId,
      actorKind: 'system',
      action: 'issue.created',
      targetType: 'issue',
      targetId: row.id,
      metadata: {
        identifier: created.identifier,
        via: 'workflow',
        workflowId: run.workflowId,
        workflowRunId: run.id,
        from: issue?.identifier ?? null,
      },
    })
    await emit(deps.db, run.orgId, { type: 'notify', kind: 'issue', id: row.id, projectId: project.id })
    const agentId = optional(config.agentId)
    if (agentId) await assignIssue(deps, { ...row, workflowDepth: depth + 1 }, agentId, { accountId: null, via: 'workflow' })
    return { status: 'done', handle: 'next', output: { id: row.id, identifier: created.identifier, url: created.url } }
  },

  'slack.send_message': async (context) => {
    const { deps, run, config } = context
    let connectionId = String(config.connectionId)
    let channelId = String(config.channel)
    let threadId = text(context, 'thread').trim() || undefined
    if (channelId === SLACK_REPLY) {
      const event = run.trigger.event
      const data = event.kind === 'external' && String(event.type).startsWith('trigger.slack.') ? (event.data as Record<string, string>) : null
      if (!data?.channel) throw new Error('This run did not start from a Slack message, so there is nothing to reply to.')
      // The reply goes back through the connection the message came in on.
      connectionId = data.connectionId ?? connectionId
      channelId = data.channel
      threadId ??= data.channelType === 'im' && data.thread === data.ts ? undefined : data.thread
    }
    const connection = await getConnection(deps.db, run.orgId, connectionId)
    if (connection.kind !== 'slack') throw new Error('This block sends through a Slack connection. Pick one')
    const sent = await notifierFor(deps, connection).send({ channelId, markdown: markdown(context, 'message'), threadId })
    return { status: 'done', handle: 'next', output: { url: sent.url, thread: threadId ?? sent.id } }
  },
}
