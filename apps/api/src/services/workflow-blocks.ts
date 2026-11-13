import { TRACKER_SOURCES } from '@factorix/connectors'
import { type ConditionRule, escapeMarkdown, evaluateRules, renderTemplate } from '@factorix/core'
import { type AccountRow, type AgentRow, type IssueRow, json, type ProjectRow, type RunRow, type SkillRow, type WorkflowRunRow } from '@factorix/db'
import type { BlockType } from '@factorix/schemas'
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
import { changeIssueLabel, moveIssueToStatus, postTrackerComment, upsertIssueMirror } from './tracker-sync'

export const MAX_CREATED_TICKET_DEPTH = 3

const UNIT_MS: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }

export interface BlockContext {
  deps: Pick<AppDeps, 'db' | 'secrets' | 'connectors' | 'env'>
  run: WorkflowRunRow
  nodeId: string
  issue: IssueRow
  project: ProjectRow
  config: Record<string, unknown>
  /** What `{{...}}` can reach in this block. */
  values: Record<string, unknown>
}

export type BlockResult =
  | { status: 'done'; handle?: string; output?: Record<string, unknown> }
  | { status: 'wait'; wakeAt?: Date; output?: Record<string, unknown> }

type ActionBlock = Exclude<BlockType, `trigger.${string}`>

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
  issue: IssueRow,
  project: ProjectRow,
) {
  const steps = await deps.db('workflow_steps').where({ runId: run.id }).whereNotNull('output').select('nodeId', 'output')
  const mergeRequests = (await mergeRequestsOf(deps.db, issue.id)).map((mr) => mr.mrUrl)
  const agent = issue.assignedAgentId ? await deps.db('accounts').where({ id: issue.assignedAgentId }).first('handle') : null
  return {
    issue: {
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
    project: { name: project.name },
    workflow: { name: workflowName },
    run: { url: `${(await readSettings(deps)).publicUrl}/workflows/${run.workflowId}/runs/${run.id}` },
    trigger: run.trigger.event,
    steps: Object.fromEntries(steps.map((step: { nodeId: string; output: unknown }) => [step.nodeId, step.output])),
  }
}

/** New blocks add a catalog entry and a handler here. The compiler refuses a catalog entry with no handler. */
export const BLOCK_HANDLERS: Record<ActionBlock, (context: BlockContext, agentHandle: string | null) => Promise<BlockResult>> = {
  'logic.condition': async ({ config, issue, project }, agentHandle) => ({
    status: 'done',
    handle: evaluateRules((config.rules ?? []) as ConditionRule[], config.match, issueFacts(issue, project, agentHandle)) ? 'true' : 'false',
  }),

  'logic.wait': async ({ config }) => ({
    status: 'wait',
    wakeAt: new Date(Date.now() + Number(config.amount) * (UNIT_MS[String(config.unit)] ?? UNIT_MS.hours ?? 0)),
  }),

  'logic.wait_for': async ({ config }) => ({
    status: 'wait',
    wakeAt: new Date(Date.now() + Number(config.timeoutHours ?? 72) * 3_600_000),
  }),

  'agent.run': async ({ deps, issue, config }) => {
    const agentId = optional(config.agentId)
    if (isTrackerClosed(issue) && STARTABLE.includes(issue.factoryState)) throw new Error(CLOSED_MESSAGE)
    if (agentId) await assignIssue(deps, issue, agentId, { accountId: null, via: 'workflow' })
    else if (STARTABLE.includes(issue.factoryState)) await advanceIssue(deps.db, issue.id, { type: 'start' })
    if (issue.factoryState === 'awaiting_merge') return { status: 'done', handle: 'next', output: { result: 'succeeded' } }
    return { status: 'wait' }
  },

  'agent.prompt': async (context) => {
    const { deps, run, nodeId, issue, project, config } = context
    const { db } = deps
    const prompt = text(context, 'prompt').trim()
    if (!prompt) throw new Error('The prompt came out empty.')
    const agentId = optional(config.agentId) ?? issue.assignedAgentId ?? project.defaultEngineerAgentId
    const agent = agentId
      ? ((await db('agents')
          .join('accounts', 'agents.account_id', 'accounts.id')
          .where({ 'agents.account_id': agentId, 'agents.org_id': issue.orgId })
          .select('agents.*', 'accounts.handle', 'accounts.display_name', 'accounts.status')
          .first()) as (AgentRow & AccountRow) | undefined)
      : undefined
    if (!agent) throw new Error('There is no agent to ask. Pick one in the block.')
    if (agent.status !== 'active') throw new Error(`${agent.handle} is disabled.`)

    const snapshot = await buildAgentSnapshot(db, agent)
    const skillIds = Array.isArray(config.skillIds) ? [...new Set(config.skillIds.map(String))] : []
    if (skillIds.length > 0) {
      const extra = await db<SkillRow>('skills').where({ orgId: issue.orgId }).whereIn('id', skillIds).select('name', 'markdown')
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
          orgId: issue.orgId,
          issueId: issue.id,
          projectId: project.id,
          agentId: agent.accountId,
          agentSnapshot: json(snapshot) as never,
          phase: 'prompt',
          trigger: json({ workflowRunId: run.id, nodeId, prompt, post: config.post !== 'none' }) as never,
          runtime: agent.runtime,
          model,
        })
        .returning('*')
      if (!row) throw new Error('Run insert returned nothing')
      const locked = await trx('issues').where({ id: issue.id }).whereNull('lockedByRunId').update({ lockedByRunId: row.id })
      // Another run has the ticket's workspace. releaseIssueLock starts this one when it finishes.
      if (locked > 0) await emit(trx, issue.orgId, { type: 'run.enqueue', runId: row.id })
      await writeAudit(trx, {
        orgId: issue.orgId,
        actorAccountId: agent.accountId,
        actorKind: 'agent',
        action: 'run.created',
        targetType: 'run',
        targetId: row.id,
        metadata: { phase: 'prompt', issue: issue.identifier, via: 'workflow', workflowId: run.workflowId, workflowRunId: run.id },
      })
      await emit(trx, issue.orgId, { type: 'notify', kind: 'run', id: row.id, projectId: project.id })
      return row
    })
    return { status: 'wait', output: { runId: started.id, url: `${url}${started.id}` } }
  },

  'tracker.comment': async (context) => {
    await postTrackerComment(context.deps, {
      issueId: context.issue.id,
      template: 'workflow',
      agentHandle: 'workflow',
      body: markdown(context, 'body'),
    })
    return { status: 'done', handle: 'next' }
  },

  'tracker.set_status': async (context) => {
    await moveIssueToStatus(context.deps, context.issue, text(context, 'status'))
    return { status: 'done', handle: 'next' }
  },

  'tracker.label': async (context) => {
    await changeIssueLabel(context.deps, context.issue, context.config.action === 'remove' ? 'remove' : 'add', text(context, 'label'))
    return { status: 'done', handle: 'next' }
  },

  'tracker.create_issue': async (context) => {
    const { deps, issue, config, run } = context
    if (issue.workflowDepth >= MAX_CREATED_TICKET_DEPTH) {
      throw new Error(`This ticket came from ${issue.workflowDepth} workflow-created tickets in a row, so it will not create another.`)
    }
    const projectId = optional(config.projectId)
    const project = projectId ? await deps.db<ProjectRow>('projects').where({ id: projectId, orgId: issue.orgId }).first() : context.project
    if (!project) throw new Error('The project for the new ticket no longer exists.')
    const title = text(context, 'title').trim().slice(0, 255)
    if (!title) throw new Error('The ticket title came out empty.')
    const tracker = trackerFor(deps, await getConnection(deps.db, issue.orgId, project.trackerConnectionId))
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
      .update({ workflowDepth: issue.workflowDepth + 1 })
    await writeAudit(deps.db, {
      orgId: issue.orgId,
      actorKind: 'system',
      action: 'issue.created',
      targetType: 'issue',
      targetId: row.id,
      metadata: { identifier: created.identifier, via: 'workflow', workflowId: run.workflowId, workflowRunId: run.id, from: issue.identifier },
    })
    await emit(deps.db, issue.orgId, { type: 'notify', kind: 'issue', id: row.id, projectId: project.id })
    const agentId = optional(config.agentId)
    if (agentId) await assignIssue(deps, { ...row, workflowDepth: issue.workflowDepth + 1 }, agentId, { accountId: null, via: 'workflow' })
    return { status: 'done', handle: 'next', output: { id: row.id, identifier: created.identifier, url: created.url } }
  },

  'notify.send': async (context) => {
    const { deps, issue, config } = context
    const connection = await getConnection(deps.db, issue.orgId, String(config.connectionId))
    const sent = await notifierFor(deps, connection).send({ channelId: String(config.channel), markdown: markdown(context, 'message') })
    return { status: 'done', handle: 'next', output: { url: sent.url } }
  },
}
