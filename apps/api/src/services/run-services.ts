import type { EnvironmentInstanceRow, ProjectEnvironmentRow, ProjectRow, RunRow } from '@factorix/db'
import { json } from '@factorix/db'
import type { Environment, SandboxProvider, Workspace } from '@factorix/sandbox'
import { type EnvironmentDefinition, maskSecrets, mergeEnv, startOrder } from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { environmentProxyEnv, revokeProxyGrant, waitUntilReady } from './environment-runtime'
import { resolveSecretSets } from './environments'
import { readySeconds, serviceSpec, templateValues } from './preview-spec'
import { LIVE_STATES, newSlug } from './previews'

/** What the agent container gets from the services the project's environment gives agent runs. */
export interface RunServices {
  /** The services' network, which the agent joins. Null when the run gets values but no services. */
  network: string | null
  /** Values from agent-readable secret sets, then `agents.env`. */
  env: Record<string, string>
  /** Service names, which the agent reaches directly rather than through the egress proxy. */
  noProxy: string[]
  /** A line for the agent's instructions. */
  note: string
}

type Deps = Pick<AppDeps, 'db' | 'env' | 'redis' | 'secrets' | 'connectors'> & { sandbox: SandboxProvider }
type Log = (level: 'info' | 'warn' | 'error', message: string) => void

const ENDED_RUN_STATES = ['succeeded', 'failed', 'cancelled', 'suspended']

/**
 * Starts the image services `agents.services` lists on a network of the run's own, and resolves the values the agent may read.
 * Only sets marked "Agents can read these values" are fetched, for the agent and for the services alike, since the agent can reach both.
 */
export async function startRunServices(
  deps: Deps,
  input: { run: RunRow; project: ProjectRow; workspace: Workspace; repos: string[]; allow: () => Promise<string[]>; ttlSeconds: number; log: Log },
): Promise<RunServices | null> {
  const { db, sandbox, env } = deps
  const { run, log } = input
  const saved = await db<ProjectEnvironmentRow>('project_environments').where({ projectId: input.project.id }).first()
  const definition = saved?.definition as EnvironmentDefinition | null | undefined
  if (!saved || !definition) return null
  const { agents } = definition
  if (agents.services.length === 0 && agents.secrets.length === 0 && Object.keys(agents.env).length === 0) return null

  await stopRunServices(deps, run.id)
  const wanted = new Set([...agents.secrets, ...agents.services.flatMap((name) => definition.services[name]?.secrets ?? [])])
  const sets = saved.secretSets.filter((set) => set.agents && wanted.has(set.name))
  for (const name of wanted) {
    if (!sets.some((set) => set.name === name))
      log('warn', `The secret set ${name} is not marked Agents can read these values, so this run goes without it.`)
  }

  const existing = await db<EnvironmentInstanceRow>('environment_instances').where({ runId: run.id, kind: 'run' }).first()
  const patch = {
    state: 'starting',
    definition: json(definition),
    definitionVersion: saved.version,
    secretSets: json(sets),
    services: json(Object.fromEntries(agents.services.map((name) => [name, { state: 'waiting' }]))),
    error: null,
    startedAt: db.fn.now(),
    readyAt: null,
    stoppedAt: null,
    updatedAt: db.fn.now(),
  }
  const [row] = (
    existing
      ? await db('environment_instances').where({ id: existing.id }).update(patch).returning('*')
      : await db('environment_instances')
          .insert({ ...patch, orgId: run.orgId, projectId: input.project.id, issueId: run.issueId, runId: run.id, kind: 'run', slug: newSlug() })
          .returning('*')
  ) as EnvironmentInstanceRow[]
  const instance = row as EnvironmentInstanceRow

  try {
    const secrets = await resolveSecretSets(deps, run.orgId, sets)
    const values = templateValues(definition, { url: '', host: '' }, input.repos)
    let environment: Environment | null = null
    if (agents.services.length > 0) {
      log('info', `Starting ${agents.services.join(', ')} for this run.`)
      const labels = { 'factorix.instance': instance.id, ...(run.issueId ? { 'factorix.issue': run.issueId } : {}) }
      environment = await sandbox.ensureEnvironment(instance.slug, {
        internal: Boolean(env.FACTORIX_PROXY_URL),
        labels,
        sourceVolume: input.workspace.volume,
      })
      const platformEnv = await environmentProxyEnv(deps, {
        environment,
        services: agents.services,
        bypass: input.project.networkBypass,
        grant: { runId: run.id },
        allow: await input.allow(),
        ttlSeconds: input.ttlSeconds,
      })
      const context = { environment, values, secrets, platformEnv, dataGeneration: 1, labels }
      const masks = [...secrets.values()].flatMap((entry) => Object.values(entry))
      for (const wave of startOrder(definition, agents.services)) {
        const controller = new AbortController()
        await Promise.all(
          wave.map(async (name) => {
            const containerId = await sandbox.startService(environment as Environment, serviceSpec(definition, name, context))
            try {
              await waitUntilReady(sandbox, containerId, { name, timeoutSeconds: readySeconds(definition, name), signal: controller.signal })
            } catch (error) {
              controller.abort()
              throw new Error(`${(error as Error).message}${maskSecrets(await logTail(sandbox, containerId), masks)}`)
            }
          }),
        )
      }
    }
    await db('environment_instances')
      .where({ id: instance.id })
      .update({
        state: 'ready',
        readyAt: db.fn.now(),
        services: json(Object.fromEntries(agents.services.map((name) => [name, { state: 'ready' }]))),
        updatedAt: db.fn.now(),
      })
    return {
      network: environment?.network ?? null,
      env: mergeEnv(
        agents.secrets.map((name) => secrets.get(name) ?? {}),
        agents.env,
        values,
      ),
      noProxy: agents.services,
      note: noteFor(
        definition,
        sets.filter((set) => agents.secrets.includes(set.name)).map((set) => set.name),
      ),
    }
  } catch (error) {
    await stopRunServices(deps, run.id).catch(() => undefined)
    await db('environment_instances')
      .where({ id: instance.id })
      .update({ state: 'failed', error: (error as Error).message.slice(0, 2000), updatedAt: db.fn.now() })
    throw error
  }
}

