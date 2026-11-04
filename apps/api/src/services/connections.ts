import { type NotificationConnector, type ScmConnector, scmServerOf, type TrackerConnector } from '@factorix/connectors'
import { type ConnectionRow, type Db, json } from '@factorix/db'
import type { ConnectionInput } from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { randomToken } from '../lib/crypto'
import { notFound } from '../lib/errors'

export function decryptConnection(deps: Pick<AppDeps, 'secrets'>, connection: ConnectionRow): string | null {
  if (!connection.secretCiphertext || !connection.secretNonce) return null
  return deps.secrets.decrypt({ ciphertext: connection.secretCiphertext, nonce: connection.secretNonce })
}

function requireSecret(deps: Pick<AppDeps, 'secrets'>, connection: ConnectionRow): string {
  const secret = decryptConnection(deps, connection)
  if (!secret) throw new Error(`Connection ${connection.name} has no secret`)
  return secret
}

export async function getConnection(db: Db, orgId: string, id: string): Promise<ConnectionRow> {
  const row = await db<ConnectionRow>('connections').where({ id, orgId }).first()
  if (!row) throw notFound('Connection')
  return row
}

export function trackerFor(deps: Pick<AppDeps, 'secrets' | 'connectors'>, connection: ConnectionRow): TrackerConnector {
  return deps.connectors.tracker(connection, requireSecret(deps, connection))
}

export function notifierFor(deps: Pick<AppDeps, 'secrets' | 'connectors'>, connection: ConnectionRow): NotificationConnector {
  return deps.connectors.notifier(connection, requireSecret(deps, connection))
}

export function scmFor(deps: Pick<AppDeps, 'secrets' | 'connectors'>, connection: ConnectionRow): ScmConnector {
  return deps.connectors.scm(connection, requireSecret(deps, connection))
}

async function ownAccount(db: Db, agentId: string, role: 'scm' | 'tracker'): Promise<ConnectionRow | undefined> {
  return (await db('connections')
    .join('agent_connections', 'connections.id', 'agent_connections.connection_id')
    .where({ 'agent_connections.agent_id': agentId, 'agent_connections.role': role })
    .select('connections.*')
    .first()) as ConnectionRow | undefined
}

/** Git work runs as the agent's own account when it has one. Repository ids only mean something on one server, so an account elsewhere cannot stand in. */
export async function scmConnectionFor(
  db: Db,
  connectionId: string,
  agentId: string | null | undefined,
  warn?: (message: string) => void,
): Promise<ConnectionRow | undefined> {
  const shared = await db<ConnectionRow>('connections').where({ id: connectionId }).first()
  const own = agentId ? await ownAccount(db, agentId, 'scm') : undefined
  if (!shared || !own) return shared
  if (own.kind === shared.kind && scmServerOf(own.kind, own.config) === scmServerOf(shared.kind, shared.config)) return own
  warn?.(`${own.name} is on a different server than this project, so this run uses ${shared.name}.`)
  return shared
}

export async function trackerConnectionFor(db: Db, orgId: string, connectionId: string, agentId: string | null | undefined): Promise<ConnectionRow> {
  const own = agentId ? await ownAccount(db, agentId, 'tracker') : undefined
  return own ?? getConnection(db, orgId, connectionId)
}

export function encodeSecret(deps: Pick<AppDeps, 'secrets'>, secret: ConnectionInput['secret']): Partial<ConnectionRow> {
  if (secret === undefined) return {}
  const { ciphertext, nonce, keyVersion } = deps.secrets.encrypt(typeof secret === 'string' ? secret : JSON.stringify(secret))
  return { secretCiphertext: ciphertext, secretNonce: nonce, keyVersion }
}

/** Tracker and SCM connections carry an inbound webhook secret, generated once and shown to admins. */
export function withWebhookSecret(kind: string, config: Record<string, unknown>): Record<string, unknown> {
  if ((kind === 'linear' || kind === 'gitlab') && !config.webhookSecret) return { ...config, webhookSecret: randomToken(24) }
  return config
}

export function serializeConfig(config: Record<string, unknown>): string {
  return json(config)
}

export interface ModelCredential {
  provider: 'anthropic' | 'openai'
  apiKey: string
}

/** Agent-linked connection first, then any org connection of that kind, then the environment. */
export async function resolveModelKey(
  deps: Pick<AppDeps, 'db' | 'env' | 'secrets'>,
  orgId: string,
  agentId: string,
  provider: 'anthropic' | 'openai',
): Promise<string | undefined> {
  const linked = await deps
    .db<ConnectionRow>('connections')
    .join('agent_connections', 'connections.id', 'agent_connections.connection_id')
    .where({ 'connections.org_id': orgId, 'connections.kind': provider, 'agent_connections.agent_id': agentId, 'agent_connections.role': 'model' })
    .select('connections.*')
    .first()
  const row = linked ?? (await deps.db<ConnectionRow>('connections').where({ orgId, kind: provider }).orderBy('created_at').first())
  if (row) {
    const secret = decryptConnection(deps, row)
    if (secret) return secret
  }
  return provider === 'anthropic' ? deps.env.ANTHROPIC_API_KEY : deps.env.OPENAI_API_KEY
}
