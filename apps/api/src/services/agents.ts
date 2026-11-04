import { policyErrorsForRuntime } from '@factorix/core'
import { type AccountRow, type AgentRow, type Db, json, type SkillRow } from '@factorix/db'
import { RUNTIME_CAPABILITIES, type RuntimeId } from '@factorix/runtime'
import type { AgentDto, AgentInput } from '@factorix/schemas'
import type { Knex } from 'knex'
import type { AppDeps } from '../deps'
import { writeAudit } from '../lib/audit'
import { badRequest, conflict, isUniqueViolation, notFound } from '../lib/errors'
import { emit } from '../lib/outbox'

type AgentJoined = AgentRow &
  Pick<AccountRow, 'handle' | 'displayName' | 'status'> & { archetypeName: string; archetypeRole: 'engineer' | 'reviewer' | 'other' }

const AGENT_COLUMNS = [
  'agents.*',
  'accounts.handle',
  'accounts.display_name',
  'accounts.status',
  'archetypes.name as archetype_name',
  'archetypes.role as archetype_role',
]

export async function buildAgentSnapshot(
  db: Db | Knex.Transaction,
  agent: AgentRow & Pick<AccountRow, 'handle' | 'displayName'>,
): Promise<Record<string, unknown>> {
  const skills = await db<SkillRow>('skills')
    .join('agent_skills', 'skills.id', 'agent_skills.skill_id')
    .where({ 'agent_skills.agent_id': agent.accountId })
    .orderBy('agent_skills.position')
    .select('skills.name', 'skills.markdown')
  const archetype = await db('archetypes').where({ id: agent.archetypeId }).first('name', 'role', 'systemPrompt')
  return {
    handle: agent.handle,
    displayName: agent.displayName,
    archetype,
    systemPrompt: agent.systemPrompt,
    runtime: agent.runtime,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    maxBudgetUsd: agent.maxBudgetUsd,
    maxTurns: agent.maxTurns,
    policy: agent.policy,
    version: agent.version,
    skills,
  }
}

