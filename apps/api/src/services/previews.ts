import { randomInt } from 'node:crypto'
import { type Db, type EnvironmentInstanceRow, type EnvironmentInstanceState, type IssueRow, json, type ProjectRow } from '@factorix/db'
import type { EnvironmentDefinition, PreviewDto, PreviewOpenDto } from '@factorix/schemas'
import type { Knex } from 'knex'
import type { AppDeps } from '../deps'
import { writeAudit } from '../lib/audit'
import { previewKeys } from '../lib/channels'
import { randomToken } from '../lib/crypto'
import { conflict, HttpError } from '../lib/errors'
import { type EnvironmentAction, emit } from '../lib/outbox'
import { definitionOf, getEnvironmentRow } from './environments'
import { previewAddress } from './preview-spec'
import { readSettings } from './settings'

const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const TICKET_SECONDS = 60
export const LIVE_STATES: EnvironmentInstanceState[] = ['starting', 'ready', 'refreshing', 'stopping']

export function newSlug(): string {
  return Array.from({ length: 10 }, () => SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)]).join('')
}

export async function previewOf(db: Db | Knex.Transaction, issueId: string): Promise<EnvironmentInstanceRow | undefined> {
  return db<EnvironmentInstanceRow>('environment_instances').where({ issueId, kind: 'preview' }).first()
}

function unavailableReason(definition: EnvironmentDefinition | null): string | null {
  if (!definition) return 'This project has no environment yet. An admin can add one on the project’s Environment page.'
  if (!definition.expose) return 'The project’s environment has nothing to open. Add expose to it.'
  return null
}

export async function previewDto(deps: Pick<AppDeps, 'db' | 'env'>, issue: IssueRow): Promise<PreviewDto> {
  const { db, env } = deps
  const environment = issue.projectId ? await getEnvironmentRow(db, issue.projectId) : undefined
  const current = definitionOf(environment)
  const row = await previewOf(db, issue.id)
  const live = row && row.state !== 'stopped' && row.state !== 'failed'
  const definition = (live ? (row.definition as EnvironmentDefinition | null) : null) ?? current
  const settings = await readSettings(deps)
  const startedBy = row?.startedBy ? await db('accounts').where({ id: row.startedBy }).select('id', 'displayName').first() : undefined
  let stopsAt: Date | null = null
  if (row?.state === 'ready' && row.expiresAt) {
    stopsAt = row.expiresAt
    const lastActive = Math.max(row.lastSeenAt?.getTime() ?? 0, row.readyAt?.getTime() ?? 0)
    if (settings.previewIdleMinutes > 0 && lastActive > 0) {
      const idleAt = new Date(lastActive + settings.previewIdleMinutes * 60_000)
      if (idleAt < stopsAt) stopsAt = idleAt
    }
  }
  return {
    unavailable: unavailableReason(current),
    state: row?.state ?? null,
    url: row ? previewAddress(env.FACTORIX_PREVIEW_URL, row.slug).url : null,
    services: Object.entries(definition?.services ?? {}).map(([name, entry]) => {
      const status = live ? row.services[name] : undefined
      return { name, state: status?.state ?? 'stopped', message: status?.message ?? null, repo: entry.repo ?? null, image: entry.image ?? null }
    }),
    commits: Object.entries(row?.commits ?? {}).map(([repo, commit]) => ({ repo, ...commit })),
    source: row?.source ?? null,
    error: row?.error ?? null,
    startedBy: startedBy ? { id: startedBy.id as string, name: startedBy.displayName as string } : null,
    startedAt: row?.startedAt?.toISOString() ?? null,
    readyAt: row?.readyAt?.toISOString() ?? null,
    lastSeenAt: row?.lastSeenAt?.toISOString() ?? null,
    stopsAt: stopsAt?.toISOString() ?? null,
    definitionVersion: row?.definitionVersion ?? null,
    currentVersion: environment?.version ?? null,
    notes: definition?.notes ?? null,
  }
}

const ALLOWED_FROM: Record<EnvironmentAction, (EnvironmentInstanceState | null)[]> = {
  start: [null, 'stopped', 'failed'],
  reset: ['ready', 'stopped', 'failed'],
  refresh: ['ready'],
  stop: ['starting', 'ready', 'refreshing'],
}

const REFUSED: Record<EnvironmentAction, string> = {
  start: 'This preview is already running.',
  reset: 'Wait until the preview is ready or stopped, then reset its data.',
  refresh: 'Only a ready preview can be refreshed.',
  stop: 'This preview is not running.',
}

export type PreviewActor = { kind: 'human' | 'agent'; accountId: string } | { kind: 'system'; reason: string }

