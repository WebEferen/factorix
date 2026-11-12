import { isSecretSourceKind, SECRET_SOURCES, type SecretSourceConnector } from '@factorix/connectors'
import { type ConnectionRow, type Db, json, type ProjectEnvironmentRow, type ProjectRepoRow, type ProjectRow } from '@factorix/db'
import {
  type EnvironmentDefinition,
  type EnvironmentDto,
  type EnvironmentInput,
  type EnvironmentTestDto,
  filterSecrets,
  parseEnvironment,
  type SecretSetInput,
} from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { writeAudit } from '../lib/audit'
import { badRequest, HttpError } from '../lib/errors'
import { decryptConnection } from './connections'

type SecretSet = ProjectEnvironmentRow['secretSets'][number]

export async function getEnvironmentRow(db: Db, projectId: string): Promise<ProjectEnvironmentRow | undefined> {
  return db<ProjectEnvironmentRow>('project_environments').where({ projectId }).first()
}

/** A project has an environment once its definition names at least one service. */
export function definitionOf(row: ProjectEnvironmentRow | undefined): EnvironmentDefinition | null {
  return (row?.definition as EnvironmentDefinition | null | undefined) ?? null
}

async function repoNames(db: Db, projectId: string): Promise<string[]> {
  return (await db<ProjectRepoRow>('project_repos').where({ projectId }).select('name')).map((row) => row.name)
}

export async function environmentDto(db: Db, projectId: string, row?: ProjectEnvironmentRow): Promise<EnvironmentDto> {
  const current = row ?? (await getEnvironmentRow(db, projectId))
  const sets = current?.secretSets ?? []
  const connections = sets.length
    ? await db<ConnectionRow>('connections').whereIn(
        'id',
        sets.map((set) => set.connectionId),
      )
    : []
  const updatedBy = current?.updatedBy ? await db('accounts').where({ id: current.updatedBy }).select('id', 'displayName').first() : undefined
  return {
    projectId,
    source: current?.source ?? '',
    secretSets: sets.map((set) => {
      const connection = connections.find((candidate) => candidate.id === set.connectionId)
      return { ...set, connectionName: connection?.name ?? null, connectionKind: connection?.kind ?? null }
    }),
    version: current?.version ?? 0,
    updatedAt: current?.updatedAt ? new Date(current.updatedAt).toISOString() : null,
    updatedBy: updatedBy ? { id: updatedBy.id as string, name: updatedBy.displayName as string } : null,
  }
}

/** Sets only point at secret sources in the same org, and a source with nothing to pick keeps no project or config. */
async function normalizeSets(db: Db, orgId: string, sets: SecretSetInput[]): Promise<SecretSet[]> {
  const connections = sets.length
    ? await db<ConnectionRow>('connections')
        .where({ orgId })
        .whereIn(
          'id',
          sets.map((set) => set.connectionId),
        )
    : []
  return sets.map((set) => {
    const connection = connections.find((candidate) => candidate.id === set.connectionId)
    if (!connection || !isSecretSourceKind(connection.kind))
      throw badRequest(`Secret set ${set.name} needs a Doppler or environment-secret connection`)
    const scoped = SECRET_SOURCES[connection.kind].scoped
    return { ...set, project: scoped ? set.project : null, config: scoped ? set.config : null }
  })
}

function invalid(issues: ReturnType<typeof parseEnvironment>['issues']): HttpError {
  const first = issues[0]
  const where = first?.line ? `Line ${first.line}: ` : ''
  return new HttpError(422, 'invalid_environment', `${where}${first?.message ?? 'The environment is not valid'}`, issues)
}

