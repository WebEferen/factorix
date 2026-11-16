import { AGENT_PRESETS, ARCHETYPE_PRESETS, BUILTIN_PIPELINE, BUILTIN_PIPELINE_NAME, DEFAULT_SKILLS } from '@factorix/core'
import { type AccountRow, type Db, json, type UserRow } from '@factorix/db'
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

/** A handle that is free in the organization, from the part of an email before the @. */
async function freeHandle(db: Db, orgId: string, email: string): Promise<string> {
  const base = slugify(email.split('@')[0] ?? 'member')
  const taken = new Set(
    ((await db('accounts').where({ orgId }).andWhere('handle', 'like', `${base}%`).select('handle')) as { handle: string }[]).map(
      (row) => row.handle,
    ),
  )
  for (let n = 1; ; n++) {
    const handle = n === 1 ? base : `${base}-${n}`
    if (!taken.has(handle)) return handle
  }
}

/** Gives a person an account in an organization. */
export async function addMember(
  db: Db,
  orgId: string,
  user: Pick<UserRow, 'id' | 'email' | 'displayName'>,
  role: AccountRow['role'],
): Promise<AccountRow> {
  const [account] = await db<AccountRow>('accounts')
    .insert({
      orgId,
      userId: user.id,
      kind: 'human',
      role,
      handle: await freeHandle(db, orgId, user.email),
      displayName: user.displayName,
      email: user.email,
    })
    .returning('*')
  if (!account) throw new Error('Account insert returned nothing')
  return account
}

/** An organization with its first admin, and the pipeline, skills, archetypes, and agents every organization starts with. */
export async function createOrg(trx: Db, name: string, owner: Pick<UserRow, 'id' | 'email' | 'displayName'>): Promise<AccountRow> {
  const base = slugify(name)
  const taken = new Set(((await trx('organizations').where('slug', 'like', `${base}%`).select('slug')) as { slug: string }[]).map((row) => row.slug))
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  const [org] = await trx('organizations').insert({ name, slug }).returning('id')
  if (!org) throw new Error('Organization insert returned nothing')
  const orgId = org.id as string
  const account = await addMember(trx, orgId, owner, 'admin')

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
    metadata: { name },
  })
  return account
}

export async function bootstrapOrg(db: Db, input: SetupInput): Promise<{ user: UserRow; account: AccountRow }> {
  const passwordHash = await hashPassword(input.password)
  return db.transaction(async (trx) => {
    await trx.raw('LOCK TABLE organizations IN EXCLUSIVE MODE')
    if (await trx('organizations').first('id')) throw conflict('This installation is already set up')
    const [user] = await trx<UserRow>('users')
      .insert({ email: input.email, passwordHash, displayName: input.name, installationAdmin: true })
      .returning('*')
    if (!user) throw new Error('User insert returned nothing')
    return { user, account: await createOrg(trx, input.orgName, user) }
  })
}
