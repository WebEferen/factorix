import { json, type RunRow } from '@factorix/db'
import { RUNTIME_CAPABILITIES } from '@factorix/runtime'
import { adHocRunInput, cancelRunInput, decideApprovalInput, runMessageInput } from '@factorix/schemas'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../deps'
import { approvalDto, CLOSED_SQL, issueDto, RUN_LIST_COLUMNS, runDto } from '../dto'
import { writeAudit } from '../lib/audit'
import { requireAuth } from '../lib/auth'
import { runChannel } from '../lib/channels'
import { badRequest, conflict, notFound, parseBody } from '../lib/errors'
import { emit } from '../lib/outbox'
import { buildAgentSnapshot } from '../services/agents'
import { decideApproval } from '../services/approvals'
import { getConnection } from '../services/connections'
import { advanceIssue, requestRunCancel } from '../services/pipeline'
import { openSse, type RedisFanout } from '../sse'

export function runRoutes(app: FastifyInstance, deps: AppDeps, fanout: RedisFanout): void {
  const { db } = deps

  const listQuery = (orgId: string) =>
    db('runs')
      .leftJoin('issues', 'runs.issue_id', 'issues.id')
      .leftJoin('projects', 'runs.project_id', 'projects.id')
      .where({ 'runs.org_id': orgId })
      .select(RUN_LIST_COLUMNS(db))

  const loadRun = async (orgId: string, id: string): Promise<RunRow> => {
    const row = await db<RunRow>('runs').where({ id, orgId }).first()
    if (!row) throw notFound('Run')
    return row
  }

  app.get('/api/runs', async (request) => {
    const { account } = requireAuth(request)
    const query = request.query as { state?: string; agentId?: string; issueId?: string; limit?: string; before?: string }
    const builder = listQuery(account.orgId)
      .orderBy('runs.created_at', 'desc')
      .limit(Math.min(Number(query.limit ?? 100), 300))
    if (query.state) builder.whereIn('runs.state', query.state.split(','))
    if (query.agentId) builder.where({ 'runs.agent_id': query.agentId })
    if (query.issueId) builder.where({ 'runs.issue_id': query.issueId })
    if (query.before) builder.where('runs.created_at', '<', query.before)
    return { runs: (await builder).map(runDto) }
  })

  app.post('/api/runs', { config: { scope: 'runs' } }, async (request) => {
    const { account } = requireAuth(request)
    const input = parseBody(adHocRunInput, request.body)
    const agent = await db('agents')
      .join('accounts', 'agents.account_id', 'accounts.id')
      .where({ 'agents.account_id': input.agentId, 'agents.org_id': account.orgId })
      .select('agents.*', 'accounts.handle', 'accounts.display_name', 'accounts.status')
      .first()
    if (!agent) throw notFound('Agent')
    if (agent.status !== 'active') throw badRequest('That agent is disabled')
    if (input.scmConnectionId) await getConnection(db, account.orgId, input.scmConnectionId)
    const snapshot = await buildAgentSnapshot(db, agent)
    const run = await db.transaction(async (trx) => {
      const [row] = await trx<RunRow>('runs')
        .insert({
          orgId: account.orgId,
          agentId: agent.accountId,
          agentSnapshot: json(snapshot) as never,
          phase: 'ad_hoc',
          adHoc: json({ gitUrl: input.gitUrl, prompt: input.prompt, ref: input.ref, push: input.push }) as never,
          trigger: json({ scmConnectionId: input.scmConnectionId }) as never,
          createdBy: account.id,
          runtime: agent.runtime,
          model: agent.model,
        })
        .returning('*')
      await writeAudit(trx, {
        orgId: account.orgId,
        actorAccountId: account.id,
        actorKind: 'human',
        action: 'run.created',
        targetType: 'run',
        targetId: row?.id,
        metadata: { phase: 'ad_hoc', agent: agent.handle, push: input.push },
      })
      await emit(trx, account.orgId, { type: 'run.enqueue', runId: (row as RunRow).id })
      await emit(trx, account.orgId, { type: 'notify', kind: 'run', id: (row as RunRow).id })
      return row as RunRow
    })
    return { run: runDto(run) }
  })

  app.get('/api/runs/:id', async (request) => {
    const { account } = requireAuth(request)
    const row = await listQuery(account.orgId)
      .where({ 'runs.id': (request.params as { id: string }).id })
      .first()
    if (!row) throw notFound('Run')
    return { run: { ...runDto(row), capabilities: RUNTIME_CAPABILITIES[row.runtime as keyof typeof RUNTIME_CAPABILITIES] } }
  })

  app.get('/api/runs/:id/diff', async (request) => {
    const { account } = requireAuth(request)
    const row = await loadRun(account.orgId, (request.params as { id: string }).id)
    return { diff: row.diff ?? '' }
  })

  app.get('/api/runs/:id/events', async (request, reply) => {
    const { account } = requireAuth(request)
    const run = await loadRun(account.orgId, (request.params as { id: string }).id)
    const query = request.query as { after?: string }
    const lastEventId = request.headers['last-event-id']
    let lastSent = Number(lastEventId ?? query.after ?? 0)
    const sse = openSse(request, reply)

    // Subscribe before replaying, so nothing can fall in the gap. Duplicates are dropped by seq below.
    const queued: string[] = []
    let replayed = false
    const write = (raw: string) => {
      const message = JSON.parse(raw) as { kind: string; event?: { seq: number } }
      const seq = message.event?.seq ?? 0
      if (seq > 0) {
        if (seq <= lastSent) return
        lastSent = seq
        sse.send(raw, seq)
      } else {
        sse.send(raw)
      }
    }
    const unsubscribe = await fanout.subscribe(runChannel(run.id), (raw) => {
      if (replayed) write(raw)
      else queued.push(raw)
    })
    sse.onClose(unsubscribe)

    const rows = await db('run_events').where({ runId: run.id }).andWhere('seq', '>', lastSent).orderBy('seq')
    for (const row of rows) {
      sse.send(
        JSON.stringify({ kind: 'event', event: { ...row.payload, seq: row.seq, ts: new Date(row.ts).toISOString(), runId: row.runId } }),
        row.seq,
      )
      lastSent = row.seq
    }
    for (const raw of queued) write(raw)
    replayed = true
  })

  app.post('/api/runs/:id/cancel', { config: { scope: 'runs' } }, async (request) => {
    const { account } = requireAuth(request)
    const run = await loadRun(account.orgId, (request.params as { id: string }).id)
    const input = parseBody(cancelRunInput, request.body)
    await writeAudit(db, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'run.cancel_requested',
      targetType: 'run',
      targetId: run.id,
      metadata: { discard: input.discard },
    })
    if (run.issueId) {
      if (input.discard) await db('runs').where({ id: run.id }).update({ discardOnCancel: true })
      await advanceIssue(db, run.issueId, { type: 'cancel' })
    } else {
      await db.transaction((trx) => requestRunCancel(trx, run.id, `Cancelled by ${account.displayName}`, { discard: input.discard, by: account.id }))
    }
    return { ok: true }
  })

  app.post('/api/runs/:id/messages', { config: { scope: 'runs' } }, async (request) => {
    const { account } = requireAuth(request)
    const run = await loadRun(account.orgId, (request.params as { id: string }).id)
    if (!['preparing', 'running', 'waiting_approval'].includes(run.state)) throw conflict('This run is not accepting messages right now')
    const input = parseBody(runMessageInput, request.body)
    await db.transaction(async (trx) => {
      await trx('run_commands').insert({ runId: run.id, createdBy: account.id, payload: json({ type: 'message', text: input.text }) })
      await emit(trx, account.orgId, { type: 'run.ping', runId: run.id })
      await writeAudit(trx, {
        orgId: account.orgId,
        actorAccountId: account.id,
        actorKind: 'human',
        action: 'run.message_sent',
        targetType: 'run',
        targetId: run.id,
        metadata: { length: input.text.length },
      })
    })
    return { ok: true }
  })

  const approvalsQuery = (orgId: string) =>
    db('approvals')
      .leftJoin('issues', 'approvals.issue_id', 'issues.id')
      .leftJoin('runs', 'approvals.run_id', 'runs.id')
      .leftJoin('accounts', 'approvals.decided_by', 'accounts.id')
      .where({ 'approvals.org_id': orgId })
      .select(
        'approvals.*',
        'issues.identifier as issue_identifier',
        'issues.title as issue_title',
        db.raw(`runs.agent_snapshot->>'handle' AS agent_handle`),
        'accounts.display_name as decided_by_name',
      )

  app.get('/api/approvals', async (request) => {
    const { account } = requireAuth(request)
    const { status } = request.query as { status?: string }
    const builder = approvalsQuery(account.orgId).orderBy('approvals.requested_at', 'desc').limit(200)
    if (status) builder.where({ 'approvals.status': status })
    return { approvals: (await builder).map(approvalDto) }
  })

  app.post('/api/approvals/:id/decide', { config: { scope: 'approvals' } }, async (request) => {
    const { account } = requireAuth(request)
    const { id } = request.params as { id: string }
    await decideApproval(deps, account.orgId, id, account.id, parseBody(decideApprovalInput, request.body))
    return { ok: true }
  })

  app.get('/api/inbox', async (request) => {
    const { account } = requireAuth(request)
    const [approvals, failed] = await Promise.all([
      approvalsQuery(account.orgId).where({ 'approvals.status': 'pending' }).orderBy('approvals.requested_at', 'desc'),
      db('issues')
        .join('projects', 'issues.project_id', 'projects.id')
        .leftJoin('accounts', 'issues.assigned_agent_id', 'accounts.id')
        .where({ 'issues.org_id': account.orgId, 'issues.factory_state': 'failed' })
        .whereRaw(`NOT (${CLOSED_SQL})`)
        .orderBy('issues.updated_at', 'desc')
        .limit(50)
        .select('issues.*', 'projects.name as project_name', 'accounts.handle as assigned_agent_handle'),
    ])
    return { approvals: approvals.map(approvalDto), failedIssues: failed.map(issueDto) }
  })
}
