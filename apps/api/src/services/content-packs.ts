import { createHash } from 'node:crypto'
import type { PluginPackage } from '@factorix/connectors'
import {
  type AccountRow,
  type ArchetypeRow,
  type ContentPackItemKind,
  type ContentPackItemRow,
  type ContentPackRow,
  type Db,
  json,
  type SkillRow,
  type WorkflowRow,
} from '@factorix/db'
import {
  type ArchetypeInput,
  archetypeInput,
  BLOCK_TYPES,
  type BlockField,
  type BlockFieldKind,
  type BlockType,
  type ContentPackDto,
  type ContentPackPlanDto,
  type SkillInput,
  skillInput,
  WORKFLOW_BLOCKS,
  type WorkflowDefinition,
  workflowInput,
} from '@factorix/schemas'
import type { Knex } from 'knex'
import type { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { badRequest, conflict } from '../lib/errors'
import { emit } from '../lib/outbox'

type Trx = Db | Knex.Transaction

/** Fields that name something of one organization. A workflow from a package arrives with them empty, for its admin to fill. */
const LOCAL_FIELDS: BlockFieldKind[] = ['agent', 'project', 'connection', 'channel', 'people']

interface Content {
  skills: (SkillInput & { key: string })[]
  archetypes: (ArchetypeInput & { key: string })[]
  workflows: { key: string; name: string; description: string; definition: WorkflowDefinition }[]
}

function parsed<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  throw badRequest(`${what}: ${issue?.path.length ? `${issue.path.join('.')} ` : ''}${issue?.message ?? 'is not valid'}`)
}

/** Reads and checks every item before anything is written, so a package with one bad item imports nothing. */
function readContent(pkg: PluginPackage): Content {
  const content = pkg.manifest.content
  if (!content) throw badRequest('This package has no content')
  const text = (path: string) => (pkg.files.get(path) as Buffer).toString('utf8')
  return {
    skills: content.skills.map((skill) => ({
      key: skill.key,
      ...parsed(skillInput, { slug: skill.key, name: skill.name, markdown: text(skill.file) }, `The skill ${skill.key}`),
    })),
    archetypes: content.archetypes.map((archetype) => ({
      key: archetype.key,
      ...parsed(
        archetypeInput,
        {
          name: archetype.name,
          description: archetype.description,
          role: archetype.role,
          systemPrompt: archetype.prompt ? text(archetype.prompt) : '',
        },
        `The archetype ${archetype.key}`,
      ),
    })),
    workflows: content.workflows.map((workflow) => {
      let raw: unknown
      try {
        raw = JSON.parse(text(workflow.file))
      } catch {
        throw badRequest(`The workflow ${workflow.key}: ${workflow.file} is not JSON`)
      }
      const input = parsed(workflowInput, { ...(raw as object), projectId: null }, `The workflow ${workflow.key}`)
      const foreign = input.definition.nodes.find((node) => !BLOCK_TYPES.includes(node.type as BlockType))
      if (foreign) throw badRequest(`The workflow ${workflow.key} uses ${foreign.type}, a plugin's block, which a package cannot carry yet`)
      return { key: workflow.key, name: input.name, description: input.description, definition: input.definition }
    }),
  }
}

const fieldsOf = (type: string): readonly BlockField[] => WORKFLOW_BLOCKS[type as BlockType].fields

/** Skills are named by slug in a package, and become this organization's ids. Anything local is left for its admin. */
function localDefinition(definition: WorkflowDefinition, skillIds: Map<string, string>): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      const config = { ...node.config }
      for (const field of fieldsOf(node.type)) {
        const value = config[field.key]
        if (field.kind === 'skills') {
          config[field.key] = (Array.isArray(value) ? value : []).flatMap((slug) => skillIds.get(String(slug)) ?? [])
        } else if (LOCAL_FIELDS.includes(field.kind) && !field.options?.some((option) => option.value === value)) {
          delete config[field.key]
        }
      }
      return { ...node, config }
    }),
  }
}

function skillSlugsOf(definition: WorkflowDefinition): string[] {
  return definition.nodes.flatMap((node) =>
    fieldsOf(node.type)
      .filter((field) => field.kind === 'skills')
      .flatMap((field) => {
        const value = node.config[field.key]
        return Array.isArray(value) ? value.map(String) : []
      }),
  )
}

