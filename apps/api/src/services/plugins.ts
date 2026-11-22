import {
  fetchPluginManifest,
  PLUGIN_PERMISSIONS,
  type PluginEndpoint,
  type PluginManifest,
  type PluginPermission,
  parsePluginManifest,
  remoteTracker,
  splitPluginValues,
  type TrackerConnector,
} from '@factorix/connectors'
import type { ConnectionRow, Db, OrganizationPluginRow, PluginRow } from '@factorix/db'
import type { PluginDto } from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { badRequest, notFound } from '../lib/errors'

type Deps = Pick<AppDeps, 'db' | 'secrets'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function manifestOf(plugin: PluginRow): PluginManifest {
  return parsePluginManifest(plugin.manifest)
}

export function endpointOf(deps: Pick<AppDeps, 'secrets'>, plugin: PluginRow): PluginEndpoint {
  return { url: plugin.url, secret: deps.secrets.decrypt({ ciphertext: plugin.secretCiphertext, nonce: plugin.secretNonce }) }
}

export async function getPlugin(db: Db, id: string): Promise<PluginRow> {
  const row = UUID.test(id) ? await db<PluginRow>('plugins').where({ id }).first() : undefined
  if (!row) throw notFound('Plugin')
  return row
}

/** A plugin only does anything for an organization that turned it on. */
export async function enabledPlugin(db: Db, orgId: string, id: string): Promise<{ plugin: PluginRow; enabled: OrganizationPluginRow }> {
  const plugin = await getPlugin(db, id)
  const enabled = await db<OrganizationPluginRow>('organization_plugins').where({ orgId, pluginId: plugin.id }).first()
  if (!enabled) throw badRequest(`${plugin.name} is not turned on for this organization`)
  return { plugin, enabled }
}

/** A permission holds only while the manifest still asks for it and the organization's admin allowed it. */
export function pluginAllows(plugin: PluginRow, enabled: OrganizationPluginRow, permission: PluginPermission): boolean {
  return manifestOf(plugin).permissions.includes(permission) && enabled.permissions.includes(permission)
}

export function secretsOf(
  deps: Pick<AppDeps, 'secrets'>,
  row: { secretCiphertext: Buffer | null; secretNonce: Buffer | null },
): Record<string, string> {
  if (!row.secretCiphertext || !row.secretNonce) return {}
  return JSON.parse(deps.secrets.decrypt({ ciphertext: row.secretCiphertext, nonce: row.secretNonce })) as Record<string, string>
}

export async function readManifest(endpoint: PluginEndpoint): Promise<PluginManifest> {
  try {
    return await fetchPluginManifest(endpoint)
  } catch (error) {
    throw badRequest((error as Error).message)
  }
}

/** What a plugin connection stores: the plugin it belongs to, and the fields its manifest names. */
export async function pluginConnectionValues(
  deps: Deps,
  orgId: string,
  config: Record<string, unknown>,
  secret: unknown,
): Promise<{ config: Record<string, unknown>; secret: Record<string, string> }> {
  const { plugin } = await enabledPlugin(deps.db, orgId, String(config.pluginId ?? ''))
  const manifest = manifestOf(plugin)
  if (!manifest.provides.includes('tracker')) throw badRequest(`${plugin.name} has nothing to connect`)
  const typed = { ...config, ...(secret && typeof secret === 'object' ? (secret as Record<string, string>) : {}) }
  let values: ReturnType<typeof splitPluginValues>
  try {
    values = splitPluginValues(manifest.connection.fields, typed)
  } catch (error) {
    throw badRequest((error as Error).message)
  }
  return { config: { ...values.config, pluginId: plugin.id }, secret: values.secrets }
}

const RESERVED = new Set(['pluginId', 'webhookSecret'])

/** The endpoint is read when the first call is made, so the plugin's secret is only decrypted for a call that happens. */
export function pluginTrackerFor(deps: Deps, connection: ConnectionRow): TrackerConnector {
  const config = Object.fromEntries(
    Object.entries(connection.config).filter(([key, value]) => !RESERVED.has(key) && typeof value === 'string'),
  ) as Record<string, string>
  return remoteTracker(
    async () => endpointOf(deps, (await enabledPlugin(deps.db, connection.orgId, String(connection.config.pluginId ?? ''))).plugin),
    { id: connection.id, config, secrets: secretsOf(deps, connection) },
  )
}

export function pluginDto(plugin: PluginRow, enabled: OrganizationPluginRow | undefined, installationAdmin: boolean): PluginDto {
  const manifest = manifestOf(plugin)
  const secretKeys = new Set(manifest.settings.fields.filter((field) => field.type === 'secret').map((field) => field.key))
  return {
    id: plugin.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? null,
    url: installationAdmin ? plugin.url : null,
    provides: manifest.provides,
    connectionFields: manifest.connection.fields,
    settingsFields: manifest.settings.fields,
    pages: manifest.pages.map(({ key, label, placement }) => ({ key, label, placement })),
    permissions: manifest.permissions.map((id) => ({
      id,
      description: PLUGIN_PERMISSIONS[id],
      granted: enabled?.permissions.includes(id) ?? false,
    })),
    bundled: plugin.bundled,
    enabled: Boolean(enabled),
    settings: enabled?.config ?? {},
    // The names of the stored secrets come from the row's own marker, never from decrypting them for a list.
    secretSettings: enabled?.secretCiphertext ? [...secretKeys] : [],
  }
}
