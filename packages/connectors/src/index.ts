export * from './gitlab/client'
export * from './gitlab/markup'
export * from './gitlab/webhook'
export * from './linear/client'
export * from './linear/markup'
export * from './linear/webhook'
export * from './scm'
export * from './source'
export * from './tracker'

import { gitlabSource } from './gitlab/markup'
import { linearSource } from './linear/markup'
import type { ScmConnector } from './scm'
import type { ScmSource, TrackerSource } from './source'
import type { TrackerConnector } from './tracker'

export const TRACKER_SOURCES: Record<TrackerConnector['kind'], TrackerSource> = { linear: linearSource }
export const SCM_SOURCES: Record<ScmConnector['kind'], ScmSource> = { gitlab: gitlabSource }

export function egressHostsOf(kind: string, config: Record<string, unknown>): string[] {
  const source = TRACKER_SOURCES[kind as keyof typeof TRACKER_SOURCES] ?? SCM_SOURCES[kind as keyof typeof SCM_SOURCES]
  return source?.egressHosts(config) ?? []
}

export * from './notifier'
export * from './slack/client'
export * from './slack/markup'
