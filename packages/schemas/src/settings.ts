import { z } from 'zod'

export interface PlatformSettings {
  runConcurrency: number
  allowScriptedRuntime: boolean
  syncIntervalSeconds: number
  closedIssueDays: number
  noteDebounceMinutes: number
  ciWaitMinutes: number
  clearRunCache: boolean
  finishedWorkspaceHours: number
  failedWorkspaceDays: number
  openWorkspaceDays: number
  failedContainerHours: number
  publicUrl: string
  cookieSecure: boolean
  sessionDays: number
}

export type PlatformSettingKey = keyof PlatformSettings

export interface PlatformSettingSpec {
  key: PlatformSettingKey
  env: string
  group: 'Agents' | 'Sync' | 'Disk' | 'Access'
  label: string
  hint: string
  kind: 'integer' | 'boolean' | 'url'
  unit?: string
  min?: number
  max?: number
}

/**
 * The environment sets the defaults and an admin can override them on Settings, General. Anything that would let the web UI reach
 * a credential stays out of here: the sandbox image, for one, runs the steps that hold the git token.
 */
export const PLATFORM_SETTINGS: readonly PlatformSettingSpec[] = [
  {
    key: 'runConcurrency',
    env: 'FACTORIX_RUN_CONCURRENCY',
    group: 'Agents',
    label: 'Agents running at once',
    hint: 'Per worker. More runs wait in the queue. Runs already going are not stopped when you lower it.',
    kind: 'integer',
    min: 1,
    max: 50,
  },
  {
    key: 'allowScriptedRuntime',
    env: 'FACTORIX_ALLOW_SCRIPTED_RUNTIME',
    group: 'Agents',
    label: 'Allow the scripted runtime',
    hint: 'A stand-in for the model, for trying the flow without a key. Keep it off in production.',
    kind: 'boolean',
  },
  {
    key: 'syncIntervalSeconds',
    env: 'FACTORIX_SYNC_INTERVAL_SECONDS',
    group: 'Sync',
    label: 'Sync interval',
    hint: 'How often issues and merge requests are polled. This is what catches up when webhooks cannot reach you.',
    kind: 'integer',
    unit: 'seconds',
    min: 30,
    max: 86_400,
  },
  {
    key: 'closedIssueDays',
    env: 'FACTORIX_CLOSED_ISSUE_DAYS',
    group: 'Sync',
    label: 'Closed issues to import',
    hint: 'How far back an import reaches for closed issues. Open issues always import. Applies from the next import.',
    kind: 'integer',
    unit: 'days',
    min: 0,
    max: 3650,
  },
  {
    key: 'noteDebounceMinutes',
    env: 'FACTORIX_NOTE_DEBOUNCE_MINUTES',
    group: 'Sync',
    label: 'Wait after a review comment',
    hint: 'Comments in this window become one round of changes for the agent.',
    kind: 'integer',
    unit: 'minutes',
    min: 0,
    max: 1440,
  },
  {
    key: 'ciWaitMinutes',
    env: 'FACTORIX_CI_WAIT_MINUTES',
    group: 'Sync',
    label: 'Longest wait for CI',
    hint: 'The reviewer starts after this even if a pipeline is still running.',
    kind: 'integer',
    unit: 'minutes',
    min: 1,
    max: 1440,
  },
  {
    key: 'clearRunCache',
    env: 'FACTORIX_CLEAR_RUN_CACHE',
    group: 'Disk',
    label: 'Clear package caches after each run',
    hint: 'Caches are usually most of a workspace. Installed dependencies stay, so only a changed lockfile downloads again.',
    kind: 'boolean',
  },
  {
    key: 'finishedWorkspaceHours',
    env: 'FACTORIX_FINISHED_WORKSPACE_HOURS',
    group: 'Disk',
    label: 'Keep a finished issue’s workspace',
    hint: 'After an issue is done or cancelled. With 0, it goes at the next cleanup, which runs every 15 minutes.',
    kind: 'integer',
    unit: 'hours',
    min: 0,
    max: 8760,
  },
  {
    key: 'failedWorkspaceDays',
    env: 'FACTORIX_FAILED_WORKSPACE_DAYS',
    group: 'Disk',
    label: 'Keep a failed issue’s workspace',
    hint: 'It can hold work that never got pushed, and a retry picks up from it.',
    kind: 'integer',
    unit: 'days',
    min: 0,
    max: 365,
  },
  {
    key: 'openWorkspaceDays',
    env: 'FACTORIX_OPEN_WORKSPACE_DAYS',
    group: 'Disk',
    label: 'Keep an idle open issue’s workspace',
    hint: 'Counted from its last run. A later run clones again and starts a new agent session.',
    kind: 'integer',
    unit: 'days',
    min: 1,
    max: 365,
  },
  {
    key: 'failedContainerHours',
    env: 'FACTORIX_FAILED_CONTAINER_HOURS',
    group: 'Disk',
    label: 'Keep a failed agent’s container',
    hint: 'For looking at what went wrong.',
    kind: 'integer',
    unit: 'hours',
    min: 0,
    max: 168,
  },
  {
    key: 'publicUrl',
    env: 'FACTORIX_PUBLIC_URL',
    group: 'Access',
    label: 'Public URL',
    hint: 'Used for webhooks and links in messages. Webhooks already registered keep their old address, and link previews keep the one the web image was built with.',
    kind: 'url',
  },
  {
    key: 'cookieSecure',
    env: 'COOKIE_SECURE',
    group: 'Access',
    label: 'HTTPS-only sign-in cookies',
    hint: 'Needs an https public URL, because browsers would otherwise drop the cookie and nobody could sign in.',
    kind: 'boolean',
  },
  {
    key: 'sessionDays',
    env: 'FACTORIX_SESSION_DAYS',
    group: 'Access',
    label: 'Stay signed in for',
    hint: 'Counted from the last visit. Applies to new sign-ins and the next renewal of current ones.',
    kind: 'integer',
    unit: 'days',
    min: 1,
    max: 365,
  },
]

export function platformSettingSchema(spec: PlatformSettingSpec): z.ZodType<number | boolean | string> {
  if (spec.kind === 'boolean') return z.boolean()
  if (spec.kind === 'url') return z.url({ protocol: /^https?$/, error: 'Use an http or https address' })
  return z
    .number()
    .int('Use a whole number')
    .min(spec.min ?? 0, `At least ${spec.min ?? 0}`)
    .max(spec.max ?? Number.MAX_SAFE_INTEGER, `At most ${spec.max}`)
}

/** Null clears the override, so the environment's value applies again. */
export const platformSettingsInput = z.object({
  values: z.strictObject(Object.fromEntries(PLATFORM_SETTINGS.map((spec) => [spec.key, platformSettingSchema(spec).nullable().optional()]))),
})
export interface PlatformSettingsInput {
  values: { [K in PlatformSettingKey]?: PlatformSettings[K] | null }
}

export interface PlatformSettingDto<K extends PlatformSettingKey = PlatformSettingKey> {
  key: K
  value: PlatformSettings[K]
  envValue: PlatformSettings[K]
  overridden: boolean
}
