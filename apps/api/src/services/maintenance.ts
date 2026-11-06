import type { EnvironmentInstanceRow, IssueRow, ProjectRow, RunRow, WorkspaceRow } from '@factorix/db'
import type { PlatformSettings } from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { expireApprovals } from './approvals'
import { LIVE_STATES } from './previews'
import { reapRunServices } from './run-services'
import { pollOpenMergeRequests } from './scm-inbound'
import { readSettings } from './settings'
import { IMPORT_STALE_MS, requestProjectImport, syncProjectIssues } from './tracker-sync'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const AD_HOC_RETENTION_MS = DAY

/** Boot and periodic recovery. Claiming is the real guard, so an extra job for a run someone holds does nothing. */
export async function recoverRuns(deps: Pick<AppDeps, 'db' | 'queues'>): Promise<number> {
  const { db, queues } = deps
  const stale = await db<RunRow>('runs')
    .whereIn('state', ['preparing', 'running', 'waiting_approval', 'finalizing'])
    .where((builder) => builder.whereNull('lease_expires_at').orWhere('lease_expires_at', '<', db.fn.now()))
    .select('id')
  const queuedTooLong = await db<RunRow>('runs')
    .where({ state: 'queued' })
    .andWhere('created_at', '<', db.raw(`now() - interval '2 minutes'`))
    .whereExists(db('issues').whereRaw('issues.id = runs.issue_id AND issues.locked_by_run_id = runs.id'))
    .select('id')
  const bucket = Math.floor(Date.now() / 30_000)
  for (const run of [...stale, ...queuedTooLong]) await queues.runsExecute.add('execute', { runId: run.id }, { jobId: `recover-${run.id}-${bucket}` })
  return stale.length + queuedTooLong.length
}

/** How long an issue's disk stays after its last use, by where the issue ended up. */
function retentionMs(issueId: string | null, state: IssueRow['factoryState'] | undefined, settings: PlatformSettings): number {
  if (!issueId) return AD_HOC_RETENTION_MS
  if (state === 'done' || state === 'cancelled') return settings.finishedWorkspaceHours * HOUR
  if (state === 'failed') return settings.failedWorkspaceDays * DAY
  return settings.openWorkspaceDays * DAY
}