export async function saveEnvironment(
  deps: Pick<AppDeps, 'db'>,
  actor: { id: string; orgId: string },
  project: ProjectRow,
  input: EnvironmentInput,
): Promise<EnvironmentDto> {
  const { db } = deps
  const secretSets = await normalizeSets(db, actor.orgId, input.secretSets)
  const parsed = parseEnvironment(input.source, {
    repos: await repoNames(db, project.id),
    secretSets: secretSets.map((set) => set.name),
  })
  if (parsed.issues.length > 0) throw invalid(parsed.issues)
  const row = await db.transaction(async (trx) => {
    const [saved] = await trx<ProjectEnvironmentRow>('project_environments')
      .insert({
        projectId: project.id,
        orgId: actor.orgId,
        source: input.source,
        definition: (parsed.definition ? json(parsed.definition) : null) as never,
        secretSets: json(secretSets) as never,
        updatedBy: actor.id,
      })
      .onConflict('project_id')
      .merge({
        source: input.source,
        definition: (parsed.definition ? json(parsed.definition) : null) as never,
        secretSets: json(secretSets) as never,
        updatedBy: actor.id,
        updatedAt: trx.fn.now() as never,
        version: trx.raw('project_environments.version + 1') as never,
      })
      .returning('*')
    await writeAudit(trx, {
      orgId: actor.orgId,
      actorAccountId: actor.id,
      actorKind: 'human',
      action: 'environment.updated',
      targetType: 'project',
      targetId: project.id,
      metadata: {
        version: saved?.version,
        services: Object.keys(parsed.definition?.services ?? {}),
        secretSets: secretSets.map((set) => ({
          name: set.name,
          connectionId: set.connectionId,
          project: set.project,
          config: set.config,
        })),
      },
    })
    return saved as ProjectEnvironmentRow
  })
  return environmentDto(db, project.id, row)
}

export async function secretSourceFor(
  deps: Pick<AppDeps, 'db' | 'secrets' | 'connectors'>,
  orgId: string,
  connectionId: string,
): Promise<SecretSourceConnector> {
  const connection = await deps.db<ConnectionRow>('connections').where({ id: connectionId, orgId }).first()
  if (!connection || !isSecretSourceKind(connection.kind)) throw badRequest('That connection is not a secret source')
  const secret = decryptConnection(deps, connection)
  if (!secret) throw badRequest(`${connection.name} has no token or values stored`)
  return deps.connectors.secrets(connection, secret)
}

/** Fetches each set once, filtered by its own key lists. Values stay in memory: callers hand them to containers and drop them. */
export async function resolveSecretSets(
  deps: Pick<AppDeps, 'db' | 'secrets' | 'connectors'>,
  orgId: string,
  sets: SecretSet[],
): Promise<Map<string, Record<string, string>>> {
  const resolved = new Map<string, Record<string, string>>()
  const fetched = new Map<string, Promise<Record<string, string>>>()
  for (const set of sets) {
    const key = `${set.connectionId}\u0000${set.project ?? ''}\u0000${set.config ?? ''}`
    let values = fetched.get(key)
    if (!values) {
      values = secretSourceFor(deps, orgId, set.connectionId).then((source) => source.fetch({ project: set.project, config: set.config }))
      fetched.set(key, values)
    }
    try {
      resolved.set(set.name, filterSecrets(await values, set))
    } catch (error) {
      throw new Error(`Secret set ${set.name}: ${(error as Error).message}`)
    }
  }
  return resolved
}

/** Validates an unsaved definition and reads every set, returning key names only. */
export async function testEnvironment(
  deps: Pick<AppDeps, 'db' | 'secrets' | 'connectors'>,
  orgId: string,
  project: ProjectRow,
  input: EnvironmentInput,
): Promise<EnvironmentTestDto> {
  const parsed = parseEnvironment(input.source, {
    repos: await repoNames(deps.db, project.id),
    secretSets: input.secretSets.map((set) => set.name),
  })
  let sets: SecretSet[]
  try {
    sets = await normalizeSets(deps.db, orgId, input.secretSets)
  } catch (error) {
    return {
      issues: parsed.issues,
      sets: input.secretSets.map((set) => ({ name: set.name, ok: false, message: (error as Error).message, keys: [] })),
    }
  }
  const results = await Promise.all(
    sets.map(async (set) => {
      try {
        const values = (await resolveSecretSets(deps, orgId, [set])).get(set.name) ?? {}
        return { name: set.name, ok: true, message: null, keys: Object.keys(values).sort() }
      } catch (error) {
        return { name: set.name, ok: false, message: (error as Error).message.replace(`Secret set ${set.name}: `, ''), keys: [] }
      }
    }),
  )
  return { issues: parsed.issues, sets: results }
}