/** Postgres hands JSON back with its keys reordered, so a digest sorts them first. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
const skillDigest = (row: Pick<SkillRow, 'name' | 'markdown'>) => digest([row.name, row.markdown])
const archetypeDigest = (row: Pick<ArchetypeRow, 'name' | 'description' | 'role' | 'systemPrompt'>) =>
  digest([row.name, row.description, row.role, row.systemPrompt])
const workflowDigest = (row: Pick<WorkflowRow, 'name' | 'description' | 'definition'>) => digest([row.name, row.description, row.definition])

interface Target {
  id: string
  name: string
  digest: string
}

/** The rows a pack's items point at, as they are now. A deleted one is missing, and so is an archived workflow. */
async function targetsOf(db: Trx, orgId: string, items: Pick<ContentPackItemRow, 'kind' | 'targetId'>[]): Promise<Map<string, Target>> {
  const ids = (kind: ContentPackItemKind) => items.filter((item) => item.kind === kind).map((item) => item.targetId)
  const [skills, archetypes, workflows] = await Promise.all([
    db<SkillRow>('skills').where({ orgId }).whereIn('id', ids('skill')),
    db<ArchetypeRow>('archetypes').where({ orgId }).whereIn('id', ids('archetype')),
    db<WorkflowRow>('workflows').where({ orgId }).whereNull('archivedAt').whereIn('id', ids('workflow')),
  ])
  return new Map([
    ...skills.map((row) => [`skill:${row.id}`, { id: row.id, name: row.name, digest: skillDigest(row) }] as const),
    ...archetypes.map((row) => [`archetype:${row.id}`, { id: row.id, name: row.name, digest: archetypeDigest(row) }] as const),
    ...workflows.map((row) => [`workflow:${row.id}`, { id: row.id, name: row.name, digest: workflowDigest(row) }] as const),
  ])
}

interface Decision extends ContentPackPlanDto {
  tracked?: ContentPackItemRow
}

async function planContent(db: Trx, orgId: string, pack: ContentPackRow | undefined, content: Content): Promise<Decision[]> {
  const tracked = pack ? await db<ContentPackItemRow>('content_pack_items').where({ packId: pack.id }) : []
  const byKey = new Map(tracked.map((item) => [`${item.kind}:${item.key}`, item]))
  const targets = await targetsOf(db, orgId, tracked)
  const skillSlugs = new Set(
    (
      await db<SkillRow>('skills')
        .where({ orgId })
        .whereIn(
          'slug',
          content.skills.map((skill) => skill.slug),
        )
        .pluck('slug')
    ).map(String),
  )
  const archetypeNames = new Map(
    (await db<ArchetypeRow>('archetypes').where({ orgId }).select('id', 'name')).map((row) => [row.name.toLowerCase(), row.id]),
  )

  const decide = (kind: ContentPackItemKind, key: string, name: string, taken: (own: string | undefined) => boolean): Decision => {
    const item = byKey.get(`${kind}:${key}`)
    if (!item) return { kind, key, name, action: taken(undefined) ? 'conflict' : 'create' }
    const target = targets.get(`${kind}:${item.targetId}`)
    if (!target) return { kind, key, name, action: 'gone', tracked: item }
    if (target.digest !== item.sha256) return { kind, key, name: target.name, action: 'keep', tracked: item }
    return { kind, key, name, action: taken(item.targetId) ? 'conflict' : 'update', tracked: item }
  }
  const archetypeTaken = (name: string) => (own: string | undefined) => {
    const holder = archetypeNames.get(name.toLowerCase())
    return holder !== undefined && holder !== own
  }

  const decisions: Decision[] = [
    ...content.skills.map((skill) => decide('skill', skill.key, skill.name, (own) => own === undefined && skillSlugs.has(skill.slug))),
    ...content.archetypes.map((archetype) => decide('archetype', archetype.key, archetype.name, archetypeTaken(archetype.name))),
    ...content.workflows.map((workflow) => decide('workflow', workflow.key, workflow.name, () => false)),
  ]
  const wanted = new Set(decisions.map((decision) => `${decision.kind}:${decision.key}`))
  for (const item of tracked) {
    if (wanted.has(`${item.kind}:${item.key}`)) continue
    decisions.push({
      kind: item.kind,
      key: item.key,
      name: targets.get(`${item.kind}:${item.targetId}`)?.name ?? item.key,
      action: 'release',
      tracked: item,
    })
  }
  return decisions
}

const packOf = (db: Trx, orgId: string, name: string) => db<ContentPackRow>('content_packs').where({ orgId, name }).first()

/** What importing a package of content would do, without writing anything. */
export async function inspectContentPack(
  deps: { db: Db },
  orgId: string,
  pkg: PluginPackage,
): Promise<{ replaces: string | null; items: ContentPackPlanDto[] }> {
  const content = readContent(pkg)
  const pack = await packOf(deps.db, orgId, pkg.manifest.name)
  const items = await planContent(deps.db, orgId, pack, content)
  return { replaces: pack?.version ?? null, items: items.map(({ tracked: _, ...item }) => item) }
}