export function agentDto(row: AgentJoined, skillIds: string[], connectionIds: string[], activeRunCount?: number): AgentDto {
  return {
    id: row.accountId,
    handle: row.handle,
    displayName: row.displayName,
    status: row.status,
    archetype: { id: row.archetypeId, name: row.archetypeName, role: row.archetypeRole },
    description: row.description,
    systemPrompt: row.systemPrompt,
    runtime: row.runtime,
    model: row.model,
    reasoningEffort: row.reasoningEffort,
    maxBudgetUsd: row.maxBudgetUsd,
    maxTurns: row.maxTurns,
    policy: row.policy,
    capabilities: row.capabilitiesSnapshot,
    version: row.version,
    skillIds,
    connectionIds,
    activeRunCount,
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function validateRuntime(deps: Pick<AppDeps, 'env'>, input: AgentInput): Promise<void> {
  if (input.runtime === 'scripted' && !deps.env.FACTORIX_ALLOW_SCRIPTED_RUNTIME)
    throw badRequest('The scripted runtime is disabled. Set FACTORIX_ALLOW_SCRIPTED_RUNTIME=true to use it.')
  const capabilities = RUNTIME_CAPABILITIES[input.runtime as RuntimeId]
  const problems = policyErrorsForRuntime({ ...input.policy }, input.runtime as RuntimeId, capabilities.toolApproval)
  if (problems[0]) throw badRequest(problems[0])
}

export async function agentRole(db: Db | Knex.Transaction, agentId: string): Promise<string | undefined> {
  const row = await db('agents')
    .join('archetypes', 'agents.archetype_id', 'archetypes.id')
    .where({ 'agents.account_id': agentId })
    .first('archetypes.role')
  return row?.role
}

async function assertArchetype(trx: Knex.Transaction, orgId: string, archetypeId: string): Promise<void> {
  if (!(await trx('archetypes').where({ id: archetypeId, orgId }).first('id'))) throw badRequest('That archetype does not exist')
}

async function linkRelations(trx: Knex.Transaction, orgId: string, agentId: string, input: AgentInput): Promise<void> {
  await trx('agent_skills').where({ agentId }).delete()
  if (input.skillIds.length > 0) {
    const owned = await trx('skills').where({ orgId }).whereIn('id', input.skillIds).pluck('id')
    if (owned.length !== new Set(input.skillIds).size) throw badRequest('One of the skills does not exist')
    await trx('agent_skills').insert(input.skillIds.map((skillId, position) => ({ agentId, skillId, position })))
  }
  await trx('agent_connections').where({ agentId }).delete()
  if (input.connectionIds.length > 0) {
    const connections = await trx('connections').where({ orgId }).whereIn('id', input.connectionIds).select('id', 'kind')
    if (connections.length !== new Set(input.connectionIds).size) throw badRequest('One of the connections does not exist')
    const roleFor = (kind: string) => (kind === 'anthropic' || kind === 'openai' ? 'model' : kind.startsWith('mcp') ? 'mcp' : 'tool')
    await trx('agent_connections').insert(
      connections.map((connection: { id: string; kind: string }) => ({ agentId, connectionId: connection.id, role: roleFor(connection.kind) })),
    )
  }
}

export async function createAgent(deps: Pick<AppDeps, 'db' | 'env'>, orgId: string, actorId: string | null, input: AgentInput): Promise<string> {
  await validateRuntime(deps, input)
  try {
    return await deps.db.transaction(async (trx) => {
      await assertArchetype(trx, orgId, input.archetypeId)
      const [account] = await trx('accounts')
        .insert({ orgId, kind: 'agent', handle: input.handle, displayName: input.displayName, status: input.status })
        .returning('id')
      if (!account) throw new Error('Account insert returned nothing')
      await trx('agents').insert({
        accountId: account.id,
        orgId,
        archetypeId: input.archetypeId,
        description: input.description,
        systemPrompt: input.systemPrompt,
        runtime: input.runtime,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        maxBudgetUsd: input.maxBudgetUsd,
        maxTurns: input.maxTurns,
        policy: json(input.policy),
        capabilitiesSnapshot: json(RUNTIME_CAPABILITIES[input.runtime as RuntimeId]),
      })
      await linkRelations(trx, orgId, account.id, input)
      await writeAudit(trx, {
        orgId,
        actorAccountId: actorId,
        actorKind: actorId ? 'human' : 'system',
        action: 'agent.created',
        targetType: 'agent',
        targetId: account.id,
        metadata: { handle: input.handle, archetypeId: input.archetypeId, runtime: input.runtime },
      })
      await emit(trx, orgId, { type: 'notify', kind: 'agent', id: account.id })
      return account.id as string
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(`An agent or member with handle ${input.handle} already exists`)
    throw error
  }
}

export async function updateAgent(
  deps: Pick<AppDeps, 'db' | 'env'>,
  orgId: string,
  actorId: string,
  agentId: string,
  input: AgentInput,
): Promise<void> {
  await validateRuntime(deps, input)
  await deps.db.transaction(async (trx) => {
    const agent = await trx('agents').where({ accountId: agentId, orgId }).first()
    if (!agent) throw notFound('Agent')
    await assertArchetype(trx, orgId, input.archetypeId)
    await trx('accounts')
      .where({ id: agentId, orgId })
      .update({ handle: input.handle, displayName: input.displayName, status: input.status, updatedAt: trx.fn.now() })
    await trx('agents')
      .where({ accountId: agentId })
      .update({
        archetypeId: input.archetypeId,
        description: input.description,
        systemPrompt: input.systemPrompt,
        runtime: input.runtime,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        maxBudgetUsd: input.maxBudgetUsd,
        maxTurns: input.maxTurns,
        policy: json(input.policy),
        capabilitiesSnapshot: json(RUNTIME_CAPABILITIES[input.runtime as RuntimeId]),
        version: trx.raw('version + 1'),
        updatedAt: trx.fn.now(),
      })
    await linkRelations(trx, orgId, agentId, input)
    await writeAudit(trx, {
      orgId,
      actorAccountId: actorId,
      actorKind: 'human',
      action: 'agent.updated',
      targetType: 'agent',
      targetId: agentId,
      metadata: { handle: input.handle, version: agent.version + 1 },
    })
    await emit(trx, orgId, { type: 'notify', kind: 'agent', id: agentId })
  })
}

export async function listAgents(db: Db, orgId: string): Promise<AgentDto[]> {
  const rows = (await db('agents')
    .join('accounts', 'agents.account_id', 'accounts.id')
    .join('archetypes', 'agents.archetype_id', 'archetypes.id')
    .where({ 'agents.org_id': orgId })
    .orderBy('accounts.handle')
    .select(AGENT_COLUMNS)) as AgentJoined[]
  const ids = rows.map((row) => row.accountId)
  const [skills, connections, active] = await Promise.all([
    db('agent_skills').whereIn('agentId', ids).orderBy('position').select('agentId', 'skillId'),
    db('agent_connections').whereIn('agentId', ids).select('agentId', 'connectionId'),
    db('runs')
      .whereIn('agentId', ids)
      .whereIn('state', ['preparing', 'running', 'waiting_approval', 'finalizing'])
      .groupBy('agentId')
      .select('agentId')
      .count('* as count'),
  ])
  return rows.map((row) =>
    agentDto(
      row,
      skills.filter((link: { agentId: string }) => link.agentId === row.accountId).map((link: { skillId: string }) => link.skillId),
      connections.filter((link: { agentId: string }) => link.agentId === row.accountId).map((link: { connectionId: string }) => link.connectionId),
      Number((active as unknown as { agentId: string; count: string }[]).find((entry) => entry.agentId === row.accountId)?.count ?? 0),
    ),
  )
}

export async function getAgent(db: Db, orgId: string, id: string): Promise<AgentDto> {
  const agent = (await listAgents(db, orgId)).find((candidate) => candidate.id === id)
  if (!agent) throw notFound('Agent')
  return agent
}
