import { type IssueRow, json, type WorkflowRow, type WorkflowRunRow, type WorkflowStepRow } from '@factorix/db'
import { isTriggerBlock, validateWorkflow, type WorkflowDefinition, workflowEnabledInput, workflowInput, workflowRunInput } from '@factorix/schemas'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../deps'
import { workflowDto, workflowRunDetailDto, workflowRunDto } from '../dto'
import { writeAudit } from '../lib/audit'
import { requireAdmin, requireAuth } from '../lib/auth'
import { conflict, HttpError, notFound, parseBody } from '../lib/errors'
import { cancelWorkflowRun, startWorkflowRun } from '../services/workflows'

const RUN_COLUMNS = [
  'workflow_runs.*',
  'workflows.name as workflow_name',
  'issues.identifier as issue_identifier',
  'issues.title as issue_title',
  'accounts.display_name as started_by_name',
]

export function workflowRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps

  const listQuery = (orgId: string) =>
    db('workflows')
      .leftJoin('projects', 'workflows.project_id', 'projects.id')
      .where({ 'workflows.org_id': orgId })
      .whereNull('workflows.archived_at')
      .select(
        'workflows.*',
        'projects.name as project_name',
        db.raw('workflows.definition IS DISTINCT FROM workflows.published_definition AS has_unpublished_changes'),
        db.raw('(SELECT COUNT(*)::int FROM workflow_runs r WHERE r.workflow_id = workflows.id) AS run_count'),
        db.raw('(SELECT MAX(r.created_at) FROM workflow_runs r WHERE r.workflow_id = workflows.id) AS last_run_at'),
        db.raw('(SELECT r.status FROM workflow_runs r WHERE r.workflow_id = workflows.id ORDER BY r.created_at DESC LIMIT 1) AS last_run_status'),
      )

  const load = async (orgId: string, id: string) => {
    const row = await listQuery(orgId).where({ 'workflows.id': id }).first()
    if (!row) throw notFound('Workflow')
    return row
  }

  const checkProject = async (orgId: string, projectId: string | null) => {
    if (projectId && !(await db('projects').where({ id: projectId, orgId }).first())) throw notFound('Project')
  }

  const audit = (orgId: string, actorAccountId: string, action: string, id: string, metadata: Record<string, unknown>) =>
    writeAudit(db, { orgId, actorAccountId, actorKind: 'human', action, targetType: 'workflow', targetId: id, metadata })

  app.get('/api/workflows', async (request) => {
    const { account } = requireAuth(request)
    return { workflows: (await listQuery(account.orgId).orderBy('workflows.name')).map(workflowDto) }
  })

  app.post('/api/workflows', async (request) => {
    const { account } = requireAdmin(request)
    const input = parseBody(workflowInput, request.body)
    await checkProject(account.orgId, input.projectId)
    const [row] = (await db('workflows')
      .insert({
        orgId: account.orgId,
        projectId: input.projectId,
        name: input.name,
        description: input.description,
        definition: json(input.definition),
        createdBy: account.id,
      })
      .returning('id')) as { id: string }[]
    const id = (row as { id: string }).id
    await audit(account.orgId, account.id, 'workflow.created', id, { name: input.name })
    return { workflow: workflowDto(await load(account.orgId, id)) }
  })

  app.get('/api/workflows/:id', async (request) => {
    const { account } = requireAuth(request)
    return { workflow: workflowDto(await load(account.orgId, (request.params as { id: string }).id)) }
  })

  /** Saves the draft, and is called often. Nothing here changes what runs, so only publishing is audited as a change to behavior. */
  app.put('/api/workflows/:id', async (request) => {
    const { account } = requireAdmin(request)
    const { id } = request.params as { id: string }
    await load(account.orgId, id)
    const input = parseBody(workflowInput, request.body)
    await checkProject(account.orgId, input.projectId)
    await db('workflows')
      .where({ id })
      .update({
        name: input.name,
        description: input.description,
        projectId: input.projectId,
        definition: json(input.definition),
        updatedAt: db.fn.now(),
      })
    return { workflow: workflowDto(await load(account.orgId, id)) }
  })

  app.post('/api/workflows/:id/publish', async (request) => {
    const { account } = requireAdmin(request)
    const { id } = request.params as { id: string }
    const current = await load(account.orgId, id)
    const issues = validateWorkflow(current.definition as WorkflowDefinition)
    if (issues.length > 0) throw new HttpError(422, 'invalid_workflow', 'This workflow has problems to fix first', { issues })
    const version = (current.publishedVersion as number) + 1
    await db('workflows')
      .where({ id })
      .update({ publishedDefinition: json(current.definition), publishedVersion: version, publishedAt: db.fn.now(), updatedAt: db.fn.now() })
    await audit(account.orgId, account.id, 'workflow.published', id, { name: current.name, version, definition: current.definition })
    return { workflow: workflowDto(await load(account.orgId, id)) }
  })

  app.post('/api/workflows/:id/enabled', async (request) => {
    const { account } = requireAdmin(request)
    const { id } = request.params as { id: string }
    const current = await load(account.orgId, id)
    const { enabled } = parseBody(workflowEnabledInput, request.body)
    if (enabled && !current.publishedDefinition) throw conflict('Publish this workflow before turning it on')
    await db('workflows').where({ id }).update({ enabled, updatedAt: db.fn.now() })
    await audit(account.orgId, account.id, enabled ? 'workflow.enabled' : 'workflow.disabled', id, { name: current.name })
    return { workflow: workflowDto(await load(account.orgId, id)) }
  })

  app.delete('/api/workflows/:id', async (request) => {
    const { account } = requireAdmin(request)
    const { id } = request.params as { id: string }
    const current = await load(account.orgId, id)
    await db('workflows').where({ id }).update({ archivedAt: db.fn.now(), enabled: false, updatedAt: db.fn.now() })
    await audit(account.orgId, account.id, 'workflow.deleted', id, { name: current.name })
    return { ok: true }
  })

  /** Works while the workflow is off, so it can be tried before it reacts to anything by itself. */
  app.post('/api/workflows/:id/runs', async (request) => {
    const { account } = requireAuth(request)
    const { id } = request.params as { id: string }
    const workflow = (await load(account.orgId, id)) as WorkflowRow
    if (!workflow.publishedDefinition) throw conflict('Publish this workflow before running it')
    const { issueIds } = parseBody(workflowRunInput, request.body)
    const issues = await db<IssueRow>('issues').where({ orgId: account.orgId }).whereIn('id', issueIds)
    const start =
      workflow.publishedDefinition.nodes.find((node) => node.type === 'trigger.manual') ??
      workflow.publishedDefinition.nodes.find((node) => isTriggerBlock(node.type))
    if (!start) throw conflict('This workflow has nothing to start from')
    const started: string[] = []
    const skipped: { issueId: string; reason: string }[] = []
    for (const issueId of issueIds) {
      const issue = issues.find((item) => item.id === issueId)
      if (!issue) skipped.push({ issueId, reason: 'That ticket no longer exists' })
      else if (workflow.projectId && workflow.projectId !== issue.projectId)
        skipped.push({ issueId, reason: `${issue.identifier} is outside this workflow's project` })
      else {
        const run = await startWorkflowRun(db, { workflow, issue, nodeId: start.id, event: { kind: 'manual' }, startedBy: account.id })
        if (run) started.push(run.id)
        else skipped.push({ issueId, reason: `This workflow is already running on ${issue.identifier}` })
      }
    }
    return { started, skipped }
  })

  const runQuery = (orgId: string) =>
    db('workflow_runs')
      .join('workflows', 'workflow_runs.workflow_id', 'workflows.id')
      .join('issues', 'workflow_runs.issue_id', 'issues.id')
      .leftJoin('accounts', 'workflow_runs.started_by', 'accounts.id')
      .where({ 'workflow_runs.org_id': orgId })
      .select(RUN_COLUMNS)
      .orderBy('workflow_runs.created_at', 'desc')
      .limit(50)

  app.get('/api/workflows/:id/runs', async (request) => {
    const { account } = requireAuth(request)
    const { id } = request.params as { id: string }
    return { runs: (await runQuery(account.orgId).where({ 'workflow_runs.workflow_id': id })).map(workflowRunDto) }
  })

  app.get('/api/issues/:id/workflow-runs', async (request) => {
    const { account } = requireAuth(request)
    const { id } = request.params as { id: string }
    return { runs: (await runQuery(account.orgId).where({ 'workflow_runs.issue_id': id })).map(workflowRunDto) }
  })

  const loadRun = async (orgId: string, id: string) => {
    const run = await runQuery(orgId).where({ 'workflow_runs.id': id }).first()
    if (!run) throw notFound('Workflow run')
    return run as WorkflowRunRow & Record<string, unknown>
  }

  app.get('/api/workflow-runs/:id', async (request) => {
    const { account } = requireAuth(request)
    const { id } = request.params as { id: string }
    const run = await loadRun(account.orgId, id)
    return { run: workflowRunDetailDto(run, await db<WorkflowStepRow>('workflow_steps').where({ runId: id })) }
  })

  app.post('/api/workflow-runs/:id/cancel', async (request) => {
    const { account } = requireAuth(request)
    const { id } = request.params as { id: string }
    const run = await loadRun(account.orgId, id)
    await cancelWorkflowRun(db, run, account.id)
    return { run: workflowRunDetailDto(await loadRun(account.orgId, id), await db<WorkflowStepRow>('workflow_steps').where({ runId: id })) }
  })
}
