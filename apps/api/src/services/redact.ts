import type { ConnectionRow, ProjectEnvironmentRow } from '@factorix/db'
import { maskSecrets } from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { decryptConnection } from './connections'
import { resolveSecretSets } from './environments'

export const REDACTED = '[secret removed]'

/** Formats that are credentials wherever they appear. */
const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\bgl(?:pat|ptt|dt|rt|cbt|soat|ft|imt|agent)-[A-Za-z0-9_-]{20,}/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{32,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bdp\.(?:st|sa|ct|pt|scim|audit)\.[A-Za-z0-9._-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
]

/** The password in a URL such as postgres://user:password@host. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi

/** Variable names that say the value is secret. Configs mix them with settings such as NODE_ENV, which must stay readable. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PRIVATE|CREDENTIAL|AUTH|DSN|SIGNING|SALT|COOKIE|SESSION|CERT/i
const MIN_LENGTH = 8

export function redactTokens(text: string): string {
  let redacted = text.replace(URL_PASSWORD, `$1${REDACTED}@`)
  for (const pattern of TOKEN_PATTERNS) redacted = redacted.replace(pattern, REDACTED)
  return redacted
}

/** A connection's secret is a token, or a map of variables or headers. */
export function connectionSecretValues(secret: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(secret)
  } catch {
    return secret.length >= MIN_LENGTH ? [secret] : []
  }
  if (typeof parsed === 'string') return parsed.length >= MIN_LENGTH ? [parsed] : []
  if (!parsed || typeof parsed !== 'object') return []
  const record = parsed as Record<string, unknown>
  const env = record.env && typeof record.env === 'object' ? (record.env as Record<string, unknown>) : record
  return secretValuesOf(env)
}

export function secretValuesOf(values: Record<string, unknown>): string[] {
  return Object.entries(values).flatMap(([key, value]) =>
    typeof value === 'string' && value.length >= MIN_LENGTH && SECRET_NAME.test(key) ? [value] : [],
  )
}

/**
 * Masks what an agent reads: every connection token in the organization, the project's secret values, and known token formats.
 * Text from the tracker is written by people, who paste keys by mistake. If the secret sets cannot be read, the formats still apply.
 */
export async function agentRedactor(
  deps: Pick<AppDeps, 'db' | 'secrets' | 'connectors'>,
  input: { orgId: string; projectId: string | null },
  warn: (message: string) => void,
): Promise<(text: string) => string> {
  const values: string[] = []
  for (const connection of await deps.db<ConnectionRow>('connections').where({ orgId: input.orgId })) {
    const secret = decryptConnection(deps, connection)
    if (secret) values.push(...connectionSecretValues(secret))
  }
  const saved = input.projectId
    ? await deps.db<ProjectEnvironmentRow>('project_environments').where({ projectId: input.projectId }).first()
    : undefined
  if (saved && saved.secretSets.length > 0) {
    try {
      for (const set of (await resolveSecretSets(deps, input.orgId, saved.secretSets)).values()) values.push(...secretValuesOf(set))
    } catch (error) {
      warn(
        `Could not read the project's secret values to hide them from the agent, so only known token formats are hidden: ${(error as Error).message}`,
      )
    }
  }
  return (text) => redactTokens(maskSecrets(text, values, REDACTED))
}
