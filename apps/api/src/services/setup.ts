import { AGENT_PRESETS, ARCHETYPE_PRESETS, BUILTIN_PIPELINE, BUILTIN_PIPELINE_NAME, DEFAULT_SKILLS } from '@factorix/core'
import { type AccountRow, type Db, json } from '@factorix/db'
import { RUNTIME_CAPABILITIES } from '@factorix/runtime'
import type { SetupInput } from '@factorix/schemas'
import { writeAudit } from '../lib/audit'
import { hashPassword } from '../lib/auth'
import { conflict } from '../lib/errors'

export async function isSetUp(db: Db): Promise<boolean> {
  return Boolean(await db('organizations').first('id'))
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'org'
  )
}

export async function bootstrapOrg(db: Db, input: SetupInput): Promise<AccountRow> {
  const passwordHash = await hashPassword(input.password)
  return db.transaction(async (trx) => {
    await trx.raw('LOCK TABLE organizations IN EXCLUSIVE MODE')
    if (await trx('organizations').first('id')) throw conflict('This installation is already set up')
    const [org] = await trx('organizations')
      .insert({ name: input.orgName, slug: slugify(input.orgName) })
      .returning('id')
    if (!org) throw new Error('Organization insert returned nothing')
    const orgId = org.id as string
    const handle = slugify(input.email.split('@')[0] ?? 'admin')
    const [account] = await trx<AccountRow>('accounts')
      .insert({ orgId, kind: 'human', role: 'admin', handle, displayName: input.name, email: input.email, passwordHash })
      .returning('*')
    if (!account) throw new Error('Account insert returned nothing')

    await trx('pipelines').insert({ orgId, name: BUILTIN_PIPELINE_NAME, definition: json(BUILTIN_PIPELINE), isBuiltin: true })
    const skills = await trx('skills')
      .insert(DEFAULT_SKILLS.map((skill) => ({ orgId, ...skill, createdBy: account.id })))
      .returning('id')
    const archetypes = (await trx('archetypes')
      .insert(ARCHETYPE_PRESETS.map((preset) => ({ orgId, ...preset, createdBy: account.id })))
      .returning(['id', 'name'])) as { id: string; name: string }[]
    for (const preset of AGENT_PRESETS) {
      const [agent] = await trx('accounts').insert({ orgId, kind: 'agent', handle: preset.handle, displayName: preset.displayName }).returning('id')
      if (!agent) throw new Error('Agent account insert returned nothing')
      await trx('agents').insert({
        accountId: agent.id,
        orgId,
        archetypeId: archetypes.find((archetype) => archetype.name === preset.archetype)?.id,
        description: preset.description,
        runtime: preset.runtime,
        model: preset.model,
        maxBudgetUsd: 10,
        maxTurns: 200,
        policy: json(preset.policy),
        capabilitiesSnapshot: json(RUNTIME_CAPABILITIES[preset.runtime]),
      })
      await trx('agent_skills').insert(skills.map((skill: { id: string }, position: number) => ({ agentId: agent.id, skillId: skill.id, position })))
    }
    await writeAudit(trx, {
      orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'org.created',
      targetType: 'organization',
      targetId: orgId,
      metadata: { name: input.orgName },
    })
    return account
  })
}
