export * from './doppler/client'
export * from './gitlab/client'
export * from './gitlab/markup'
export * from './gitlab/webhook'
export * from './linear/client'
export * from './linear/markup'
export * from './linear/webhook'
export * from './scm'
export * from './secrets'
export * from './source'
export * from './tracker'

import { dopplerSource } from './doppler/client'
import { gitlabSource } from './gitlab/markup'
import { linearSource } from './linear/markup'
import type { ScmConnector } from './scm'
import { type SecretSource, type SecretSourceKind, storedSecretSource } from './secrets'
import type { ScmSource, TrackerSource } from './source'
import type { TrackerConnector } from './tracker'

export const TRACKER_SOURCES: Record<TrackerConnector['kind'], TrackerSource> = { linear: linearSource }
export const SCM_SOURCES: Record<ScmConnector['kind'], ScmSource> = { gitlab: gitlabSource }
export const SECRET_SOURCES: Record<SecretSourceKind, SecretSource> = { doppler: dopplerSource, generic: storedSecretSource }

export function egressHostsOf(kind: string, config: Record<string, unknown>): string[] {
  const source =
    TRACKER_SOURCES[kind as keyof typeof TRACKER_SOURCES] ??
    SCM_SOURCES[kind as keyof typeof SCM_SOURCES] ??
    SECRET_SOURCES[kind as keyof typeof SECRET_SOURCES]
  return source?.egressHosts(config) ?? []
}

export function scmServerOf(kind: string, config: Record<string, unknown>): string | null {
  return SCM_SOURCES[kind as keyof typeof SCM_SOURCES]?.server(config) ?? null
}

/** Connections an agent can use as its own account, instead of the one its project shares. */
export function accountRoleOf(kind: string): 'scm' | 'tracker' | null {
  if (Object.hasOwn(SCM_SOURCES, kind)) return 'scm'
  return Object.hasOwn(TRACKER_SOURCES, kind) ? 'tracker' : null
}

export * from './notifier'
export * from './slack/client'
export * from './slack/markup'

export function isSecretSourceKind(kind: string): kind is SecretSourceKind {
  return Object.hasOwn(SECRET_SOURCES, kind)
}
