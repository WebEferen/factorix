import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** A plugin is a server someone else runs. Factorix calls it at one address, and it calls back with events, both signed with one shared secret. */
export const PLUGIN_PROTOCOL = 1
export const PLUGIN_SIGNATURE_HEADER = 'x-factorix-signature'
export const PLUGIN_TIMESTAMP_HEADER = 'x-factorix-timestamp'
export const PLUGIN_DELIVERY_HEADER = 'x-factorix-delivery'
const TOLERANCE_MS = 5 * 60_000

export interface PluginField {
  key: string
  label: string
  /** A secret field is stored encrypted and never returned by the API. */
  type: 'text' | 'url' | 'secret'
  required?: boolean
  placeholder?: string
  hint?: string
}

export interface PluginManifest {
  protocol: number
  name: string
  version: string
  description?: string
  provides: 'tracker'[]
  /** What an admin fills in to connect one account of the service behind the plugin. */
  connection: { fields: PluginField[] }
  /** What an organization's admin sets once for the whole plugin, on its card under Settings. */
  settings: { fields: PluginField[] }
  /** Pages the plugin serves itself, shown inside Factorix in a frame. */
  pages: PluginPage[]
}

export interface PluginPage {
  key: string
  label: string
  /** Relative to the plugin's address, so a page can never point somewhere else. */
  path: string
  placement: 'sidebar' | 'settings'
}

/** What a page learns about who opened it. It travels in the page's address, signed, and is good for a few minutes. */
export interface PluginPageContext {
  exp: number
  page: string
  org: { id: string; name: string }
  account: { id: string; name: string; role: string }
  settings: Record<string, string>
}

export function signPluginPage(secret: string, context: PluginPageContext): string {
  const payload = Buffer.from(JSON.stringify(context)).toString('base64url')
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`
}

/** What a plugin is told about the connection it is answering for. It holds nothing between calls. */
export interface PluginConnection {
  id: string
  config: Record<string, string>
  secrets: Record<string, string>
}

export interface PluginRequest {
  protocol: number
  method: string
  params: unknown[]
  connection: PluginConnection | null
}

export function signPlugin(secret: string, timestamp: string, body: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')}`
}

const digest = (value: string) => createHash('sha256').update(value).digest()

/** The timestamp is signed with the body, so a captured request stops working after a few minutes. */
export function verifyPlugin(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  body: string | Buffer,
  now = Date.now(),
): boolean {
  if (!secret || !timestamp || !signature) return false
  const sent = Number(timestamp)
  if (!Number.isFinite(sent) || Math.abs(now - sent) > TOLERANCE_MS) return false
  return timingSafeEqual(digest(signature), digest(signPlugin(secret, timestamp, body)))
}

const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

/** A manifest comes from someone else's server, so it is read field by field and anything unexpected is refused. */
export function parsePluginManifest(value: unknown): PluginManifest {
  const raw = (value ?? {}) as Record<string, unknown>
  if (raw.protocol !== PLUGIN_PROTOCOL)
    throw new Error(`The plugin speaks protocol ${String(raw.protocol)}, and this Factorix speaks ${PLUGIN_PROTOCOL}`)
  if (!text(raw.name, 80) || !text(raw.version, 40)) throw new Error('The plugin manifest needs a name and a version')
  const provides = Array.isArray(raw.provides) && raw.provides.includes('tracker') ? (['tracker'] as const) : []
  const pages = (raw.pages ?? []) as Record<string, unknown>[]
  if (!Array.isArray(pages) || pages.length > 10) throw new Error('The plugin manifest lists its pages wrongly')
  if (provides.length === 0 && pages.length === 0) throw new Error('The plugin provides nothing this Factorix can use: no tracker and no pages')
  return {
    protocol: PLUGIN_PROTOCOL,
    name: raw.name,
    version: raw.version,
    ...(text(raw.description, 300) ? { description: raw.description } : {}),
    provides: [...provides],
    connection: { fields: parseFields((raw.connection as { fields?: unknown } | undefined)?.fields) },
    settings: { fields: parseFields((raw.settings as { fields?: unknown } | undefined)?.fields) },
    pages: pages.map((page) => {
      if (!text(page.key, 40) || !FIELD_KEY.test(page.key) || !text(page.label, 40)) throw new Error('A plugin page needs a key and a label')
      if (!text(page.path, 200) || !page.path.startsWith('/') || page.path.startsWith('//') || /[\\\s]/.test(page.path)) {
        throw new Error(`Plugin page ${page.key} needs a path that starts with one slash`)
      }
      return { key: page.key, label: page.label, path: page.path, placement: page.placement === 'settings' ? 'settings' : 'sidebar' }
    }),
  }
}

function parseFields(value: unknown): PluginField[] {
  const fields = (value ?? []) as Record<string, unknown>[]
  if (!Array.isArray(fields) || fields.length > 20) throw new Error('The plugin manifest lists its fields wrongly')
  return fields.map((field) => {
    if (!text(field.key, 40) || !FIELD_KEY.test(field.key) || !text(field.label, 80)) throw new Error('A plugin field needs a key and a label')
    if (field.type !== 'text' && field.type !== 'url' && field.type !== 'secret') throw new Error(`Plugin field ${field.key} has an unknown type`)
    return {
      key: field.key,
      label: field.label,
      type: field.type,
      ...(field.required === true ? { required: true } : {}),
      ...(text(field.placeholder, 200) ? { placeholder: field.placeholder } : {}),
      ...(text(field.hint, 300) ? { hint: field.hint } : {}),
    }
  })
}

/** Splits what an admin typed into what is stored in the open and what is encrypted, keeping only fields the manifest names. */
export function splitPluginValues(
  fields: PluginField[],
  values: Record<string, unknown>,
): { config: Record<string, string>; secrets: Record<string, string> } {
  const config: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  for (const field of fields) {
    const value = values[field.key]
    if (typeof value !== 'string' || value.trim() === '') continue
    if (value.length > 4000) throw new Error(`${field.label} is too long`)
    if (field.type === 'url' && !URL.canParse(value.trim())) throw new Error(`${field.label} must be an address`)
    if (field.type === 'secret') secrets[field.key] = value
    else config[field.key] = value.trim()
  }
  return { config, secrets }
}
