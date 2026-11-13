import { RetryLaterError, type TrackerIssue } from '@factorix/connectors'
import { initialBlockConfig, type WorkflowDefinition } from '@factorix/schemas'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { advanceIssue } from './services/pipeline'
import { relayDomainEvents } from './services/relay'
import { applyTrackerIssue, setTrackerState } from './services/tracker-sync'
import { MAX_CREATED_TICKET_DEPTH } from './services/workflow-blocks'
import { advanceWorkflowRun, executeWorkflowStep, handleWorkflowEvent, MAX_RUNS_PER_TICKET_PER_HOUR, sweepWorkflows } from './services/workflows'
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
          block('yes', 'notify.send', slack('Urgent: **{{issue.identifier}}** in {{project.name}} by {{workflow.name}}\n{{run.url}}')),
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
      expect(run.steps.find((step: { nodeId: string }) => step.nodeId === 'yes').output).toEqual({ url: expect.stringContaining('slack.test') })

      const cold = await ticket('Small tweak')
      const other = await runOn(id, cold.id)
      expect(statusOf(other)).toEqual({ t: 'succeeded', check: 'succeeded', yes: 'skipped', no: 'succeeded' })
      expect((await admin.ok('GET', `/api/issues/${cold.id}/workflow-runs`)).runs[0].id).toBe(other.id)
    })

    it('escapes ticket text but not the template it is placed in', async () => {
      const id = await publish({
        nodes: [block('t', 'trigger.manual'), block('s', 'notify.send', slack('**Ticket** [open]({{issue.url}}): {{issue.title}}'))],
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
          block('join', 'notify.send', slack('joined')),
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
          block('tell', 'notify.send', slack('Created {{steps.make.identifier}} at {{steps.make.url}}')),
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
      nodes: [block('t', 'trigger.manual'), block('s', 'notify.send', slack('hello')), block('c', 'tracker.comment', { body: 'sent' })],
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
        block('ok', 'notify.send', slack('Done: {{steps.a.result}}')),
        block('bad', 'notify.send', slack('Agent failed')),
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
        block('ok', 'notify.send', slack('Answer: {{steps.p.text}}')),
        block('bad', 'notify.send', slack('No answer')),
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
          nodes: [block('t', 'trigger.agent_finished', { result: 'succeeded' }), block('s', 'notify.send', slack('finished'))],
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
      nodes: [block('t', type, config), block('s', 'notify.send', slack('{{trigger.kind}} on {{issue.identifier}}'))],
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
    })
  })
})