function noteFor(definition: EnvironmentDefinition, secretSets: string[]): string {
  const { agents } = definition
  const parts: string[] = []
  if (agents.services.length > 0) {
    const addresses = agents.services.map((name) => {
      const port = definition.services[name]?.port
      return port ? `${name} at ${name}:${port}` : name
    })
    parts.push(`These services run next to you for this run: ${addresses.join(', ')}. They start empty and go when the run ends.`)
  }
  const keys = Object.keys(agents.env)
  if (keys.length > 0) parts.push(`The project set ${keys.join(', ')} in your environment for them.`)
  if (secretSets.length > 0)
    parts.push(`Values from the secret sets ${secretSets.join(', ')} are in your environment too. Never print or commit them.`)
  return parts.join(' ')
}

/** The last lines a container wrote, for a run log that says why a service would not start. */
async function logTail(sandbox: SandboxProvider, containerId: string): Promise<string> {
  const lines: string[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)
  await sandbox
    .followLogs(containerId, { signal: controller.signal }, (line) => {
      lines.push(line.text)
      if (lines.length > 20) lines.shift()
    })
    .catch(() => undefined)
  clearTimeout(timer)
  return lines.length > 0 ? `\n${lines.join('\n')}` : ''
}

async function teardown(
  deps: Pick<AppDeps, 'db'> & { sandbox: SandboxProvider; redis?: AppDeps['redis'] },
  row: EnvironmentInstanceRow,
): Promise<void> {
  const { db, sandbox } = deps
  await sandbox.stopEnvironment(row.slug)
  await sandbox.removeEnvironmentVolumes(row.slug, { source: false })
  if (deps.redis) await revokeProxyGrant(deps.redis, row.slug)
  const services = Object.fromEntries(Object.keys(row.services).map((name) => [name, { state: 'stopped' }]))
  await db('environment_instances')
    .where({ id: row.id })
    .update({ state: 'stopped', services: json(services), stoppedAt: db.fn.now(), updatedAt: db.fn.now() })
}

/** Removes a run's services and their data. Runs at the end of a run and when it pauses for a decision. */
export async function stopRunServices(deps: Pick<AppDeps, 'db' | 'redis'> & { sandbox: SandboxProvider }, runId: string): Promise<void> {
  const rows = await deps.db<EnvironmentInstanceRow>('environment_instances').where({ runId, kind: 'run' }).whereIn('state', LIVE_STATES)
  for (const row of rows) await teardown(deps, row)
}

/** Catches services of runs that ended without their worker, such as one that died. */
export async function reapRunServices(deps: Pick<AppDeps, 'db'> & { sandbox: SandboxProvider }): Promise<number> {
  const { db } = deps
  const rows = await db<EnvironmentInstanceRow>('environment_instances')
    .where({ kind: 'run' })
    .whereIn('state', LIVE_STATES)
    .whereIn('runId', db('runs').whereIn('state', ENDED_RUN_STATES).select('id'))
  let stopped = 0
  for (const row of rows) {
    try {
      await teardown(deps, row)
      stopped += 1
    } catch {}
  }
  return stopped
}
