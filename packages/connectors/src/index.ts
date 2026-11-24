export * from './doppler/client'
export * from './factorix/source'
export * from './github/client'
export * from './github/markup'
export * from './github/webhook'
export * from './gitlab/client'
export * from './gitlab/markup'
export * from './gitlab/webhook'
export * from './jira/client'
export * from './jira/markup'
export * from './jira/webhook'
export * from './linear/client'
export * from './linear/markup'
export * from './linear/webhook'
export * from './models'
export * from './oauth/chatgpt'
export * from './oauth/oauth'
export * from './plugin/package'
export * from './plugin/protocol'
export * from './plugin/registry'
export * from './plugin/remote'
export * from './plugin/webhook'
export * from './scm'
export * from './secrets'
export * from './source'
export * from './tracker'
export * from './trello/client'
export * from './trello/markup'
export * from './trello/webhook'

import { dopplerSource } from './doppler/client'
import { factorixSource } from './factorix/source'
import { githubSource } from './github/markup'
import { githubWebhookCodec } from './github/webhook'
import { gitlabSource } from './gitlab/markup'
import { gitlabWebhookCodec } from './gitlab/webhook'
import { jiraSource } from './jira/markup'
import { jiraWebhookCodec } from './jira/webhook'
import { linearSource } from './linear/markup'
import { linearWebhookCodec } from './linear/webhook'
import { pluginSource, pluginWebhookCodec } from './plugin/webhook'
import type { ScmConnector, ScmWebhookCodec } from './scm'
import { type SecretSource, type SecretSourceKind, storedSecretSource } from './secrets'
import type { ScmSource, TrackerSource } from './source'
import type { TrackerConnector, TrackerWebhookCodec } from './tracker'
import { trelloSource } from './trello/markup'
import { trelloWebhookCodec } from './trello/webhook'

export const TRACKER_SOURCES: Record<TrackerConnector['kind'], TrackerSource> = {
  linear: linearSource,
  factorix: factorixSource,
  jira: jiraSource,
  trello: trelloSource,
  plugin: pluginSource,
}
/** Built-in tickets live in Factorix's own database, so nothing calls in about them. */
export const TRACKER_WEBHOOK_CODECS: Partial<Record<TrackerConnector['kind'], TrackerWebhookCodec>> = {
  linear: linearWebhookCodec,
  jira: jiraWebhookCodec,
  trello: trelloWebhookCodec,
  plugin: pluginWebhookCodec,
}
export const SCM_SOURCES: Record<ScmConnector['kind'], ScmSource> = { gitlab: gitlabSource, github: githubSource }
export const SCM_WEBHOOK_CODECS: Record<ScmConnector['kind'], ScmWebhookCodec> = { gitlab: gitlabWebhookCodec, github: githubWebhookCodec }
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

/** Connections an agent can use as its own account, instead of the one its project shares. Built-in tickets have no accounts. */
export function accountRoleOf(kind: string): 'scm' | 'tracker' | null {
  if (Object.hasOwn(SCM_SOURCES, kind)) return 'scm'
  return Object.hasOwn(TRACKER_SOURCES, kind) && kind !== 'factorix' ? 'tracker' : null
}

export function hasWebhookOf(kind: string): boolean {
  return Object.hasOwn(SCM_WEBHOOK_CODECS, kind) || Object.hasOwn(TRACKER_WEBHOOK_CODECS, kind) || kind === 'slack'
}

export * from './notifier'
export * from './slack/client'
export * from './slack/events'
export * from './slack/markup'

export function isSecretSourceKind(kind: string): kind is SecretSourceKind {
  return Object.hasOwn(SECRET_SOURCES, kind)
}