/** Every change of a preview goes through here, so the state check, the job, and the audit entry commit together. */
export async function requestPreview(
  deps: Pick<AppDeps, 'db' | 'env'>,
  issue: IssueRow,
  action: EnvironmentAction,
  actor: PreviewActor,
  options: { source?: EnvironmentInstanceRow['source'] } = {},
): Promise<void> {
  const { db } = deps
  const settings = await readSettings(deps)
  await db.transaction(async (trx) => {
    // One lock per organization keeps two starts from both slipping under the cap.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`previews:${issue.orgId}`])
    const row = await trx<EnvironmentInstanceRow>('environment_instances').where({ issueId: issue.id, kind: 'preview' }).forUpdate().first()
    if (!ALLOWED_FROM[action].includes(row?.state ?? null)) throw conflict(row ? REFUSED[action] : 'This issue has no preview yet.')

    const patch: Partial<EnvironmentInstanceRow> = {}
    if (action === 'start' || action === 'reset') {
      const project = issue.projectId ? await trx<ProjectRow>('projects').where({ id: issue.projectId }).first() : undefined
      const environment = project ? await getEnvironmentRow(trx as unknown as Db, project.id) : undefined
      const definition = definitionOf(environment)
      const reason = unavailableReason(definition)
      if (reason || !environment || !definition) throw new HttpError(409, 'no_environment', reason ?? 'This project has no environment yet.')
      if (row?.state !== 'ready') {
        const [{ count }] = (await trx('environment_instances')
          .where({ orgId: issue.orgId, kind: 'preview' })
          .whereIn('state', LIVE_STATES)
          .count({ count: '*' })) as unknown as [{ count: string }]
        if (Number(count) >= settings.previewMaxRunning) {
          throw new HttpError(
            409,
            'too_many_previews',
            `${count} ${Number(count) === 1 ? 'preview is' : 'previews are'} running, the most allowed at once. Stop one first.`,
          )
        }
      }
      Object.assign(patch, {
        state: 'starting',
        definition: json(definition),
        definitionVersion: environment.version,
        secretSets: json(environment.secretSets),
        services: json(Object.fromEntries(Object.keys(definition.services).map((name) => [name, { state: 'waiting' }]))),
        commits: json({}),
        source: options.source ?? 'branch',
        error: null,
        startedBy: actor.kind === 'system' ? null : actor.accountId,
        startedAt: trx.fn.now(),
        readyAt: null,
        lastSeenAt: null,
        stoppedAt: null,
        expiresAt: trx.raw(`now() + make_interval(hours => ?)`, [settings.previewMaxHours]),
      })
      if (action === 'reset' && row) patch.dataGeneration = row.dataGeneration + 1
    } else if (action === 'refresh') {
      patch.state = 'refreshing'
      patch.source = options.source ?? 'branch'
    } else {
      patch.state = 'stopping'
    }

    const [instance] = (
      row
        ? await trx('environment_instances')
            .where({ id: row.id })
            .update({ ...patch, updatedAt: trx.fn.now() })
            .returning('*')
        : await trx('environment_instances')
            .insert({ ...patch, orgId: issue.orgId, projectId: issue.projectId, issueId: issue.id, kind: 'preview', slug: newSlug() })
            .returning('*')
    ) as [EnvironmentInstanceRow]
    await emit(trx, issue.orgId, { type: 'environment.action', instanceId: instance.id, action })
    await emit(trx, issue.orgId, { type: 'notify', kind: 'issue', id: issue.id, projectId: issue.projectId })
    await writeAudit(trx, {
      orgId: issue.orgId,
      actorAccountId: actor.kind === 'system' ? null : actor.accountId,
      actorKind: actor.kind,
      action: `preview.${action}`,
      targetType: 'issue',
      targetId: issue.id,
      metadata: {
        slug: instance.slug,
        ...(actor.kind === 'system' ? { reason: actor.reason } : {}),
        ...(options.source === 'worktree' ? { source: 'worktree' } : {}),
      },
    })
  })
}

/** A one-minute ticket the gateway swaps for its own cookie, so a Factorix session never reaches a preview's address. */
export async function openPreview(
  deps: Pick<AppDeps, 'db' | 'redis' | 'env'>,
  issue: IssueRow,
  accountId: string,
  path = '/',
): Promise<PreviewOpenDto> {
  const row = await previewOf(deps.db, issue.id)
  if (!row || (row.state !== 'ready' && row.state !== 'refreshing')) throw conflict('This preview is not ready to open.')
  const ticket = randomToken(32)
  await deps.redis.set(previewKeys.ticket(ticket), JSON.stringify({ slug: row.slug, accountId }), 'EX', TICKET_SECONDS)
  const target = new URL('/__factorix/enter', previewAddress(deps.env.FACTORIX_PREVIEW_URL, row.slug).url)
  target.searchParams.set('ticket', ticket)
  if (path !== '/') target.searchParams.set('to', path)
  return { url: target.toString() }
}

/** New commits on a ready preview's branch reach it without anyone asking. */
export async function refreshAfterPush(db: Db, issueId: string): Promise<void> {
  await db.transaction(async (trx) => {
    const [row] = (await trx('environment_instances')
      .where({ issueId, kind: 'preview', state: 'ready' })
      .update({ state: 'refreshing', source: 'branch', updatedAt: trx.fn.now() })
      .returning('*')) as EnvironmentInstanceRow[]
    if (!row) return
    await emit(trx, row.orgId, { type: 'environment.action', instanceId: row.id, action: 'refresh' })
    await emit(trx, row.orgId, { type: 'notify', kind: 'issue', id: issueId, projectId: row.projectId })
  })
}