/**
 * Imports a package of content, or a newer version of one. Every item becomes the organization's own: a workflow arrives as
 * a draft that does nothing until its admin fills in what is local and publishes it, and an upgrade rewrites only what
 * nobody changed since the package wrote it.
 */
export async function installContentPack(deps: { db: Db }, account: AccountRow, pkg: PluginPackage): Promise<ContentPackRow> {
  const content = readContent(pkg)
  const { manifest } = pkg
  return deps.db.transaction(async (trx) => {
    const existing = await trx<ContentPackRow>('content_packs').where({ orgId: account.orgId, name: manifest.name }).forUpdate().first()
    const decisions = await planContent(trx, account.orgId, existing, content)
    const conflicts = decisions.filter((decision) => decision.action === 'conflict')
    if (conflicts.length > 0) {
      const names = conflicts.map((decision) => `the ${decision.kind} ${decision.kind === 'skill' ? decision.key : decision.name}`).join(', ')
      throw conflict(`This organization already has ${names}. Rename or remove ${conflicts.length === 1 ? 'it' : 'them'}, then upload again`)
    }
    const values = { version: manifest.version, manifest: json(manifest) as never, sha256: pkg.sha256, installedBy: account.id }
    const [pack] = existing
      ? await trx<ContentPackRow>('content_packs')
          .where({ id: existing.id })
          .update({ ...values, updatedAt: trx.fn.now() as never })
          .returning('*')
      : await trx<ContentPackRow>('content_packs')
          .insert({ orgId: account.orgId, name: manifest.name, ...values })
          .returning('*')
    const packId = (pack as ContentPackRow).id
    const decided = (kind: ContentPackItemKind, key: string) =>
      decisions.find((decision) => decision.kind === kind && decision.key === key) as Decision
    const track = (kind: ContentPackItemKind, key: string, targetId: string, sha256: string) =>
      trx('content_pack_items').insert({ packId, kind, key, targetId, sha256 }).onConflict(['pack_id', 'kind', 'key']).merge(['targetId', 'sha256'])

    for (const { key, ...skill } of content.skills) {
      const { action, tracked } = decided('skill', key)
      if (action === 'create') {
        const [row] = await trx<SkillRow>('skills')
          .insert({ orgId: account.orgId, ...skill, createdBy: account.id })
          .returning('id')
        await track('skill', key, (row as { id: string }).id, skillDigest(skill))
      } else if (action === 'update' && tracked) {
        await trx('skills').where({ id: tracked.targetId }).update({ name: skill.name, markdown: skill.markdown, updatedAt: trx.fn.now() })
        await track('skill', key, tracked.targetId, skillDigest(skill))
      }
    }
    const changedArchetypes: string[] = []
    for (const { key, ...archetype } of content.archetypes) {
      const { action, tracked } = decided('archetype', key)
      if (action === 'create') {
        const [row] = await trx<ArchetypeRow>('archetypes')
          .insert({ orgId: account.orgId, ...archetype, createdBy: account.id })
          .returning('id')
        const id = (row as { id: string }).id
        await track('archetype', key, id, archetypeDigest(archetype))
        changedArchetypes.push(id)
      } else if (action === 'update' && tracked) {
        await trx('archetypes')
          .where({ id: tracked.targetId })
          .update({ ...archetype, updatedAt: trx.fn.now() })
        await track('archetype', key, tracked.targetId, archetypeDigest(archetype))
        changedArchetypes.push(tracked.targetId)
      }
    }
    const referenced = [...new Set(content.workflows.flatMap((workflow) => skillSlugsOf(workflow.definition)))]
    const skillIds = new Map(
      (await trx<SkillRow>('skills').where({ orgId: account.orgId }).whereIn('slug', referenced).select('id', 'slug')).map((row) => [
        row.slug,
        row.id,
      ]),
    )
    for (const workflow of content.workflows) {
      const { action, tracked } = decided('workflow', workflow.key)
      const row = { name: workflow.name, description: workflow.description, definition: localDefinition(workflow.definition, skillIds) }
      if (action === 'create') {
        const [created] = await trx('workflows')
          .insert({ orgId: account.orgId, projectId: null, ...row, definition: json(row.definition), createdBy: account.id })
          .returning('id')
        await track('workflow', workflow.key, (created as { id: string }).id, workflowDigest(row))
      } else if (action === 'update' && tracked) {
        // Only the draft changes. What runs is the published copy, until an admin publishes this.
        await trx('workflows')
          .where({ id: tracked.targetId })
          .update({ ...row, definition: json(row.definition), updatedAt: trx.fn.now() })
        await track('workflow', workflow.key, tracked.targetId, workflowDigest(row))
      }
    }
    const released = decisions.filter((decision) => decision.action === 'release')
    for (const decision of released) await trx('content_pack_items').where({ packId, kind: decision.kind, key: decision.key }).delete()

    const count = (action: ContentPackPlanDto['action']) => decisions.filter((decision) => decision.action === action).length
    await writeAudit(trx, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'content_pack.installed',
      targetType: 'content_pack',
      targetId: packId,
      metadata: {
        name: manifest.name,
        version: manifest.version,
        sha256: pkg.sha256,
        created: count('create'),
        updated: count('update'),
        kept: count('keep'),
        released: count('release'),
      },
    })
    for (const id of changedArchetypes) await emit(trx, account.orgId, { type: 'notify', kind: 'agent', id })
    return pack as ContentPackRow
  })
}

