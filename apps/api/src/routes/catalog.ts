import type { ArchetypeRow, RuntimeModelRow, SkillRow } from '@factorix/db'
import { RUNTIME_CAPABILITIES, type RuntimeId } from '@factorix/runtime'
import { agentInput, archetypeInput, archetypeUpdateInput, skillInput } from '@factorix/schemas'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../deps'
import { archetypeDto, auditDto, skillDto } from '../dto'
import { writeAudit } from '../lib/audit'
import { requireAdmin, requireAuth } from '../lib/auth'
import { conflict, isForeignKeyViolation, isUniqueViolation, notFound, parseBody } from '../lib/errors'
import { emit } from '../lib/outbox'
import { createAgent, getAgent, listAgents, updateAgent } from '../services/agents'

const RUNTIME_LABELS: Record<RuntimeId, { label: string; defaultModel: string | null }> = {
  claude: { label: 'Claude', defaultModel: 'claude-opus-5-5' },
  codex: { label: 'Codex', defaultModel: null },
  scripted: { label: 'Scripted (no model)', defaultModel: null },
}

export function catalogRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, env } = deps

  app.get('/api/runtimes', async (request) => {
    requireAuth(request)
    const ids: RuntimeId[] = env.FACTORIX_ALLOW_SCRIPTED_RUNTIME ? ['claude', 'codex', 'scripted'] : ['claude', 'codex']
    const catalogs = await db<RuntimeModelRow>('runtime_models').whereIn('runtime', ids)
    return {
      runtimes: ids.map((id) => {
        const catalog = catalogs.find((row) => row.runtime === id)
        return {
          id,
          capabilities: RUNTIME_CAPABILITIES[id],
          ...RUNTIME_LABELS[id],
          defaultModel: catalog?.defaultModel ?? RUNTIME_LABELS[id].defaultModel,
          models: catalog?.models ?? [],
        }
      }),
    }
  })

  app.get('/api/agents', async (request) => ({ agents: await listAgents(db, requireAuth(request).account.orgId) }))

  app.get('/api/agents/:id', async (request) => ({
    agent: await getAgent(db, requireAuth(request).account.orgId, (request.params as { id: string }).id),
  }))

  app.post('/api/agents', async (request) => {
    const { account } = requireAuth(request)
    const id = await createAgent(deps, account.orgId, account.id, parseBody(agentInput, request.body))
    return { agent: await getAgent(db, account.orgId, id) }
  })

  app.put('/api/agents/:id', async (request) => {
    const { account } = requireAuth(request)
    const { id } = request.params as { id: string }
    await updateAgent(deps, account.orgId, account.id, id, parseBody(agentInput, request.body))
    return { agent: await getAgent(db, account.orgId, id) }
  })

  const agentsOfArchetypes = async (orgId: string, archetypeIds?: string[]) => {
    const query = db('agents')
      .join('accounts', 'agents.account_id', 'accounts.id')
      .where({ 'agents.org_id': orgId })
      .orderBy('accounts.display_name')
      .select('agents.archetype_id', 'accounts.id', 'accounts.display_name')
    if (archetypeIds) query.whereIn('agents.archetype_id', archetypeIds)
    const rows = (await query) as { archetypeId: string; id: string; displayName: string }[]
    return (archetypeId: string) => rows.filter((row) => row.archetypeId === archetypeId).map(({ id, displayName }) => ({ id, displayName }))
  }

  const duplicateArchetype = (name: string) => conflict(`An archetype called ${name} already exists`)

  app.get('/api/archetypes', async (request) => {
    const { orgId } = requireAuth(request).account
    const rows = await db<ArchetypeRow>('archetypes').where({ orgId }).orderBy('name')
    const agentsOf = await agentsOfArchetypes(orgId)
    return { archetypes: rows.map((row) => archetypeDto(row, agentsOf(row.id))) }
  })

  app.post('/api/archetypes', async (request) => {
    const { account } = requireAdmin(request)
    const input = parseBody(archetypeInput, request.body)
    try {
      const row = await db.transaction(async (trx) => {
        const [created] = await trx<ArchetypeRow>('archetypes')
          .insert({ orgId: account.orgId, ...input, createdBy: account.id })
          .returning('*')
        const archetype = created as ArchetypeRow
        await writeAudit(trx, {
          orgId: account.orgId,
          actorAccountId: account.id,
          actorKind: 'human',
          action: 'archetype.created',
          targetType: 'archetype',
          targetId: archetype.id,
          metadata: input,
        })
        await emit(trx, account.orgId, { type: 'notify', kind: 'agent', id: archetype.id })
        return archetype
      })
      return { archetype: archetypeDto(row, []) }
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateArchetype(input.name)
      throw error
    }
  })

  app.put('/api/archetypes/:id', async (request) => {
    const { account } = requireAdmin(request)
    const { id } = request.params as { id: string }
    const input = parseBody(archetypeUpdateInput, request.body)
    try {
      const row = await db.transaction(async (trx) => {
        const [updated] = await trx<ArchetypeRow>('archetypes')
          .where({ id, orgId: account.orgId })
          .update({ ...input, updatedAt: trx.fn.now() as never })
          .returning('*')
        if (!updated) throw notFound('Archetype')
        // This changes what every agent built from it does on its next run, so the text in effect is part of the record.
        await writeAudit(trx, {
          orgId: account.orgId,
          actorAccountId: account.id,
          actorKind: 'human',
          action: 'archetype.updated',
          targetType: 'archetype',
          targetId: id,
          metadata: { name: updated.name, role: updated.role, systemPrompt: updated.systemPrompt },
        })
        await emit(trx, account.orgId, { type: 'notify', kind: 'agent', id })
        return updated
      })
      return { archetype: archetypeDto(row, (await agentsOfArchetypes(account.orgId, [id]))(id)) }
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateArchetype(String(input.name))
      throw error
    }
  })

  app.delete('/api/archetypes/:id', async (request) => {
    const { account } = requireAdmin(request)
    const { id } = request.params as { id: string }
    try {
      await db.transaction(async (trx) => {
        const [deleted] = await trx<ArchetypeRow>('archetypes').where({ id, orgId: account.orgId }).delete().returning('*')
        if (!deleted) throw notFound('Archetype')
        await writeAudit(trx, {
          orgId: account.orgId,
          actorAccountId: account.id,
          actorKind: 'human',
          action: 'archetype.deleted',
          targetType: 'archetype',
          targetId: id,
          metadata: { name: deleted.name, role: deleted.role, systemPrompt: deleted.systemPrompt },
        })
        await emit(trx, account.orgId, { type: 'notify', kind: 'agent', id })
      })
      return { ok: true }
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error
      const agents = (await agentsOfArchetypes(account.orgId, [id]))(id)
      throw conflict(
        `${agents.map((agent) => agent.displayName).join(', ')} still ${agents.length === 1 ? 'uses' : 'use'} this archetype. Move them to another one first.`,
      )
    }
  })

  app.get('/api/skills', async (request) => {
    const rows = await db<SkillRow>('skills')
      .where({ orgId: requireAuth(request).account.orgId })
      .orderBy('name')
    return { skills: rows.map(skillDto) }
  })

  app.post('/api/skills', async (request) => {
    const { account } = requireAuth(request)
    const input = parseBody(skillInput, request.body)
    try {
      const [row] = await db<SkillRow>('skills')
        .insert({ orgId: account.orgId, ...input, createdBy: account.id })
        .returning('*')
      await writeAudit(db, {
        orgId: account.orgId,
        actorAccountId: account.id,
        actorKind: 'human',
        action: 'skill.created',
        targetType: 'skill',
        targetId: row?.id,
        metadata: { slug: input.slug },
      })
      return { skill: skillDto(row as SkillRow) }
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(`A skill with slug ${input.slug} already exists`)
      throw error
    }
  })

  app.put('/api/skills/:id', async (request) => {
    const { account } = requireAuth(request)
    const { id } = request.params as { id: string }
    const input = parseBody(skillInput, request.body)
    const [row] = await db<SkillRow>('skills')
      .where({ id, orgId: account.orgId })
      .update({ ...input, updatedAt: db.fn.now() as never })
      .returning('*')
    if (!row) throw notFound('Skill')
    await writeAudit(db, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'skill.updated',
      targetType: 'skill',
      targetId: id,
      metadata: { slug: input.slug },
    })
    return { skill: skillDto(row) }
  })

  app.get('/api/audit', async (request) => {
    const { account } = requireAuth(request)
    const query = request.query as { before?: string; actorId?: string; targetType?: string; targetId?: string; limit?: string }
    const builder = db('audit_log')
      .leftJoin('accounts', 'audit_log.actor_account_id', 'accounts.id')
      .where({ 'audit_log.org_id': account.orgId })
      .orderBy('audit_log.id', 'desc')
      .limit(Math.min(Number(query.limit ?? 100), 200))
      .select('audit_log.*', 'accounts.display_name as actor_name')
    if (query.before) builder.where('audit_log.id', '<', query.before)
    if (query.actorId) builder.where({ 'audit_log.actor_account_id': query.actorId })
    if (query.targetType) builder.where({ 'audit_log.target_type': query.targetType })
    if (query.targetId) builder.where({ 'audit_log.target_id': query.targetId })
    return { entries: (await builder).map(auditDto) }
  })

  app.get('/api/spend', async (request) => {
    const { account } = requireAuth(request)
    const query = request.query as { from?: string; to?: string }
    const to = query.to ? new Date(query.to) : new Date()
    const from = query.from ? new Date(query.from) : new Date(to.getFullYear(), to.getMonth(), 1)
    const totals = (column: string, label: string) =>
      db('runs')
        .leftJoin('accounts', 'runs.agent_id', 'accounts.id')
        .leftJoin('projects', 'runs.project_id', 'projects.id')
        .where({ 'runs.org_id': account.orgId })
        .whereBetween('runs.created_at', [from, to])
        .groupBy(column, label)
        .select(
          db.raw(`COALESCE(${column}::text, 'none') AS key`),
          db.raw(`COALESCE(${label}, 'Ad-hoc') AS label`),
          db.raw('COUNT(*) AS runs'),
          db.raw('COALESCE(SUM(runs.cost_usd) FILTER (WHERE NOT runs.cost_estimated), 0) AS cost_usd'),
          db.raw('COALESCE(SUM(runs.cost_usd) FILTER (WHERE runs.cost_estimated), 0) AS estimated_cost_usd'),
          db.raw(`COALESCE(SUM((runs.usage->>'inputTokens')::bigint), 0) AS input_tokens`),
          db.raw(`COALESCE(SUM((runs.usage->>'outputTokens')::bigint), 0) AS output_tokens`),
        )
        .orderBy('cost_usd', 'desc')
    const [byAgent, byProject] = await Promise.all([totals('runs.agent_id', 'accounts.display_name'), totals('runs.project_id', 'projects.name')])
    const normalize = (rows: Record<string, unknown>[]) =>
      rows.map((row) => ({
        key: String(row.key),
        label: String(row.label),
        runs: Number(row.runs),
        costUsd: Number(row.costUsd),
        estimatedCostUsd: Number(row.estimatedCostUsd),
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
      }))
    const agents = normalize(byAgent)
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalUsd: agents.reduce((sum, row) => sum + row.costUsd + row.estimatedCostUsd, 0),
      byAgent: agents,
      byProject: normalize(byProject),
    }
  })
}
