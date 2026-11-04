import { json } from '@factorix/db'
import {
  PLATFORM_SETTINGS,
  type PlatformSettingDto,
  type PlatformSettingKey,
  type PlatformSettings,
  type PlatformSettingsInput,
  platformSettingSchema,
} from '@factorix/schemas'
import type { AppDeps } from '../deps'
import type { Env } from '../env'
import { writeAudit } from '../lib/audit'
import { badRequest } from '../lib/errors'
import { emit } from '../lib/outbox'

type Deps = Pick<AppDeps, 'db' | 'env'>

export function envSettings(env: Env): PlatformSettings {
  return {
    runConcurrency: env.FACTORIX_RUN_CONCURRENCY,
    allowScriptedRuntime: env.FACTORIX_ALLOW_SCRIPTED_RUNTIME,
    syncIntervalSeconds: env.FACTORIX_SYNC_INTERVAL_SECONDS,
    closedIssueDays: env.FACTORIX_CLOSED_ISSUE_DAYS,
    noteDebounceMinutes: env.FACTORIX_NOTE_DEBOUNCE_MINUTES,
    ciWaitMinutes: env.FACTORIX_CI_WAIT_MINUTES,
    clearRunCache: env.FACTORIX_CLEAR_RUN_CACHE,
    finishedWorkspaceHours: env.FACTORIX_FINISHED_WORKSPACE_HOURS,
    failedWorkspaceDays: env.FACTORIX_FAILED_WORKSPACE_DAYS,
    openWorkspaceDays: env.FACTORIX_OPEN_WORKSPACE_DAYS,
    failedContainerHours: env.FACTORIX_FAILED_CONTAINER_HOURS,
    publicUrl: env.FACTORIX_PUBLIC_URL,
    cookieSecure: env.COOKIE_SECURE,
    sessionDays: env.FACTORIX_SESSION_DAYS,
  }
}

async function readOverrides(db: Deps['db']): Promise<Partial<PlatformSettings>> {
  const rows = (await db('platform_settings').select('key', 'value')) as { key: string; value: unknown }[]
  const overrides: Record<string, unknown> = {}
  for (const row of rows) {
    const spec = PLATFORM_SETTINGS.find((candidate) => candidate.key === row.key)
    // A value an older version allowed must not take the platform down, so it falls back to the environment.
    if (spec && platformSettingSchema(spec).safeParse(row.value).success) overrides[row.key] = row.value
  }
  return overrides as Partial<PlatformSettings>
}

/** Read from the database each time, so a change reaches the API and the worker without either of them restarting. */
export async function readSettings(deps: Deps): Promise<PlatformSettings> {
  return { ...envSettings(deps.env), ...(await readOverrides(deps.db)) }
}

export async function settingsDtos(deps: Deps): Promise<PlatformSettingDto[]> {
  const defaults = envSettings(deps.env)
  const overrides = await readOverrides(deps.db)
  return PLATFORM_SETTINGS.map(({ key }) => ({
    key,
    value: overrides[key] ?? defaults[key],
    envValue: defaults[key],
    overridden: overrides[key] !== undefined,
  })) as PlatformSettingDto[]
}

export async function updateSettings(deps: Deps, orgId: string, actorId: string, input: PlatformSettingsInput): Promise<void> {
  const { db, env } = deps
  await db.transaction(async (trx) => {
    await trx.raw('LOCK TABLE platform_settings IN SHARE ROW EXCLUSIVE MODE')
    const next: Record<string, unknown> = { ...envSettings(env), ...(await readOverrides(trx as never)) }
    const defaults = envSettings(env) as unknown as Record<string, unknown>
    const changes = Object.entries(input.values).filter(([, value]) => value !== undefined) as [PlatformSettingKey, unknown][]
    for (const [key, value] of changes) next[key] = value === null ? defaults[key] : value
    // Settings cannot be fixed from a page nobody can sign in to.
    if (next.cookieSecure === true && !String(next.publicUrl).startsWith('https://')) {
      throw badRequest('HTTPS-only cookies need an https public URL, or nobody could sign in.')
    }
    for (const [key, value] of changes) {
      if (value === null) await trx('platform_settings').where({ key }).delete()
      else {
        await trx('platform_settings')
          .insert({ key, value: json(value), updatedBy: actorId })
          .onConflict('key')
          .merge({ value: json(value), updatedBy: actorId, updatedAt: trx.fn.now() })
      }
    }
    await writeAudit(trx, {
      orgId,
      actorAccountId: actorId,
      actorKind: 'human',
      action: 'settings.updated',
      targetType: 'organization',
      targetId: orgId,
      metadata: { values: Object.fromEntries(changes) },
    })
    await emit(trx, orgId, { type: 'notify', kind: 'settings', id: orgId })
  })
}
