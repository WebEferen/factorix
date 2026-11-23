import { createHmac } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { RetryLaterError, signPlugin, type TrackerIssue } from '@factorix/connectors'
import { initialBlockConfig, pluginBlockType, pluginTriggerType, type WorkflowDefinition } from '@factorix/schemas'
import { type BlockCall, definePlugin } from '@moxxy/factorix-plugin-sdk'
import { serve } from '@moxxy/factorix-plugin-sdk/node'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { advanceIssue } from './services/pipeline'
import { relayDomainEvents } from './services/relay'
import { applyTrackerIssue, setTrackerState } from './services/tracker-sync'
import { MAX_CREATED_TICKET_DEPTH } from './services/workflow-blocks'
import {
  advanceWorkflowRun,
  executeWorkflowStep,
  fireTrigger,
  handleWorkflowEvent,
  MAX_RUNS_PER_TICKET_PER_HOUR,
  sweepWorkflows,
} from './services/workflows'
import { TEAM_ID } from './testing/fakes'
import { ApiClient, createHarness, type Harness } from './testing/harness'

const SETUP = { orgName: 'Acme', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' }
const STATE_MAP = { in_progress: 'st-progress', in_review: 'st-review', done: 'st-done', blocked: 'st-blocked' }
const REPO = { scmRepoId: '42', scmRepoPath: 'g/r', scmCloneUrl: 'https://gitlab.com/g/r.git', defaultBranch: 'main' }

type Node = WorkflowDefinition['nodes'][number]
const block = (id: string, type: string, config: Record<string, unknown> = {}) =>
  ({ id, type, position: { x: 0, y: 0 }, config: { ...initialBlockConfig(type), ...config } }) as Node
const link = (source: string, target: string, sourceHandle = 'next') => ({ id: `${source}-${sourceHandle}-${target}`, source, sourceHandle, target })

describe('workflows', () => {
  let harness: Harness
  let admin: ApiClient
  let linearId: string
  let gitlabId: string
  let slackId: string
  let projectId: string
  let otherProjectId: string
  let counter = 0

  beforeAll(async () => {
    harness = await createHarness({ databaseUrl: inject('databaseUrl'), redisUrl: inject('redisUrl') })
    admin = new ApiClient(harness.app)
    await admin.ok('POST', '/api/auth/setup', SETUP)
    linearId = (await admin.ok('POST', '/api/connections', { kind: 'linear', name: 'Linear', secret: 'x' })).connection.id
    gitlabId = (await admin.ok('POST', '/api/connections', { kind: 'gitlab', name: 'GitLab', secret: 'y', config: {} })).connection.id
    slackId = (await admin.ok('POST', '/api/connections', { kind: 'slack', name: 'Slack', secret: 'xoxb-secret' })).connection.id
    const project = async (name: string, trackerProjectId: string | null) =>
      (
        await admin.ok('POST', '/api/projects', {
          name,
          trackerConnectionId: linearId,
          trackerTeamId: TEAM_ID,
          trackerProjectId,
          scmConnectionId: gitlabId,
          repos: [REPO],
          stateMap: STATE_MAP,
        })
      ).project.id as string
    projectId = await project('Platform', null)
    otherProjectId = await project('Other', 'other')
  })
  afterAll(() => harness.destroy())

  const db = () => harness.deps.db
  const engineerArchetype = async () =>
    (await admin.ok('GET', '/api/archetypes')).archetypes.find((item: { name: string }) => item.name === 'Engineer').id as string
  const world = () => harness.world

  /** Plays the worker: relays the outbox and runs what lands on the workflow queue until nothing is left. */
  async function drain(): Promise<void> {
    for (let round = 0; round < 50; round++) {
      await relayDomainEvents(harness.deps)
      const jobs = await harness.deps.queues.workflows.getJobs(['waiting'])
      if (jobs.length === 0) return
      for (const job of jobs) {
        if (job.name === 'event') await handleWorkflowEvent(harness.deps, job.data)
        else if (job.name === 'advance') await advanceWorkflowRun(db(), job.data.runId)
        else if (job.name === 'step') await executeWorkflowStep(harness.deps, job.data.runId, job.data.nodeId)
        else if (job.name === 'trigger') await fireTrigger(harness.deps, job.data)
        await job.remove()
      }
    }
    throw new Error('The workflow queue never settled')
  }

  async function publish(definition: WorkflowDefinition, options: { enabled?: boolean; projectId?: string | null } = {}) {
    counter += 1
    const { workflow } = await admin.ok('POST', '/api/workflows', { name: `W${counter}`, projectId: options.projectId ?? null, definition })
    await admin.ok('POST', `/api/workflows/${workflow.id}/publish`)
    if (options.enabled) await admin.ok('POST', `/api/workflows/${workflow.id}/enabled`, { enabled: true })
    return workflow.id as string
  }

  /** Enabled workflows from earlier tests would otherwise react to this test's events. */
  async function retireWorkflows() {
    await db()('workflows').update({ enabled: false })
    await drain()
  }

  async function ticket(title = 'A ticket', project = projectId) {
    counter += 1
    const { issue } = await admin.ok('POST', `/api/projects/${project}/issues`, { title: `${title} ${counter}` })
    await drain()
    return issue as { id: string; identifier: string; trackerIssueId: string; title: string }
  }

  async function runOn(workflowId: string, issueId: string) {
    const { started, skipped } = await admin.ok('POST', `/api/workflows/${workflowId}/runs`, { issueIds: [issueId] })
    expect(skipped).toEqual([])
    await drain()
    return (await admin.ok('GET', `/api/workflow-runs/${started[0]}`)).run
  }

  const refresh = async (runId: string) => (await admin.ok('GET', `/api/workflow-runs/${runId}`)).run
  const statusOf = (run: { steps: { nodeId: string; status: string }[] }) => Object.fromEntries(run.steps.map((step) => [step.nodeId, step.status]))
  const slack = (message: string, channel = 'C1') => ({ connectionId: slackId, channel, message })
  const SLACK_BLOCKS = ['trigger.slack.message', 'trigger.slack.mention', 'slack.send_message']

  describe('drafts and publishing', () => {
    it('saves an unfinished draft, refuses to publish it, and says why', async () => {
      const { workflow } = await admin.ok('POST', '/api/workflows', {
        name: 'Draft',
        definition: { nodes: [block('c', 'tracker.comment')], edges: [] },
      })
      expect(workflow.publishedVersion).toBe(0)
      const published = await admin.request('POST', `/api/workflows/${workflow.id}/publish`)
      expect(published.status).toBe(422)
      expect(JSON.stringify(published.body)).toContain('Add a block that starts the workflow')
      expect((await admin.request('POST', `/api/workflows/${workflow.id}/enabled`, { enabled: true })).status).toBe(409)
      expect((await admin.request('POST', `/api/workflows/${workflow.id}/runs`, { issueIds: [(await ticket()).id] })).status).toBe(409)
    })

    it('refuses block types that do not exist', async () => {
      const definition = { nodes: [{ id: 'a', type: 'shell.exec', position: { x: 0, y: 0 }, config: {} }], edges: [] }
      expect((await admin.request('POST', '/api/workflows', { name: 'Bad', definition })).status).toBe(422)
    })

    it('keeps the audit trail on the things that change what runs', async () => {
      const id = await publish({ nodes: [block('t', 'trigger.manual'), block('c', 'tracker.comment', { body: 'x' })], edges: [link('t', 'c')] })
      const actions = (await db()('audit_log').where({ targetType: 'workflow', targetId: id })).map((row: { action: string }) => row.action)
      expect(actions).toEqual(expect.arrayContaining(['workflow.created', 'workflow.published']))
    })

    it('only lets admins change workflows, while members can run them', async () => {
      const id = await publish({ nodes: [block('t', 'trigger.manual'), block('c', 'tracker.comment', { body: 'x' })], edges: [link('t', 'c')] })
      await admin.ok('POST', '/api/members', { name: 'Mo', email: 'mo@example.com', password: 'correct horse battery', role: 'member' })
      const member = new ApiClient(harness.app)
      await member.ok('POST', '/api/auth/login', { email: 'mo@example.com', password: 'correct horse battery' })
      expect((await member.request('POST', '/api/workflows', { name: 'No', definition: { nodes: [], edges: [] } })).status).toBe(403)
      expect((await member.request('POST', `/api/workflows/${id}/publish`)).status).toBe(403)
      expect((await member.request('POST', `/api/workflows/${id}/enabled`, { enabled: true })).status).toBe(403)
      expect((await member.request('GET', `/api/connections/${slackId}/channels`)).status).toBe(403)
      const issue = await ticket()
      expect((await member.request('POST', `/api/workflows/${id}/runs`, { issueIds: [issue.id] })).status).toBe(200)
      await drain()
    })

    it('tracks unpublished changes, and a run keeps the version it started with', async () => {
      const wait = block('w', 'logic.wait', { amount: 1, unit: 'minutes' })
      const first = block('c', 'tracker.comment', { body: 'version one' })
      const definition = { nodes: [block('t', 'trigger.manual'), wait, first], edges: [link('t', 'w'), link('w', 'c')] }
      const id = await publish(definition)
      const issue = await ticket()
      const run = await runOn(id, issue.id)
      expect(statusOf(run).w).toBe('waiting')

      const changed = { ...definition, nodes: [definition.nodes[0], wait, block('c', 'tracker.comment', { body: 'version two' })] }
      const saved = await admin.ok('PUT', `/api/workflows/${id}`, { name: 'Edited', definition: changed })
      expect(saved.workflow.hasUnpublishedChanges).toBe(true)
      expect((await admin.ok('POST', `/api/workflows/${id}/publish`)).workflow.publishedVersion).toBe(2)

      await db()('workflow_steps')
        .where({ runId: run.id, nodeId: 'w' })
        .update({ wakeAt: new Date(Date.now() - 1000) })
      await sweepWorkflows(harness.deps)
      await drain()
      expect(world().comments.at(-1)?.body).toContain('version one')
      expect(world().comments.at(-1)?.body).not.toContain('version two')
    })
  })

  describe('running on a ticket', () => {
    it('follows the matching side of a condition, fills templates, and leaves a run record', async () => {
      const definition = {
        nodes: [
          block('t', 'trigger.manual'),
          block('check', 'logic.condition', { match: 'all', rules: [{ field: 'title', operator: 'contains', value: 'urgent' }] }),
          block('yes', 'slack.send_message', slack('Urgent: **{{issue.identifier}}** in {{project.name}} by {{workflow.name}}\n{{run.url}}')),
          block('no', 'tracker.comment', { body: 'Not urgent' }),
        ],
        edges: [link('t', 'check'), link('check', 'yes', 'true'), link('check', 'no', 'false')],
      }
      const id = await publish(definition)
      const hot = await ticket('Urgent outage')
      const before = world().notifications.length
      const run = await runOn(id, hot.id)
      expect(run.status).toBe('succeeded')
      expect(statusOf(run)).toEqual({ t: 'succeeded', check: 'succeeded', yes: 'succeeded', no: 'skipped' })
      const sent = world().notifications.at(-1)
      expect(world().notifications.length).toBe(before + 1)
      expect(sent?.channelId).toBe('C1')
      expect(sent?.markdown).toContain(`**${hot.identifier}** in Platform`)
      expect(sent?.markdown).toContain(`/workflows/${id}/runs/${run.id}`)
      expect(run.steps.find((step: { nodeId: string }) => step.nodeId === 'yes').output).toEqual({
        url: expect.stringContaining('slack.test'),
        thread: 'm1',
      })

      const cold = await ticket('Small tweak')
      const other = await runOn(id, cold.id)
      expect(statusOf(other)).toEqual({ t: 'succeeded', check: 'succeeded', yes: 'skipped', no: 'succeeded' })
      expect((await admin.ok('GET', `/api/issues/${cold.id}/workflow-runs`)).runs[0].id).toBe(other.id)
    })

    it('escapes ticket text but not the template it is placed in', async () => {
      const id = await publish({
        nodes: [block('t', 'trigger.manual'), block('s', 'slack.send_message', slack('**Ticket** [open]({{issue.url}}): {{issue.title}}'))],
        edges: [link('t', 's')],
      })
      const issue = await ticket('[click](http://evil.test) <!channel>')
      await runOn(id, issue.id)
      const { markdown } = world().notifications.at(-1) as { markdown: string }
      expect(markdown).toContain('**Ticket** [open](')
      expect(markdown).toContain('\\[click\\]\\(http://evil.test\\) \\<\\!channel\\>')
    })

    it('starts a block once when parallel branches join', async () => {
      const id = await publish({
        nodes: [
          block('t', 'trigger.manual'),
          block('a', 'tracker.comment', { body: 'a' }),
          block('b', 'tracker.comment', { body: 'b' }),
          block('join', 'slack.send_message', slack('joined')),
        ],
        edges: [link('t', 'a'), link('t', 'b'), link('a', 'join'), link('b', 'join')],
      })
      const before = world().notifications.length
      const run = await runOn(id, (await ticket()).id)
      expect(run.status).toBe('succeeded')
      expect(world().notifications.length).toBe(before + 1)
    })

    it('hands later blocks what earlier ones produced', async () => {
      const id = await publish({
        nodes: [
          block('t', 'trigger.manual'),
          block('make', 'tracker.create_issue', { title: 'Follow up on {{issue.identifier}}', priority: '2' }),
          block('tell', 'slack.send_message', slack('Created {{steps.make.identifier}} at {{steps.make.url}}')),
        ],
        edges: [link('t', 'make'), link('make', 'tell')],
      })
      const issue = await ticket()
      const run = await runOn(id, issue.id)
      expect(run.status).toBe('succeeded')
      const made = run.steps.find((step: { nodeId: string }) => step.nodeId === 'make').output
      expect(made.identifier).toBeTruthy()
      expect(world().notifications.at(-1)?.markdown).toContain(`Created ${made.identifier}`)
      const row = await db()('issues').where({ id: made.id }).first()
      expect(row.title).toBe(`Follow up on ${issue.identifier}`)
      expect(row.priority).toBe(2)
      expect(row.workflowDepth).toBe(1)
    })

    it('moves status and changes labels in the tracker and the mirror', async () => {
      const id = await publish({
        nodes: [
          block('t', 'trigger.manual'),
          block('s', 'tracker.set_status', { status: 'in review' }),
          block('l', 'tracker.label', { action: 'add', label: 'needs-qa' }),
        ],
        edges: [link('t', 's'), link('s', 'l')],
      })
      const issue = await ticket()
      expect((await runOn(id, issue.id)).status).toBe('succeeded')
      const row = await db()('issues').where({ id: issue.id }).first()
      expect(row.trackerStateId).toBe('st-review')
      expect(row.labels.map((label: { name: string }) => label.name)).toContain('needs-qa')
      expect(world().issues.get(issue.trackerIssueId)?.stateId).toBe('st-review')
    })

    it('fails with a clear reason on a status the team does not have', async () => {
      const id = await publish({
        nodes: [block('t', 'trigger.manual'), block('s', 'tracker.set_status', { status: 'Nope' })],
        edges: [link('t', 's')],
      })
      const run = await runOn(id, (await ticket()).id)
      expect(run.status).toBe('failed')
      expect(run.error).toContain('no status called Nope')
    })

    it('refuses a second run while one is active, and allows it after', async () => {
      const id = await publish({
        nodes: [block('t', 'trigger.manual'), block('w', 'logic.wait', { amount: 1, unit: 'days' })],
        edges: [link('t', 'w')],
      })
      const issue = await ticket()
      const run = await runOn(id, issue.id)
      const again = await admin.ok('POST', `/api/workflows/${id}/runs`, { issueIds: [issue.id] })
      expect(again.started).toEqual([])
      expect(again.skipped[0].reason).toContain('already running')
      const cancelled = (await admin.ok('POST', `/api/workflow-runs/${run.id}/cancel`)).run
      expect(cancelled.status).toBe('cancelled')
      expect(statusOf(cancelled).w).toBe('cancelled')
      expect((await admin.ok('POST', `/api/workflows/${id}/runs`, { issueIds: [issue.id] })).started).toHaveLength(1)
      await drain()
    })

    it('stays inside its project', async () => {
      const id = await publish(
        { nodes: [block('t', 'trigger.manual'), block('c', 'tracker.comment', { body: 'x' })], edges: [link('t', 'c')] },
        { projectId },
      )
      const outside = await ticket('Elsewhere', otherProjectId)
      const result = await admin.ok('POST', `/api/workflows/${id}/runs`, { issueIds: [outside.id] })
      expect(result.started).toEqual([])
      expect(result.skipped[0].reason).toContain('outside')
    })
  })

  describe('failures', () => {
    const notifyThenLog = () => ({
      nodes: [block('t', 'trigger.manual'), block('s', 'slack.send_message', slack('hello')), block('c', 'tracker.comment', { body: 'sent' })],
      edges: [link('t', 's'), link('s', 'c')],
    })

    it('fails the run and stops when nothing handles the failure', async () => {
      const id = await publish(notifyThenLog())
      world().notifyError = new Error('Slack is down')
      const run = await runOn(id, (await ticket()).id)
      expect(run.status).toBe('failed')
      expect(run.error).toBe('Slack is down')
      expect(statusOf(run)).toEqual({ t: 'succeeded', s: 'failed', c: 'cancelled' })
    })

    it('continues through the failure output when it is connected', async () => {
      const definition = notifyThenLog()
      definition.nodes.push(block('recover', 'tracker.comment', { body: 'Slack failed' }))
      definition.edges.push(link('s', 'recover', 'failed'))
      const id = await publish(definition)
      world().notifyError = new Error('Slack is down')
      const run = await runOn(id, (await ticket()).id)
      expect(run.status).toBe('succeeded')
      expect(statusOf(run)).toEqual({ t: 'succeeded', s: 'failed', c: 'skipped', recover: 'succeeded' })
    })

    it('waits and retries when the channel asks it to, without sending twice', async () => {
      const id = await publish(notifyThenLog())
      const before = world().notifications.length
      world().notifyError = new RetryLaterError('slow down', 60_000)
      const issue = await ticket()
      const { started } = await admin.ok('POST', `/api/workflows/${id}/runs`, { issueIds: [issue.id] })
      await drain()
      expect(statusOf(await refresh(started[0])).s).toBe('queued')
      const [delayed] = await harness.deps.queues.workflows.getJobs(['delayed'])
      expect(delayed?.opts.delay).toBe(60_000)
      await delayed?.promote()
      await drain()
      const run = await refresh(started[0])
      expect(run.status).toBe('succeeded')
      expect(run.steps.find((step: { nodeId: string }) => step.nodeId === 's').status).toBe('succeeded')
      expect(world().notifications.length).toBe(before + 1)
    })

    it('does not repeat a step whose worker died, in case it had already sent', async () => {
      const id = await publish(notifyThenLog())
      const issue = await ticket()
      const { started } = await admin.ok('POST', `/api/workflows/${id}/runs`, { issueIds: [issue.id] })
      await relayDomainEvents(harness.deps)
      await drain()
      await db()('workflow_runs').where({ id: started[0] }).update({ status: 'running', finishedAt: null })
      await db()('workflow_steps')
        .where({ runId: started[0], nodeId: 's' })
        .update({ status: 'running', updatedAt: new Date(Date.now() - 3_600_000) })
      const before = world().notifications.length
      await executeWorkflowStep(harness.deps, started[0], 's')
      await sweepWorkflows(harness.deps)
      await drain()
      const run = await refresh(started[0])
      expect(world().notifications.length).toBe(before)
      expect(run.status).toBe('failed')
      expect(run.error).toContain('not retried')
    })

    it('re-queues a step whose job was lost', async () => {
      const id = await publish(notifyThenLog())
      const issue = await ticket()
      const { started } = await admin.ok('POST', `/api/workflows/${id}/runs`, { issueIds: [issue.id] })
      await drain()
      await db()('workflow_runs').where({ id: started[0] }).update({ status: 'running', finishedAt: null })
      await db()('workflow_steps').where({ runId: started[0] }).update({ status: 'pending', handle: null })
      await db()('workflow_steps').where({ runId: started[0], nodeId: 't' }).update({ status: 'succeeded', handle: 'next' })
      await db()('workflow_steps')
        .where({ runId: started[0], nodeId: 's' })
        .update({ status: 'queued', updatedAt: new Date(Date.now() - 3_600_000) })
      await sweepWorkflows(harness.deps)
      await drain()
      expect((await refresh(started[0])).status).toBe('succeeded')
    })
  })

  describe('on a schedule', () => {
    const HOUR = 3_600_000
    const nightly = (issue: string, config: Record<string, unknown> = {}) => ({
      nodes: [block('t', 'trigger.schedule', { issue, ...config }), block('c', 'tracker.comment', { body: 'Nightly for {{trigger.scheduledFor}}' })],
      edges: [link('t', 'c')],
    })
    const schedule = (workflowId: string) => db()('workflow_schedules').where({ workflowId }).first()
    const runsOf = (workflowId: string) => db()('workflow_runs').where({ workflowId }).orderBy('created_at')
    const makeDue = (workflowId: string) =>
      db()('workflow_schedules')
        .where({ workflowId })
        .update({ nextAt: new Date(Date.now() - 60_000) })

    it('refuses a time or a time zone that means nothing', async () => {
      const { workflow } = await admin.ok('POST', '/api/workflows', {
        name: 'Bad time',
        definition: nightly('ENG-1', { time: 'two', timezone: 'Mars' }),
      })
      const published = await admin.request('POST', `/api/workflows/${workflow.id}/publish`)
      expect(published.status).toBe(422)
      expect(JSON.stringify(published.body)).toContain('HH:MM')
    })

    it('starts on its ticket when the time comes, once, and waits for the next', async () => {
      await retireWorkflows()
      const issue = await ticket('Nightly')
      const id = await publish(nightly(issue.identifier.toLowerCase()), { enabled: true })
      await sweepWorkflows(harness.deps)
      const planned = await schedule(id)
      expect(planned.nextAt.getTime()).toBeGreaterThan(Date.now())
      expect(planned.nextAt.getTime()).toBeLessThanOrEqual(Date.now() + 24 * HOUR)
      expect(await runsOf(id)).toHaveLength(0)

      await makeDue(id)
      await Promise.all([sweepWorkflows(harness.deps), sweepWorkflows(harness.deps)])
      await drain()
      const [run, ...more] = await runsOf(id)
      expect(more).toEqual([])
      expect(run).toMatchObject({ issueId: issue.id, status: 'succeeded', startedBy: null })
      expect(run.trigger.event.kind).toBe('schedule')
      expect(world().comments.at(-1)?.body).toContain(`Nightly for ${run.trigger.event.scheduledFor}`)
      expect((await schedule(id)).nextAt.getTime()).toBeGreaterThan(Date.now())
      await sweepWorkflows(harness.deps)
      expect(await runsOf(id)).toHaveLength(1)
    })

    it('skips a time while the run before it is still going, and says so', async () => {
      await retireWorkflows()
      const issue = await ticket('Slow nightly')
      const id = await publish(
        {
          nodes: [block('t', 'trigger.schedule', { issue: issue.identifier }), block('w', 'logic.wait', { amount: 2, unit: 'hours' })],
          edges: [link('t', 'w')],
        },
        { enabled: true },
      )
      await sweepWorkflows(harness.deps)
      await makeDue(id)
      await sweepWorkflows(harness.deps)
      await drain()
      await makeDue(id)
      await sweepWorkflows(harness.deps)
      await drain()
      expect(await runsOf(id)).toHaveLength(1)
      const skipped = await db()('audit_log').where({ action: 'workflow.schedule_skipped', targetId: id })
      expect(skipped.map((entry: { metadata: { reason: string } }) => entry.metadata.reason)).toEqual(['The run before it is still going'])
    })

    it('says so when its ticket is missing, and stops when it is turned off', async () => {
      await retireWorkflows()
      const id = await publish(nightly('NOPE-404'), { enabled: true })
      await sweepWorkflows(harness.deps)
      await makeDue(id)
      await sweepWorkflows(harness.deps)
      expect(await runsOf(id)).toHaveLength(0)
      const [skipped] = await db()('audit_log').where({ action: 'workflow.schedule_skipped', targetId: id })
      expect(skipped.metadata.reason).toContain('NOPE-404')

      await makeDue(id)
      await admin.ok('POST', `/api/workflows/${id}/enabled`, { enabled: false })
      await sweepWorkflows(harness.deps)
      expect(await schedule(id)).toBeUndefined()
      await admin.ok('POST', `/api/workflows/${id}/enabled`, { enabled: true })
      await sweepWorkflows(harness.deps)
      expect((await schedule(id)).nextAt.getTime()).toBeGreaterThan(Date.now())
    })

    it('moves to the new time when a new version is published, without firing the old one', async () => {
      await retireWorkflows()
      const issue = await ticket('Rescheduled')
      const id = await publish(nightly(issue.identifier), { enabled: true })
      await sweepWorkflows(harness.deps)
      await makeDue(id)
      await admin.ok('PUT', `/api/workflows/${id}`, { name: 'Moved', definition: nightly(issue.identifier, { days: '0', time: '05:00' }) })
      await admin.ok('POST', `/api/workflows/${id}/publish`)
      await sweepWorkflows(harness.deps)
      await drain()
      expect(await runsOf(id)).toHaveLength(0)
      const planned = (await schedule(id)).nextAt as Date
      expect([planned.getUTCDay(), planned.getUTCHours(), planned.getUTCMinutes()]).toEqual([0, 5, 0])
    })
  })

  describe('waiting', () => {
    it('resumes a timer from the database', async () => {
      const id = await publish({
        nodes: [
          block('t', 'trigger.manual'),
          block('w', 'logic.wait', { amount: 2, unit: 'hours' }),
          block('c', 'tracker.comment', { body: 'later' }),
        ],
        edges: [link('t', 'w'), link('w', 'c')],
      })
      const run = await runOn(id, (await ticket()).id)
      const step = run.steps.find((item: { nodeId: string }) => item.nodeId === 'w')
      expect(new Date(step.wakeAt).getTime()).toBeGreaterThan(Date.now() + 3_500_000)
      await sweepWorkflows(harness.deps)
      await drain()
      expect(statusOf(await refresh(run.id)).w).toBe('waiting')
      await db()('workflow_steps')
        .where({ runId: run.id, nodeId: 'w' })
        .update({ wakeAt: new Date(Date.now() - 1000) })
      await sweepWorkflows(harness.deps)
      await drain()
      expect((await refresh(run.id)).status).toBe('succeeded')
    })

    const waitFor = (config: Record<string, unknown>) => ({
      nodes: [
        block('t', 'trigger.manual'),
        block('w', 'logic.wait_for', config),
        block('ok', 'tracker.comment', { body: 'it happened' }),
        block('late', 'tracker.comment', { body: 'gave up' }),
      ],
      edges: [link('t', 'w'), link('w', 'ok'), link('w', 'late', 'timeout')],
    })

    it('resumes when the event happens and ignores other events', async () => {
      const id = await publish(waitFor({ event: 'status.changed', to: 'Done' }))
      const issue = await ticket()
      const run = await runOn(id, issue.id)
      await handleWorkflowEvent(harness.deps, { issueId: issue.id, event: { kind: 'status.changed', from: 'Todo', to: 'In Review' } })
      await drain()
      expect(statusOf(await refresh(run.id)).w).toBe('waiting')
      await handleWorkflowEvent(harness.deps, { issueId: issue.id, event: { kind: 'status.changed', from: 'In Review', to: 'Done' } })
      await drain()
      expect(statusOf(await refresh(run.id))).toMatchObject({ w: 'succeeded', ok: 'succeeded', late: 'skipped' })
    })

    it('takes the timeout output when it never happens', async () => {
      const id = await publish(waitFor({ event: 'merge_request.merged', timeoutHours: 1 }))
      const run = await runOn(id, (await ticket()).id)
      await db()('workflow_steps')
        .where({ runId: run.id, nodeId: 'w' })
        .update({ wakeAt: new Date(Date.now() - 1000) })
      await sweepWorkflows(harness.deps)
      await drain()
      expect(statusOf(await refresh(run.id))).toMatchObject({ w: 'succeeded', ok: 'skipped', late: 'succeeded' })
    })
  })

  describe('agents', () => {
    let agentId: string
    beforeAll(async () => {
      const { agent } = await admin.ok('POST', '/api/agents', {
        handle: 'eng-1',
        displayName: 'Eng',
        archetypeId: await engineerArchetype(),
        systemPrompt: 'Build',
        policy: { mode: 'edit', allow: [], deny: [], requireApproval: [], networkAccess: true },
        runtime: 'claude',
      })
      agentId = agent.id
    })

    const agentFlow = () => ({
      nodes: [
        block('t', 'trigger.manual'),
        block('a', 'agent.run', { agentId }),
        block('ok', 'slack.send_message', slack('Done: {{steps.a.result}}')),
        block('bad', 'slack.send_message', slack('Agent failed')),
      ],
      edges: [link('t', 'a'), link('a', 'ok'), link('a', 'bad', 'failed')],
    })

    async function started() {
      const id = await publish(agentFlow())
      const issue = await ticket()
      const run = await runOn(id, issue.id)
      expect(statusOf(run).a).toBe('waiting')
      const row = await db()('issues').where({ id: issue.id }).first()
      expect(row.assignedAgentId).toBe(agentId)
      expect(row.factoryState).not.toBe('untracked')
      return { run, issue }
    }

    it('assigns the agent, starts the work, and continues when it finishes', async () => {
      const { run, issue } = await started()
      const before = world().notifications.length
      await handleWorkflowEvent(harness.deps, { issueId: issue.id, event: { kind: 'agent.finished', result: 'succeeded' } })
      await drain()
      const after = await refresh(run.id)
      expect(after.status).toBe('succeeded')
      expect(world().notifications.length).toBe(before + 1)
      expect(world().notifications.at(-1)?.markdown).toBe('Done: succeeded')
    })

    it('waits for an agent outside the pipeline, then carries on', async () => {
      const { archetype } = await admin.ok('POST', '/api/archetypes', { name: 'Researcher', role: 'other', systemPrompt: 'Dig in.' })
      const { agent } = await admin.ok('POST', '/api/agents', {
        handle: 'researcher-1',
        displayName: 'Researcher One',
        archetypeId: archetype.id,
        runtime: 'claude',
        policy: { mode: 'full' },
      })
      await retireWorkflows()
      const issue = await ticket()
      const id = await publish({
        ...agentFlow(),
        nodes: agentFlow().nodes.map((node) => (node.id === 'a' ? block('a', 'agent.run', { agentId: agent.id }) : node)),
      })
      const run = await runOn(id, issue.id)
      expect(statusOf(run).a).toBe('waiting')
      const started = await db()('runs').where({ issueId: issue.id }).first()
      expect(started).toMatchObject({ phase: 'task', agentId: agent.id })

      await advanceIssue(db(), issue.id, { type: 'run.finished', result: 'completed' })
      await drain()
      expect(statusOf(await refresh(run.id))).toMatchObject({ a: 'succeeded', ok: 'succeeded', bad: 'skipped' })
    })

    it('hears about it from the pipeline itself', async () => {
      const { run, issue } = await started()
      await advanceIssue(db(), issue.id, { type: 'cancel' })
      await drain()
      expect(statusOf(await refresh(run.id))).toMatchObject({ a: 'failed', ok: 'skipped', bad: 'succeeded' })
    })

    it('takes the failure output when the agent fails', async () => {
      const { run, issue } = await started()
      await handleWorkflowEvent(harness.deps, { issueId: issue.id, event: { kind: 'agent.finished', result: 'failed' } })
      await drain()
      expect(statusOf(await refresh(run.id))).toMatchObject({ a: 'failed', ok: 'skipped', bad: 'succeeded' })
    })

    it('notices a finished agent even if the event was missed', async () => {
      const { run, issue } = await started()
      await db()('domain_events').whereNull('processedAt').update({ processedAt: new Date() })
      await db()('issues').where({ id: issue.id }).update({ factoryState: 'failed' })
      await sweepWorkflows(harness.deps)
      await drain()
      expect(statusOf(await refresh(run.id))).toMatchObject({ a: 'failed', bad: 'succeeded' })
    })

    it('refuses a ticket that is closed in the tracker', async () => {
      const id = await publish(agentFlow())
      const issue = await ticket()
      await db()('issues').where({ id: issue.id }).update({ trackerStateType: 'completed' })
      const run = await runOn(id, issue.id)
      expect(statusOf(run)).toMatchObject({ a: 'failed', bad: 'succeeded' })
      expect(run.steps.find((step: { nodeId: string }) => step.nodeId === 'a').error).toContain('closed')
    })

    const askFlow = (config: Record<string, unknown>) => ({
      nodes: [
        block('t', 'trigger.manual'),
        block('p', 'agent.prompt', { agentId, ...config }),
        block('ok', 'slack.send_message', slack('Answer: {{steps.p.text}}')),
        block('bad', 'slack.send_message', slack('No answer')),
      ],
      edges: [link('t', 'p'), link('p', 'ok'), link('p', 'bad', 'failed')],
    })

    async function asked(config: Record<string, unknown>) {
      const issue = await ticket()
      const run = await runOn(await publish(askFlow(config)), issue.id)
      expect(statusOf(run).p).toBe('waiting')
      const step = run.steps.find((item: { nodeId: string }) => item.nodeId === 'p')
      const row = await db()('runs').where({ id: step.output.runId }).first()
      return { run, issue, row, step }
    }

    it('asks an agent with the block’s prompt, skills, and model, outside the pipeline', async () => {
      const { skill } = await admin.ok('POST', '/api/skills', { slug: 'security-review', name: 'Security review', markdown: 'Look for injection.' })
      const { issue, row, step } = await asked({ prompt: 'Review {{issue.identifier}} for security.', skillIds: [skill.id], model: 'claude-other' })
      expect(row).toMatchObject({ phase: 'prompt', state: 'queued', issueId: issue.id, agentId, model: 'claude-other', pipelineStep: null })
      expect(row.trigger).toMatchObject({ nodeId: 'p', prompt: `Review ${issue.identifier} for security.`, post: true })
      expect(row.agentSnapshot.model).toBe('claude-other')
      expect(row.agentSnapshot.skills.map((item: { name: string }) => item.name)).toContain('Security review')
      expect(step.output.url).toContain(`/runs/${row.id}`)
      const ticketRow = await db()('issues').where({ id: issue.id }).first()
      expect(ticketRow).toMatchObject({ factoryState: 'untracked', lockedByRunId: row.id, assignedAgentId: null })
    })

    it('continues with the answer when the run succeeds', async () => {
      const { run, row } = await asked({ prompt: 'Is it safe?', post: 'none' })
      expect(row.trigger.post).toBe(false)
      await sweepWorkflows(harness.deps)
      expect(statusOf(await refresh(run.id)).p).toBe('waiting')
      await db()('runs')
        .where({ id: row.id })
        .update({ state: 'succeeded', structuredOutput: JSON.stringify({ summary: 'Safe to merge' }) })
      await sweepWorkflows(harness.deps)
      await drain()
      const after = await refresh(run.id)
      expect(statusOf(after)).toMatchObject({ p: 'succeeded', ok: 'succeeded', bad: 'skipped' })
      expect(world().notifications.at(-1)?.markdown).toBe('Answer: Safe to merge')
    })

    it('takes the failure output when the run fails', async () => {
      const { run, row } = await asked({ prompt: 'Is it safe?' })
      await db()('runs')
        .where({ id: row.id })
        .update({ state: 'failed', error: JSON.stringify({ message: 'Out of budget' }) })
      await sweepWorkflows(harness.deps)
      await drain()
      const after = await refresh(run.id)
      expect(statusOf(after)).toMatchObject({ p: 'failed', ok: 'skipped', bad: 'succeeded' })
      expect(after.steps.find((item: { nodeId: string }) => item.nodeId === 'p').error).toBe('Out of budget')
    })

    it('queues behind a run that has the ticket, and stops its run when the workflow run is cancelled', async () => {
      const issue = await ticket()
      const [holder] = await db()('runs')
        .insert({
          orgId: (await db()('issues').where({ id: issue.id }).first()).orgId,
          issueId: issue.id,
          agentId,
          agentSnapshot: '{}',
          phase: 'implement',
          runtime: 'claude',
        })
        .returning('id')
      await db()('issues').where({ id: issue.id }).update({ lockedByRunId: holder.id })
      const run = await runOn(await publish(askFlow({ prompt: 'Wait your turn.' })), issue.id)
      const runId = run.steps.find((item: { nodeId: string }) => item.nodeId === 'p').output.runId
      expect((await db()('issues').where({ id: issue.id }).first()).lockedByRunId).toBe(holder.id)

      await admin.ok('POST', `/api/workflow-runs/${run.id}/cancel`)
      expect((await db()('runs').where({ id: runId }).first()).state).toBe('cancelled')
      expect((await refresh(run.id)).status).toBe('cancelled')
    })

    it('fails with a clear reason when a skill is gone or no agent can be found', async () => {
      const issue = await ticket()
      const gone = await runOn(await publish(askFlow({ prompt: 'Hi', skillIds: ['00000000-0000-4000-8000-000000000000'] })), issue.id)
      expect(gone.steps.find((item: { nodeId: string }) => item.nodeId === 'p').error).toContain('skills')
      const other = await ticket()
      const nobody = await runOn(await publish(askFlow({ prompt: 'Hi', agentId: undefined })), other.id)
      expect(nobody.steps.find((item: { nodeId: string }) => item.nodeId === 'p').error).toContain('no agent')
    })

    it('starts a workflow when an agent finishes', async () => {
      await retireWorkflows()
      const id = await publish(
        {
          nodes: [block('t', 'trigger.agent_finished', { result: 'succeeded' }), block('s', 'slack.send_message', slack('finished'))],
          edges: [link('t', 's')],
        },
        { enabled: true },
      )
      const issue = await ticket()
      await db()('issues').where({ id: issue.id }).update({ factoryState: 'active' })
      await handleWorkflowEvent(harness.deps, { issueId: issue.id, event: { kind: 'agent.finished', result: 'succeeded' } })
      await drain()
      const { runs } = await admin.ok('GET', `/api/workflows/${id}/runs`)
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe('succeeded')
      await retireWorkflows()
    })
  })

  describe('triggers', () => {
    const notifyOn = (type: string, config: Record<string, unknown> = {}) => ({
      nodes: [block('t', type, config), block('s', 'slack.send_message', slack('{{trigger.kind}} on {{issue.identifier}}'))],
      edges: [link('t', 's')],
    })
    const runsOf = async (id: string) => (await admin.ok('GET', `/api/workflows/${id}/runs`)).runs as { issueId: string; status: string }[]
    const projectRow = async () => db()('projects').where({ id: projectId }).first()
    const moveInTracker = async (issue: { trackerIssueId: string }, stateId: string, stateName: string) => {
      const next = world().touch(world().issues.get(issue.trackerIssueId) as TrackerIssue, { stateId, stateName })
      await applyTrackerIssue(harness.deps, await projectRow(), next)
      await drain()
    }

    beforeAll(retireWorkflows)

    it('fires on a real status change only while enabled, and filters by status', async () => {
      const id = await publish(notifyOn('trigger.status_changed', { to: 'Done' }))
      const issue = await ticket()
      await moveInTracker(issue, 'st-done', 'Done')
      expect(await runsOf(id)).toHaveLength(0)

      await admin.ok('POST', `/api/workflows/${id}/enabled`, { enabled: true })
      await moveInTracker(issue, 'st-progress', 'In Progress')
      expect(await runsOf(id)).toHaveLength(0)
      await moveInTracker(issue, 'st-done', 'Done')
      expect(await runsOf(id)).toHaveLength(1)
      expect(world().notifications.at(-1)?.markdown).toContain('status.changed on')
      await retireWorkflows()
    })

    it('fires when the factory itself moves a ticket', async () => {
      const id = await publish(notifyOn('trigger.status_changed', { to: 'In Review' }), { enabled: true })
      const issue = await ticket()
      await setTrackerState(harness.deps, { issueId: issue.id, key: 'in_review' })
      await drain()
      expect(await runsOf(id)).toHaveLength(1)

      const echoed = world().issues.get(issue.trackerIssueId)
      await applyTrackerIssue(harness.deps, await projectRow(), {
        ...(echoed as NonNullable<typeof echoed>),
        updatedAt: new Date(Date.now() + 2000).toISOString(),
      })
      await drain()
      expect(await runsOf(id)).toHaveLength(1)
      await retireWorkflows()
    })

    it('does not re-fire on status a workflow set itself', async () => {
      const id = await publish(
        { nodes: [block('t', 'trigger.status_changed'), block('s', 'tracker.set_status', { status: 'In Review' })], edges: [link('t', 's')] },
        { enabled: true },
      )
      const issue = await ticket()
      await moveInTracker(issue, 'st-progress', 'In Progress')
      const runs = await runsOf(id)
      expect(runs).toHaveLength(1)
      expect(runs[0]?.status).toBe('succeeded')
      const echoed = world().issues.get(issue.trackerIssueId)
      await applyTrackerIssue(harness.deps, await projectRow(), {
        ...(echoed as NonNullable<typeof echoed>),
        updatedAt: new Date(Date.now() + 3000).toISOString(),
      })
      await drain()
      expect(await runsOf(id)).toHaveLength(1)
      await retireWorkflows()
    })

    it('does not re-fire when the webhook for its own change gets here before the mirror updates', async () => {
      const id = await publish(
        { nodes: [block('t', 'trigger.status_changed'), block('s', 'tracker.set_status', { status: 'In Review' })], edges: [link('t', 's')] },
        { enabled: true },
      )
      const issue = await ticket()
      await moveInTracker(issue, 'st-progress', 'In Progress')
      expect(await runsOf(id)).toHaveLength(1)
      await db()('issues').where({ id: issue.id }).update({ trackerStateId: 'st-progress', trackerStateName: 'In Progress' })
      const echoed = world().issues.get(issue.trackerIssueId) as TrackerIssue
      expect(echoed.stateId).toBe('st-review')
      await applyTrackerIssue(harness.deps, await projectRow(), { ...echoed, updatedAt: new Date(Date.now() + 4000).toISOString() })
      await drain()
      expect(await runsOf(id)).toHaveLength(1)
      await retireWorkflows()
    })

    it('fires once for a ticket made in the UI, even when the webhook gets here too', async () => {
      const id = await publish(notifyOn('trigger.issue_created'), { enabled: true })
      const issue = await ticket('New work')
      const created = world().issues.get(issue.trackerIssueId) as NonNullable<
        ReturnType<typeof world>['issues'] extends Map<string, infer T> ? T : never
      >
      await applyTrackerIssue(harness.deps, await projectRow(), { ...created, updatedAt: new Date(Date.now() + 1000).toISOString() })
      await drain()
      expect((await runsOf(id)).filter((run) => run.issueId === issue.id)).toHaveLength(1)
      await retireWorkflows()
    })

    it('fires for a ticket made in the tracker, but not one a project import brings in', async () => {
      const id = await publish(notifyOn('trigger.issue_created'), { enabled: true })
      const fresh = world().addIssue({ title: 'Typed in Linear' })
      await applyTrackerIssue(harness.deps, await projectRow(), fresh)
      await drain()
      expect(await runsOf(id)).toHaveLength(1)
      const imported = world().addIssue({ title: 'Already there' })
      await applyTrackerIssue(harness.deps, await projectRow(), imported, { announce: false })
      await drain()
      expect(await runsOf(id)).toHaveLength(1)
      const closed = world().addIssue({ title: 'Old and closed', stateType: 'completed', stateName: 'Done', stateId: 'st-done' })
      await applyTrackerIssue(harness.deps, await projectRow(), closed)
      await drain()
      expect(await runsOf(id)).toHaveLength(1)
      await retireWorkflows()
    })

    it('respects project scope', async () => {
      const id = await publish(notifyOn('trigger.issue_created'), { enabled: true, projectId })
      await ticket('Elsewhere', otherProjectId)
      expect(await runsOf(id)).toHaveLength(0)
      await ticket('Here', projectId)
      expect(await runsOf(id)).toHaveLength(1)
      await retireWorkflows()
    })

    it('reports labels people add, not the labels that assign agents', async () => {
      const id = await publish(notifyOn('trigger.label_added', { label: 'bug' }), { enabled: true })
      const issue = await ticket()
      const project = await projectRow()
      await db()('projects')
        .where({ id: projectId })
        .update({ agentLabels: JSON.stringify({ 'eng-1': 'label-agent' }) })
      const next = world().touch(world().issues.get(issue.trackerIssueId) as TrackerIssue, {
        labels: [{ id: 'label-agent', name: 'bug', parentId: null }],
      })
      await applyTrackerIssue(harness.deps, { ...project, agentLabels: { 'eng-1': 'label-agent' } }, next)
      await drain()
      expect(await runsOf(id)).toHaveLength(0)
      await db()('projects')
        .where({ id: projectId })
        .update({ agentLabels: JSON.stringify({}) })
      const labelled = world().touch(world().issues.get(issue.trackerIssueId) as TrackerIssue, {
        labels: [{ id: 'l2', name: 'Bug', parentId: null }],
      })
      await applyTrackerIssue(harness.deps, await projectRow(), labelled)
      await drain()
      expect(await runsOf(id)).toHaveLength(1)
      await retireWorkflows()
    })

    it('stops firing once deleted', async () => {
      const id = await publish(notifyOn('trigger.issue_created'), { enabled: true })
      expect((await admin.request('DELETE', `/api/workflows/${id}`)).status).toBe(200)
      expect((await admin.request('GET', `/api/workflows/${id}`)).status).toBe(404)
      await ticket()
      const count = await db()('workflow_runs').where({ workflowId: id }).count('* as count').first()
      expect(Number(count?.count)).toBe(0)
    })

    it('handles the same event only once', async () => {
      const id = await publish(notifyOn('trigger.issue_created'), { enabled: true })
      const issue = await ticket()
      const countBefore = (await runsOf(id)).length
      const sameEvent = { issueId: issue.id, event: { kind: 'issue.created' } as const, eventId: 'de-1' }
      await handleWorkflowEvent(harness.deps, sameEvent)
      await drain()
      await handleWorkflowEvent(harness.deps, sameEvent)
      await drain()
      expect(await runsOf(id)).toHaveLength(countBefore + 1)
      await retireWorkflows()
    })
  })

  describe('runaway protection', () => {
    beforeAll(retireWorkflows)

    it('does not let a ticket-created workflow feed itself', async () => {
      const id = await publish(
        {
          nodes: [block('t', 'trigger.issue_created'), block('make', 'tracker.create_issue', { title: 'Child of {{issue.identifier}}' })],
          edges: [link('t', 'make')],
        },
        { enabled: true },
      )
      const issue = await ticket('Root')
      const child = (await db()('issues').where('title', `Child of ${issue.identifier}`).first()) as { trackerIssueId: string; projectId: string }
      expect(child).toBeTruthy()
      const webhook = world().issues.get(child.trackerIssueId) as Parameters<typeof applyTrackerIssue>[2]
      await db()('issues').where({ trackerIssueId: child.trackerIssueId }).delete()
      await applyTrackerIssue(harness.deps, await db()('projects').where({ id: projectId }).first(), webhook)
      await drain()
      expect(await db()('workflow_runs').where({ workflowId: id })).toHaveLength(1)
      await retireWorkflows()
    })

    it('stops tickets creating tickets after a few generations', async () => {
      const id = await publish({
        nodes: [block('t', 'trigger.manual'), block('make', 'tracker.create_issue', { title: 'Next' })],
        edges: [link('t', 'make')],
      })
      const issue = await ticket()
      await db()('issues').where({ id: issue.id }).update({ workflowDepth: MAX_CREATED_TICKET_DEPTH })
      const run = await runOn(id, issue.id)
      expect(run.status).toBe('failed')
      expect(run.error).toContain('will not create another')
    })

    it('caps automatic runs per ticket and leaves a trace', async () => {
      const id = await publish(
        { nodes: [block('t', 'trigger.status_changed'), block('c', 'tracker.comment', { body: 'x' })], edges: [link('t', 'c')] },
        { enabled: true },
      )
      const issue = await ticket()
      for (let index = 0; index < MAX_RUNS_PER_TICKET_PER_HOUR + 2; index++) {
        await handleWorkflowEvent(harness.deps, {
          issueId: issue.id,
          event: { kind: 'status.changed', from: 'A', to: `S${index}` },
          eventId: `cap-${index}`,
        })
        await drain()
      }
      expect(await db()('workflow_runs').where({ workflowId: id })).toHaveLength(MAX_RUNS_PER_TICKET_PER_HOUR)
      expect(await db()('audit_log').where({ action: 'workflow.throttled', targetId: issue.id })).not.toHaveLength(0)
      await retireWorkflows()
    })

    it('does not let an active run be re-triggered by its own agent finishing', async () => {
      const { agent } = await admin.ok('POST', '/api/agents', {
        handle: 'eng-2',
        displayName: 'Eng 2',
        archetypeId: await engineerArchetype(),
        systemPrompt: 'Build',
        policy: { mode: 'edit', allow: [], deny: [], requireApproval: [], networkAccess: true },
        runtime: 'claude',
      })
      const id = await publish(
        {
          nodes: [block('t', 'trigger.agent_finished', { result: 'failed' }), block('a', 'agent.run', { agentId: agent.id })],
          edges: [link('t', 'a')],
        },
        { enabled: true },
      )
      const issue = await ticket()
      await handleWorkflowEvent(harness.deps, { issueId: issue.id, event: { kind: 'agent.finished', result: 'failed' }, eventId: 'loop-1' })
      await drain()
      const runs = () => db()('workflow_runs').where({ workflowId: id })
      expect(await runs()).toHaveLength(1)
      await handleWorkflowEvent(harness.deps, { issueId: issue.id, event: { kind: 'agent.finished', result: 'failed' }, eventId: 'loop-2' })
      await drain()
      expect(await runs()).toHaveLength(1)
      expect((await runs())[0].status).toBe('failed')
      await retireWorkflows()
    })
  })

  describe('plugin blocks', () => {
    const secret = 'blocks-secret-0123456789'
    const calls: BlockCall[] = []
    let server: Server
    let otherServer: Server
    let pluginId: string
    let otherId: string
    let orgId: string
    const plugin = definePlugin({
      name: 'Chat',
      version: '1.0.0',
      blocks: [
        {
          key: 'post',
          title: 'Post to chat',
          description: 'Posts a message.',
          fields: [
            { key: 'channel', label: 'Channel', kind: 'select', dynamic: true, required: true },
            { key: 'text', label: 'Text', kind: 'template', required: true },
          ],
          outputs: [
            { id: 'sent', label: 'Sent' },
            { id: 'muted', label: 'Muted' },
          ],
          provides: [{ key: 'ts', label: 'Message' }],
          run(call) {
            calls.push(call)
            if (call.config.text?.includes('boom')) throw new Error('The chat is down')
            return call.config.channel === 'muted' ? { handle: 'muted' } : { handle: 'sent', output: { ts: '1.5' } }
          },
          options: () => [
            { value: 'C1', label: '#general' },
            { value: 'muted', label: '#muted' },
          ],
        },
        {
          key: 'approve',
          title: 'Ask for approval',
          description: 'Waits for someone in chat.',
          run: () => ({ wait: true, output: { asked: 'yes' } }),
        },
      ],
      triggers: [
        {
          key: 'reacted',
          title: 'Reaction added',
          description: 'Someone reacted in chat.',
          fields: [{ key: 'emoji', label: 'Emoji', kind: 'text' }],
          provides: [{ key: 'who', label: 'Who reacted' }],
        },
      ],
    })

    const report = (body: Record<string, unknown>, from = pluginId, path = 'workflow-steps') => {
      const text = JSON.stringify({ orgId, ...body })
      const timestamp = String(Date.now())
      return harness.app.inject({
        method: 'POST',
        url: `/webhooks/plugins/${from}/${path}`,
        payload: text,
        headers: {
          'content-type': 'application/json',
          'x-factorix-timestamp': timestamp,
          'x-factorix-signature': signPlugin(secret, timestamp, text),
        },
      })
    }

    beforeAll(async () => {
      await retireWorkflows()
      server = await serve(plugin, { secret, port: 0, hostname: '127.0.0.1' })
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/factorix`
      pluginId = (await admin.ok('POST', '/api/plugins', { url, secret })).plugin.id
      orgId = (await admin.ok('GET', '/api/auth/me')).org.id
      const other = definePlugin({
        name: 'Other',
        version: '1.0.0',
        blocks: [{ key: 'noop', title: 'Noop', description: 'Nothing.', run: () => ({}) }],
      })
      otherServer = await serve(other, { secret, port: 0, hostname: '127.0.0.1' })
      const otherUrl = `http://127.0.0.1:${(otherServer.address() as AddressInfo).port}/factorix`
      otherId = (await admin.ok('POST', '/api/plugins', { url: otherUrl, secret })).plugin.id
    })
    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve))
      await new Promise((resolve) => otherServer.close(resolve))
    })

    it('offers its blocks only once the organization turned it on', async () => {
      expect(Object.keys((await admin.ok('GET', '/api/workflows/blocks')).blocks)).toEqual(SLACK_BLOCKS)
      expect((await admin.request('GET', `/api/workflows/blocks/options?type=${pluginBlockType(pluginId, 'post')}&field=channel`)).status).toBe(404)
      await admin.ok('PUT', `/api/plugins/${pluginId}/organization`, { enabled: true })
      const catalog = (await admin.ok('GET', '/api/workflows/blocks')).blocks
      expect(catalog[pluginBlockType(pluginId, 'post')]).toMatchObject({
        category: 'plugin',
        title: 'Post to chat',
        outputs: [{ id: 'sent' }, { id: 'muted' }, { id: 'failed', failure: true }],
        owner: { kind: 'plugin', id: pluginId, name: 'Chat' },
      })
      const options = `/api/workflows/blocks/options?type=${pluginBlockType(pluginId, 'post')}&field=channel`
      expect((await admin.ok('GET', options)).options).toEqual([
        { value: 'C1', label: '#general' },
        { value: 'muted', label: '#muted' },
      ])
      expect((await admin.request('GET', `/api/workflows/blocks/options?type=${pluginBlockType(pluginId, 'post')}&field=text`)).status).toBe(400)
    })

    it('starts the workflows built on its trigger, with no ticket, once per event', async () => {
      const type = pluginTriggerType(pluginId, 'reacted')
      expect((await admin.ok('GET', '/api/workflows/blocks')).blocks[type]).toMatchObject({
        category: 'trigger',
        ticketless: true,
        title: 'Reaction added',
      })
      const workflowId = await publish(
        {
          nodes: [
            block('r', type, { emoji: 'tada', emojiLabel: 'The editor keeps labels beside values' }),
            block('make', 'tracker.create_issue', { title: 'Thank {{steps.r.who}}', projectId }),
            block('tell', 'slack.send_message', slack('{{steps.r.who}} reacted, see {{steps.make.identifier}}')),
          ],
          edges: [link('r', 'make'), link('make', 'tell')],
        },
        { enabled: true },
      )
      const fire = async (data: Record<string, string>, eventId?: string) => {
        const response = await report({ trigger: 'reacted', data, ...(eventId ? { eventId } : {}) }, pluginId, 'workflow-triggers')
        await drain()
        return response
      }
      expect((await fire({ emoji: 'tada', who: 'Kim', extra: 'dropped' }, 'e1')).json()).toEqual({ started: 1 })
      expect((await fire({ emoji: 'tada', who: 'Kim' }, 'e1')).json()).toEqual({ started: 0 })
      expect((await fire({ emoji: 'thumbsup', who: 'Lee' })).json()).toEqual({ started: 0 })
      expect((await report({ trigger: 'nope', data: {} }, pluginId, 'workflow-triggers')).statusCode).toBe(404)

      const { runs } = await admin.ok('GET', `/api/workflows/${workflowId}/runs`)
      expect(runs).toMatchObject([{ issueId: null, issueIdentifier: null, status: 'succeeded' }])
      const run = await refresh(runs[0].id)
      expect(run.steps.find((step: { nodeId: string }) => step.nodeId === 'r').output).toEqual({ emoji: 'tada', who: 'Kim' })
      const made = run.steps.find((step: { nodeId: string }) => step.nodeId === 'make').output
      expect(await db()('issues').where({ id: made.id }).first()).toMatchObject({ title: 'Thank Kim', projectId })
      expect((world().notifications.at(-1) as { markdown: string }).markdown).toBe(`Kim reacted, see ${made.identifier}`)
      await db()('workflows').where({ id: workflowId }).update({ enabled: false })
    })
    it('runs a block with its templates filled and leaves through the output it picked', async () => {
      const post = pluginBlockType(pluginId, 'post')
      const id = await publish({
        nodes: [
          block('t', 'trigger.manual'),
          { ...block('p', post), config: { channel: 'C1', text: 'Done: {{issue.identifier}}' } },
          block('c', 'tracker.comment', { body: 'posted {{steps.p.ts}}' }),
          block('m', 'tracker.comment', { body: 'muted' }),
        ],
        edges: [link('t', 'p'), link('p', 'c', 'sent'), link('p', 'm', 'muted')],
      })
      const issue = await ticket()
      const run = await runOn(id, issue.id)
      expect(statusOf(run)).toMatchObject({ p: 'succeeded', c: 'succeeded', m: 'skipped' })
      expect(calls.at(-1)).toMatchObject({
        block: 'post',
        plugin: { id: pluginId },
        org: { id: orgId },
        run: { id: run.id, workflowId: id },
        nodeId: 'p',
        config: { channel: 'C1', text: `Done: ${issue.identifier}` },
        issue: { identifier: issue.identifier },
      })
      expect(world().comments.at(-1)?.body).toContain('posted 1.5')
    })

    it('fails the step with what the plugin said when the block throws', async () => {
      const id = await publish({
        nodes: [block('t', 'trigger.manual'), { ...block('p', pluginBlockType(pluginId, 'post')), config: { channel: 'C1', text: 'boom' } }],
        edges: [link('t', 'p')],
      })
      const run = await runOn(id, (await ticket()).id)
      expect(run.status).toBe('failed')
      expect(run.steps.find((step: { nodeId: string }) => step.nodeId === 'p').error).toContain('The chat is down')
    })

    it('holds a step until that plugin finishes it, and only that plugin', async () => {
      const id = await publish({
        nodes: [block('t', 'trigger.manual'), block('a', pluginBlockType(pluginId, 'approve')), block('c', 'tracker.comment', { body: 'approved' })],
        edges: [link('t', 'a'), link('a', 'c')],
      })
      const run = await runOn(id, (await ticket()).id)
      expect(statusOf(run)).toMatchObject({ a: 'waiting', c: 'pending' })
      await admin.ok('PUT', `/api/plugins/${otherId}/organization`, { enabled: true })
      expect((await report({ runId: run.id, nodeId: 'a' }, otherId)).statusCode).toBe(404)
      expect((await report({ runId: run.id, nodeId: 'a', handle: 'nowhere' })).statusCode).toBe(400)
      expect((await report({ runId: run.id, nodeId: 'a', output: { by: 'Kim' } })).statusCode).toBe(200)
      await drain()
      const done = await refresh(run.id)
      expect(done.status).toBe('succeeded')
      expect(done.steps.find((step: { nodeId: string }) => step.nodeId === 'a').output).toEqual({ asked: 'yes', by: 'Kim' })
      expect((await report({ runId: run.id, nodeId: 'a' })).statusCode).toBe(409)
    })

    it('fails a held step the plugin never reports, or reports as failed', async () => {
      const id = await publish({
        nodes: [block('t', 'trigger.manual'), block('a', pluginBlockType(pluginId, 'approve'))],
        edges: [link('t', 'a')],
      })
      const lost = await runOn(id, (await ticket()).id)
      await db()('workflow_steps')
        .where({ runId: lost.id, nodeId: 'a' })
        .update({ wakeAt: new Date(Date.now() - 1000) })
      await sweepWorkflows(harness.deps)
      await drain()
      expect((await refresh(lost.id)).status).toBe('failed')
      const refused = await runOn(id, (await ticket()).id)
      expect((await report({ runId: refused.id, nodeId: 'a', error: 'Kim said no' })).statusCode).toBe(200)
      await drain()
      const after = await refresh(refused.id)
      expect(after.status).toBe('failed')
      expect(after.steps.find((step: { nodeId: string }) => step.nodeId === 'a').error).toBe('Kim said no')
    })

    it('refuses to publish a block whose plugin the organization turned off', async () => {
      await admin.ok('PUT', `/api/plugins/${pluginId}/organization`, { enabled: false })
      const { workflow } = await admin.ok('POST', '/api/workflows', {
        name: 'Off',
        definition: { nodes: [block('t', 'trigger.manual'), block('a', pluginBlockType(pluginId, 'approve'))], edges: [link('t', 'a')] },
      })
      const refused = await admin.request('POST', `/api/workflows/${workflow.id}/publish`)
      expect(refused.status).toBe(422)
      expect(JSON.stringify(refused.body)).toContain('plugin behind this block')
      expect(Object.keys((await admin.ok('GET', '/api/workflows/blocks')).blocks)).toEqual([...SLACK_BLOCKS, pluginBlockType(otherId, 'noop')])
    })
  })

  describe('slack events', () => {
    const SECRET = 'slack-signing-secret'
    const send = (payload: unknown, secret = SECRET) => {
      const body = JSON.stringify(payload)
      const at = Math.floor(Date.now() / 1000)
      return harness.app.inject({
        method: 'POST',
        url: `/webhooks/slack/${slackId}`,
        payload: body,
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': String(at),
          'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${at}:${body}`).digest('hex')}`,
        },
      })
    }
    const mention = (id: string, event: Record<string, unknown> = {}) => ({
      type: 'event_callback',
      event_id: id,
      authorizations: [{ user_id: 'UAPP' }],
      event: { type: 'app_mention', channel: 'C1', user: 'U7', text: '<@UAPP> what broke?', ts: '17.5', ...event },
    })

    beforeAll(async () => {
      await retireWorkflows()
      await admin.ok('PUT', `/api/connections/${slackId}`, { config: { webhookSecret: SECRET } })
    })

    it('answers the URL check only when signed with the signing secret', async () => {
      expect((await send({ type: 'url_verification', challenge: 'c-1' }, 'wrong')).statusCode).toBe(401)
      expect((await send({ type: 'url_verification', challenge: 'c-1' })).json()).toEqual({ challenge: 'c-1' })
      const { connections } = await admin.ok('GET', '/api/connections')
      expect(connections.find((item: { id: string }) => item.id === slackId).webhookUrl).toContain(`/webhooks/slack/${slackId}`)
    })

    it('starts a workflow with no ticket on a mention, replies in its thread, and ignores bots and repeats', async () => {
      const workflowId = await publish(
        {
          nodes: [
            block('m', 'trigger.slack.mention', { connectionId: slackId, channel: 'C1' }),
            block('tell', 'slack.send_message', { ...slack('Looking at: {{steps.m.text}}'), thread: '{{steps.m.thread}}' }),
          ],
          edges: [link('m', 'tell')],
        },
        { enabled: true },
      )
      const before = world().notifications.length
      expect((await send(mention('Ev1'))).json()).toEqual({ ok: true })
      await drain()
      expect(world().notifications.slice(before)).toEqual([{ channelId: 'C1', markdown: 'Looking at: what broke?', threadId: '17.5' }])

      await send(mention('Ev1'))
      await send(mention('Ev2', { bot_id: 'B1' }))
      await send(mention('Ev3', { channel: 'C2' }))
      await drain()
      expect(world().notifications.length).toBe(before + 1)
      const { runs } = await admin.ok('GET', `/api/workflows/${workflowId}/runs`)
      expect(runs).toMatchObject([{ issueId: null, status: 'succeeded' }])
    })

    it('starts on a direct message when pinned to them, and replies where each message was posted', async () => {
      await retireWorkflows()
      const replying = (trigger: Node) => ({
        nodes: [trigger, block('tell', 'slack.send_message', { ...slack('Got: {{steps.m.text}}'), channel: 'reply' })],
        edges: [link('m', 'tell')],
      })
      await publish(replying(block('m', 'trigger.slack.message', { connectionId: slackId, channel: 'dm' })), { enabled: true })
      await publish(replying(block('m', 'trigger.slack.mention', { connectionId: slackId, channel: 'any' })), { enabled: true })
      const direct = (id: string, event: Record<string, unknown> = {}) => ({
        type: 'event_callback',
        event_id: id,
        authorizations: [{ user_id: 'UAPP' }],
        event: { type: 'message', channel: 'D9', channel_type: 'im', user: 'U7', text: 'hello', ts: '18.1', ...event },
      })

      const before = world().notifications.length
      await send(direct('Ev20'))
      await send(direct('Ev21', { channel: 'C1', channel_type: 'channel', text: 'not for the app' }))
      await send(direct('Ev22', { thread_ts: '18.0', ts: '18.2', text: 'in a thread' }))
      await send(mention('Ev23', { channel: 'C5' }))
      await drain()
      const sent = world().notifications.slice(before)
      expect(sent).toHaveLength(3)
      expect(sent).toContainEqual({ channelId: 'D9', markdown: 'Got: hello' })
      expect(sent).toContainEqual({ channelId: 'D9', markdown: 'Got: in a thread', threadId: '18.0' })
      expect(sent).toContainEqual({ channelId: 'C5', markdown: 'Got: what broke?', threadId: '17.5' })
    })

    it('starts only on the people it names', async () => {
      await retireWorkflows()
      const workflowId = await publish(
        {
          nodes: [
            block('m', 'trigger.slack.mention', { connectionId: slackId, channel: 'any', from: ['U8'], fromNames: ['Grace'] }),
            block('tell', 'slack.send_message', { ...slack('Hi {{steps.m.user}}'), channel: 'reply' }),
          ],
          edges: [link('m', 'tell')],
        },
        { enabled: true },
      )
      await send(mention('Ev30'))
      await send(mention('Ev31', { user: 'U8' }))
      await drain()
      const { runs } = await admin.ok('GET', `/api/workflows/${workflowId}/runs`)
      expect(runs).toHaveLength(1)
      expect((await refresh(runs[0].id)).steps.find((step: { nodeId: string }) => step.nodeId === 'm').output).toMatchObject({ user: 'U8' })
    })

    it('fails a reply in a run that no Slack message started', async () => {
      const issue = await ticket()
      const run = await runOn(
        await publish({
          nodes: [block('t', 'trigger.manual'), block('tell', 'slack.send_message', { ...slack('Hi'), channel: 'reply' })],
          edges: [link('t', 'tell')],
        }),
        issue.id,
      )
      expect(run.steps.find((step: { nodeId: string }) => step.nodeId === 'tell').error).toContain('nothing to reply to')
    })

    it('asks an agent about a mention, reading the workflow’s project or the block’s, and replies with its answer', async () => {
      await retireWorkflows()
      const { agent } = await admin.ok('POST', '/api/agents', {
        handle: 'answers-1',
        displayName: 'Answers',
        archetypeId: await engineerArchetype(),
        systemPrompt: 'Answer',
        policy: { mode: 'edit', allow: [], deny: [], requireApproval: [], networkAccess: true },
        runtime: 'claude',
      })
      const flow = (channel: string, config: Record<string, unknown> = {}) => ({
        nodes: [
          block('m', 'trigger.slack.mention', { connectionId: slackId, channel }),
          block('ask', 'agent.prompt', { agentId: agent.id, prompt: 'Asked in Slack: {{steps.m.text}}', post: 'none', ...config }),
          block('tell', 'slack.send_message', { ...slack('{{steps.ask.text}}', channel), thread: '{{steps.m.thread}}' }),
        ],
        edges: [link('m', 'ask'), link('ask', 'tell')],
      })
      const onProject = await publish(flow('C1'), { enabled: true, projectId })
      const onBlock = await publish(flow('C2', { projectId: otherProjectId }), { enabled: true })

      await send(mention('Ev10'))
      await send(mention('Ev11', { channel: 'C2', text: '<@UAPP> and here?' }))
      await drain()
      const asked = async (workflowId: string) => {
        const { runs } = await admin.ok('GET', `/api/workflows/${workflowId}/runs`)
        expect(runs).toMatchObject([{ issueId: null, status: 'running' }])
        const run = await refresh(runs[0].id)
        const step = run.steps.find((item: { nodeId: string }) => item.nodeId === 'ask')
        expect(step.status).toBe('waiting')
        return { run, row: await db()('runs').where({ id: step.output.runId }).first() }
      }
      const first = await asked(onProject)
      expect(first.row).toMatchObject({ phase: 'prompt', state: 'queued', issueId: null, projectId, agentId: agent.id })
      expect(first.row.trigger).toMatchObject({ prompt: 'Asked in Slack: what broke?', post: false })
      const second = await asked(onBlock)
      expect(second.row).toMatchObject({ issueId: null, projectId: otherProjectId })

      const before = world().notifications.length
      await db()('runs')
        .where({ id: first.row.id })
        .update({ state: 'succeeded', structuredOutput: JSON.stringify({ summary: 'The deploy broke it' }) })
      await sweepWorkflows(harness.deps)
      await drain()
      expect(statusOf(await refresh(first.run.id))).toMatchObject({ ask: 'succeeded', tell: 'succeeded' })
      expect(world().notifications.slice(before)).toEqual([{ channelId: 'C1', markdown: 'The deploy broke it', threadId: '17.5' }])
    })
  })

  describe('slack connections', () => {
    it('never returns the token, tests it, and lists channels', async () => {
      const { connections } = await admin.ok('GET', '/api/connections')
      const slackConnection = connections.find((item: { id: string }) => item.id === slackId)
      expect(JSON.stringify(slackConnection)).not.toContain('xoxb-secret')
      expect(slackConnection.hasSecret).toBe(true)
      expect((await admin.ok('POST', `/api/connections/${slackId}/test`)).message).toContain('factorix in Acme')
      expect((await admin.ok('GET', `/api/connections/${slackId}/channels`)).channels.map((channel: { name: string }) => channel.name)).toEqual([
        'engineering',
        'alerts',
      ])
      expect((await admin.request('GET', `/api/connections/${linearId}/channels`)).status).toBe(400)
      expect((await admin.ok('GET', `/api/connections/${slackId}/people`)).people).toEqual([
        { id: 'U7', name: 'Ada' },
        { id: 'U8', name: 'Grace' },
      ])
      expect((await admin.request('GET', `/api/connections/${linearId}/people`)).status).toBe(400)
    })
  })
})
