import type { NotificationConnector, ScmConnector, TrackerConnector } from '@factorix/connectors'
import { GitlabConnector, LinearConnector, SlackConnector } from '@factorix/connectors'
import type { ConnectionRow, Db } from '@factorix/db'
import type { ScriptedPlan } from '@factorix/runtime'
import type { SandboxProvider } from '@factorix/sandbox'
import type { Redis } from 'ioredis'
import type { Env } from './env'
import type { SecretBox } from './lib/crypto'
import type { Queues } from './queues'

export interface ConnectorFactory {
  tracker(connection: ConnectionRow, secret: string): TrackerConnector
  scm(connection: ConnectionRow, secret: string): ScmConnector
  notifier(connection: ConnectionRow, secret: string): NotificationConnector
}

export const realConnectors: ConnectorFactory = {
  tracker(connection, secret) {
    if (connection.kind !== 'linear') throw new Error(`${connection.name} is not a tracker connection`)
    return new LinearConnector({ apiKey: secret, apiUrl: connection.config.apiUrl as string | undefined })
  },
  scm(connection, secret) {
    if (connection.kind !== 'gitlab') throw new Error(`${connection.name} is not a source control connection`)
    return new GitlabConnector({ token: secret, host: connection.config.host as string | undefined })
  },
  notifier(connection, secret) {
    if (connection.kind !== 'slack') throw new Error(`${connection.name} is not a notification connection`)
    return new SlackConnector({ token: secret })
  },
}

export interface AppDeps {
  db: Db
  redis: Redis
  env: Env
  secrets: SecretBox
  connectors: ConnectorFactory
  queues: Queues
  sandbox?: SandboxProvider
  /** Tests replace the default phase scripts for the scripted runtime. */
  scriptFor?: (phase: string, attempt: number) => ScriptedPlan | undefined
  /** Tests shorten these so lease expiry, suspension, and debouncing can run in seconds. */
  timings?: {
    workflowSweepMs?: number
    heartbeatMs?: number
    leaseSeconds?: number
    suspendAfterMs?: number
    recoveryMs?: number
    noteDebounceMs?: number
  }
}