export async function reapSandboxes(deps: Pick<AppDeps, 'db' | 'env' | 'sandbox'>): Promise<{ containers: number; volumes: number }> {
  const { db, sandbox } = deps
  if (!sandbox) return { containers: 0, volumes: 0 }
  const settings = await readSettings(deps)
  await reapRunServices({ db, sandbox })
  // Another stack on the same Docker host owns what carries its name. Preview objects without one belong to a process with no
  // stack, such as a test, so only such a process removes them.
  const stack = deps.env.FACTORIX_STACK
  const managed = await sandbox.listManaged()
  const runIds = managed.containers.flatMap((container) => (container.runId ? [container.runId] : []))
  const runs = runIds.length > 0 ? await db<RunRow>('runs').whereIn('id', runIds).select('id', 'state', 'finishedAt') : []
  const byId = new Map(runs.map((run) => [run.id, run]))
  const envKeys = [...new Set([...managed.containers, ...managed.volumes].flatMap((item) => (item.envKey ? [item.envKey] : [])))]
  const instances = envKeys.length > 0 ? await db<EnvironmentInstanceRow>('environment_instances').whereIn('slug', envKeys) : []
  const instanceBySlug = new Map(instances.map((instance) => [instance.slug, instance]))
  const now = Date.now()
  let containers = 0
  for (const container of managed.containers) {
    if (container.kind === 'env' ? container.stack !== stack : container.stack !== undefined && container.stack !== stack) continue
    const age = now - container.createdAt.getTime()
    let remove = false
    if (container.kind === 'step') {
      remove = !container.running && age > HOUR
    } else if (container.kind === 'env') {
      // A start creates containers before it marks anything, so only leftovers older than a start are taken.
      const instance = container.envKey ? instanceBySlug.get(container.envKey) : undefined
      remove = age > 10 * 60_000 && (!instance || !LIVE_STATES.includes(instance.state))
    } else {
      const run = container.runId ? byId.get(container.runId) : undefined
      if (!run) remove = age > HOUR
      else if (run.state === 'succeeded' || run.state === 'cancelled') remove = true
      else if (run.state === 'failed') remove = run.finishedAt ? now - run.finishedAt.getTime() > settings.failedContainerHours * HOUR : true
    }
    if (remove) {
      await sandbox.remove(container.id).catch(() => undefined)
      containers += 1
    }
  }

  let volumes = 0
  // A run can end without the executor, on a lost lease or a cancel while queued, and nothing else would ever free its workspace.
  await db.raw(`
    UPDATE workspaces w SET state = 'ready'
    WHERE w.state = 'in_use' AND NOT EXISTS (
      SELECT 1 FROM runs r
      WHERE (r.workspace_id = w.id OR r.issue_id = w.issue_id) AND r.state NOT IN ('succeeded', 'failed', 'cancelled')
    )
  `)
  const workspaces = await db<WorkspaceRow>('workspaces').whereNot({ state: 'expired' }).whereNot({ state: 'in_use' })
  const issues = await db<IssueRow>('issues')
    .whereIn(
      'id',
      workspaces.flatMap((workspace) => (workspace.issueId ? [workspace.issueId] : [])),
    )
    .select('id', 'factoryState')
  const issueState = new Map(issues.map((issue) => [issue.id, issue.factoryState]))
  for (const workspace of workspaces) {
    const idle = now - workspace.lastUsedAt.getTime()
    const state = workspace.issueId ? issueState.get(workspace.issueId) : undefined
    const limit = retentionMs(workspace.issueId, state, settings)
    if (idle < limit) continue
    // Removing a large volume takes a while, so the list above can be out of date by the time this one comes up.
    const current = await db<WorkspaceRow>('workspaces').where({ id: workspace.id }).first()
    if (!current || current.state === 'in_use') continue
    try {
      await sandbox.destroyWorkspace(workspace.volumeName.replace(/^fx-ws-/, ''))
    } catch {
      continue
    }
    await db.transaction(async (trx) => {
      await trx('workspaces').where({ id: workspace.id }).whereNot({ state: 'in_use' }).update({ state: 'expired' })
      // Agent sessions were stored on that volume, so a later run has nothing to resume.
      await trx('runs').where({ workspaceId: workspace.id }).update({ sessionRef: null })
    })
    volumes += 1
  }

  // A stopped preview keeps its installs and data for a quick restart, as long as the issue would keep its workspace.
  const volumeKeys = new Set(managed.volumes.flatMap((volume) => (volume.envKey && volume.stack === stack ? [volume.envKey] : [])))
  const previewIssues = await db<IssueRow>('issues')
    .whereIn(
      'id',
      instances.flatMap((instance) => (instance.issueId ? [instance.issueId] : [])),
    )
    .select('id', 'factoryState')
  const previewIssueState = new Map(previewIssues.map((issue) => [issue.id, issue.factoryState]))
  for (const key of volumeKeys) {
    const instance = instanceBySlug.get(key)
    if (instance && LIVE_STATES.includes(instance.state)) continue
    const since = instance ? (instance.stoppedAt ?? instance.updatedAt).getTime() : 0
    if (instance?.kind === 'preview' && now - since < retentionMs(instance.issueId, previewIssueState.get(instance.issueId ?? ''), settings)) continue
    try {
      await sandbox.stopEnvironment(key)
      await sandbox.removeEnvironmentVolumes(key, { source: true })
      volumes += 1
    } catch {}
  }

  await db('echo_markers').where('created_at', '<', db.raw(`now() - interval '1 day'`)).delete()
  await db('webhook_deliveries').where('received_at', '<', db.raw(`now() - interval '30 days'`)).delete()
  await db('domain_events').whereNotNull('processedAt').andWhere('ts', '<', db.raw(`now() - interval '30 days'`)).delete()
  await db('auth_sessions').where('expires_at', '<', db.fn.now()).delete()
  return { containers, volumes }
}

/** Catches imports that lost their job, such as a wiped queue, and projects a migration asked to re-import. */
export async function resumeStaleImports(deps: Pick<AppDeps, 'db'>): Promise<number> {
  const { db } = deps
  const stale = await db<ProjectRow>('projects')
    .where({ syncState: 'syncing' })
    .where((builder) => builder.whereNull('sync_heartbeat_at').orWhere('sync_heartbeat_at', '<', new Date(Date.now() - IMPORT_STALE_MS)))
  for (const project of stale) await db.transaction((trx) => requestProjectImport(trx, project))
  return stale.length
}

export async function syncAllProjects(
  deps: Pick<AppDeps, 'db' | 'env' | 'secrets' | 'connectors' | 'queues' | 'timings'>,
  log: (message: string) => void = () => {},
): Promise<void> {
  await expireApprovals(deps)
  await resumeStaleImports(deps)
  const projects = await deps.db<ProjectRow>('projects')
  for (const project of projects) {
    try {
      // Imports run newest first, so an incremental sweep on an unfinished one would mark the older issues as seen and never fetch them.
      if (project.syncState === 'idle') await syncProjectIssues(deps, project)
      await pollOpenMergeRequests(deps, project)
    } catch (error) {
      log(`Sync of project ${project.name} failed: ${(error as Error).message}`)
    }
  }
}