/**
 * Takes back what a pack imported, except what someone changed, used, or published since: those stay the organization's.
 * Returns the names it left.
 */
export async function removeContentPack(deps: { db: Db }, account: AccountRow, pack: ContentPackRow): Promise<string[]> {
  return deps.db.transaction(async (trx) => {
    const items = await trx<ContentPackItemRow>('content_pack_items').where({ packId: pack.id })
    const targets = await targetsOf(trx, account.orgId, items)
    const kept: string[] = []
    const unchanged = (item: ContentPackItemRow) => {
      const target = targets.get(`${item.kind}:${item.targetId}`)
      if (target && target.digest !== item.sha256) kept.push(target.name)
      return target?.digest === item.sha256
    }
    const of = (kind: ContentPackItemKind) => items.filter((item) => item.kind === kind)

    for (const item of of('workflow').filter(unchanged)) {
      const archived = await trx('workflows')
        .where({ id: item.targetId, publishedVersion: 0 })
        .update({ archivedAt: trx.fn.now(), enabled: false, updatedAt: trx.fn.now() })
      if (!archived) kept.push((targets.get(`workflow:${item.targetId}`) as Target).name)
    }
    for (const item of of('skill').filter(unchanged)) {
      const onAgent = await trx('agent_skills').where({ skillId: item.targetId }).first()
      const inWorkflow = await trx('workflows')
        .where({ orgId: account.orgId })
        .whereNull('archivedAt')
        .where((query) =>
          query.whereRaw('definition::text LIKE ?', [`%${item.targetId}%`]).orWhereRaw('published_definition::text LIKE ?', [`%${item.targetId}%`]),
        )
        .first('id')
      if (onAgent || inWorkflow) kept.push((targets.get(`skill:${item.targetId}`) as Target).name)
      else await trx('skills').where({ id: item.targetId }).delete()
    }
    for (const item of of('archetype').filter(unchanged)) {
      if (await trx('agents').where({ archetypeId: item.targetId }).first('accountId')) {
        kept.push((targets.get(`archetype:${item.targetId}`) as Target).name)
        continue
      }
      await trx('archetypes').where({ id: item.targetId }).delete()
      await emit(trx, account.orgId, { type: 'notify', kind: 'agent', id: item.targetId })
    }
    await trx('content_packs').where({ id: pack.id }).delete()
    await writeAudit(trx, {
      orgId: account.orgId,
      actorAccountId: account.id,
      actorKind: 'human',
      action: 'content_pack.removed',
      targetType: 'content_pack',
      targetId: pack.id,
      metadata: { name: pack.name, version: pack.version, kept },
    })
    return kept
  })
}

export async function listContentPacks(db: Db, orgId: string): Promise<ContentPackDto[]> {
  const packs = await db<ContentPackRow>('content_packs').where({ orgId }).orderBy('name')
  if (packs.length === 0) return []
  const items = await db<ContentPackItemRow>('content_pack_items')
    .whereIn(
      'packId',
      packs.map((pack) => pack.id),
    )
    .orderBy(['kind', 'key'])
  const targets = await targetsOf(db, orgId, items)
  return packs.map((pack) => {
    const manifest = pack.manifest as { description?: string; publisher?: string }
    return {
      id: pack.id,
      name: pack.name,
      version: pack.version,
      description: manifest.description ?? null,
      publisher: manifest.publisher ?? null,
      items: items
        .filter((item) => item.packId === pack.id)
        .map((item) => {
          const target = targets.get(`${item.kind}:${item.targetId}`)
          return { kind: item.kind, key: item.key, id: target?.id ?? null, name: target?.name ?? null }
        }),
      updatedAt: pack.updatedAt.toISOString(),
    }
  })
}
