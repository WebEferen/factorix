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

/**
 * What a plugin may ask of Factorix beyond its own connections and settings. Its manifest names them, an organization's
 * admin sees them when turning it on, and only what that admin allowed is answered.
 */
export const PLUGIN_PERMISSIONS = {
  'activity:read': 'Read what happened on tickets: titles, statuses, assignees, merged merge requests, and what agents reported',
  'agents:run': "Ask this organization's agents for work in runs with no ticket and no repository, and read their answers",
  'members:read': 'Read who is in this organization: the names, handles, and roles of its people and agents',
  'tickets:write': "Read the names of this organization's projects, create tickets in them, hand those tickets to agents, and read their status",
  'workflows:blocks':
    "Add blocks to this organization's workflows, start the workflows built on its triggers, and receive what each of its blocks is given when it runs, ticket text included",
} as const
export type PluginPermission = keyof typeof PLUGIN_PERMISSIONS

export interface PluginManifest {
  protocol: number
  name: string
  version: string
  description?: string
  provides: 'tracker'[]
  permissions: PluginPermission[]
  /** What an admin fills in to connect one account of the service behind the plugin. */
  connection: { fields: PluginField[] }
  /** What an organization's admin sets once for the whole plugin, on its card under Settings. */
  settings: { fields: PluginField[] }
  /** Pages the plugin serves itself, shown inside Factorix in a frame. */
  pages: PluginPage[]
  /** Blocks it adds to workflows. They need `workflows:blocks`. */
  blocks: PluginBlock[]
  /** What can start a workflow from inside the plugin. They need `workflows:blocks` too. */
  triggers: PluginTrigger[]
}

export const PLUGIN_BLOCK_FIELD_KINDS = ['text', 'template', 'longTemplate', 'number', 'select'] as const

export interface PluginBlockField {
  key: string
  label: string
  /** `template` and `longTemplate` take `{{...}}` placeholders, which Factorix fills before the plugin sees them. */
  kind: (typeof PLUGIN_BLOCK_FIELD_KINDS)[number]
  required?: boolean
  placeholder?: string
  hint?: string
  /** What a `select` offers. With `dynamic`, Factorix asks the plugin for them, per organization, instead. */
  options?: { value: string; label: string }[]
  dynamic?: boolean
  initial?: string
}

/** A step a workflow can take, run by the plugin. It leaves through one of its outputs, or through `failed` when it throws. */
export interface PluginBlock {
  key: string
  title: string
  description: string
  fields: PluginBlockField[]
  outputs: { id: string; label: string }[]
  /** What it hands to later blocks, as `{{steps.<block id>.<key>}}`. */
  provides: { key: string; label: string }[]
}

/**
 * Something that happens in the plugin and starts the workflows built on it, with no ticket. Its fields narrow which
 * events start a workflow: each one filled in has to equal the event's value under the same key.
 */
export interface PluginTrigger {
  key: string
  title: string
  description: string
  fields: PluginBlockField[]
  /** What an event hands to the blocks after it, as `{{steps.<block id>.<key>}}`. */
  provides: { key: string; label: string }[]
}

/** What a plugin is told when one of its blocks runs. Every value came out of a workflow, so it is data. */
export interface PluginBlockCall {
  block: string
  plugin: { id: string }
  org: { id: string }
  run: { id: string; url: string; workflowId: string; workflowName: string }
  nodeId: string
  config: Record<string, string>
  issue: { identifier: string; title: string; url: string | null } | null
}

/** `wait` holds the step until the plugin reports it through `/workflow-steps`. */
export interface PluginBlockAnswer {
  handle?: string
  output?: Record<string, string>
  wait?: boolean
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
  /** The plugin's id in this installation, which its calls to Factorix name. */
  plugin: { id: string }
  org: { id: string; name: string }
  account: { id: string; name: string; role: string }
  settings: Record<string, string>
}

/** A plugin that ships in this repository's `plugins/` folder is named after its folder. */
export const BUNDLED_PLUGIN_NAME = /^[a-z][a-z0-9-]{0,30}$/

/** Bundled plugins share no secret: each one's comes from the installation's plugins key and its own name. */
export function bundledPluginSecret(key: string, name: string): string {
  return createHmac('sha256', key).update(`factorix-plugin:${name}`).digest('hex')
}

/** Where bundled plugins' pages live on Factorix's own address. A plugin name cannot start with `_`, so it never clashes. */
export const BUNDLED_PLUGIN_PAGES = '/_plugin'

/**
 * Where Factorix calls a bundled plugin, through the plugin host on the internal network, and where people open its
 * pages: under Factorix's own address, which the web passes to the plugin host. The host serves them with a sandbox
 * policy, so each page runs without an origin and reaches neither Factorix's session nor another plugin.
 */
export function bundledPluginUrls(name: string, internalUrl: string, factorixUrl: string): { url: string; pageUrl: string } {
  return {
    url: `${new URL(internalUrl).origin}/${name}/factorix`,
    pageUrl: `${new URL(factorixUrl).origin}${BUNDLED_PLUGIN_PAGES}/${name}/factorix`,
  }
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
  const blocks = (raw.blocks ?? []) as Record<string, unknown>[]
  if (!Array.isArray(blocks) || blocks.length > 20) throw new Error('The plugin manifest lists its blocks wrongly')
  const triggers = (raw.triggers ?? []) as Record<string, unknown>[]
  if (!Array.isArray(triggers) || triggers.length > 20) throw new Error('The plugin manifest lists its triggers wrongly')
  if (provides.length === 0 && pages.length === 0 && blocks.length === 0 && triggers.length === 0) {
    throw new Error('The plugin provides nothing this Factorix can use: no tracker, no pages, and no blocks')
  }
  const permissions = (raw.permissions ?? []) as unknown[]
  if (!Array.isArray(permissions)) throw new Error('The plugin manifest lists its permissions wrongly')
  const unknown = permissions.find((permission) => typeof permission !== 'string' || !Object.hasOwn(PLUGIN_PERMISSIONS, permission))
  if (unknown !== undefined) throw new Error(`The plugin asks for ${String(unknown)}, which this Factorix does not know`)
  if (blocks.length + triggers.length > 0 && !permissions.includes('workflows:blocks'))
    throw new Error('A plugin with workflow blocks has to ask for workflows:blocks')
  const parsedBlocks = parseBlocks(blocks)
  const parsedTriggers = parseTriggers(triggers)
  if (parsedTriggers.some((trigger) => parsedBlocks.some((block) => block.key === trigger.key)))
    throw new Error('A plugin trigger needs a key no block of the plugin has')
  return {
    protocol: PLUGIN_PROTOCOL,
    name: raw.name,
    version: raw.version,
    ...(text(raw.description, 300) ? { description: raw.description } : {}),
    provides: [...provides],
    permissions: [...new Set(permissions as PluginPermission[])],
    connection: { fields: parseFields((raw.connection as { fields?: unknown } | undefined)?.fields) },
    settings: { fields: parseFields((raw.settings as { fields?: unknown } | undefined)?.fields) },
    pages: pages.map((page) => {
      if (!text(page.key, 40) || !FIELD_KEY.test(page.key) || !text(page.label, 40)) throw new Error('A plugin page needs a key and a label')
      if (!text(page.path, 200) || !page.path.startsWith('/') || page.path.startsWith('//') || /[\\\s]/.test(page.path)) {
        throw new Error(`Plugin page ${page.key} needs a path that starts with one slash`)
      }
      return { key: page.key, label: page.label, path: page.path, placement: page.placement === 'settings' ? 'settings' : 'sidebar' }
    }),
    blocks: parsedBlocks,
    triggers: parsedTriggers,
  }
}

export const PLUGIN_BLOCK_KEY = /^[a-z][a-z0-9_]{0,39}$/
const OUTPUT_ID = /^[a-z][a-z0-9_]{0,39}$/

function parseBlocks(blocks: Record<string, unknown>[]): PluginBlock[] {
  const keys = new Set<string>()
  return blocks.map((block) => {
    if (!text(block.key, 40) || !PLUGIN_BLOCK_KEY.test(block.key) || keys.has(block.key)) throw new Error('Each plugin block needs a key of its own')
    keys.add(block.key)
    if (!text(block.title, 60) || !text(block.description, 300)) throw new Error(`Plugin block ${block.key} needs a title and a description`)
    const outputs = (block.outputs ?? [{ id: 'next', label: 'Next' }]) as Record<string, unknown>[]
    if (!Array.isArray(outputs) || outputs.length === 0 || outputs.length > 6) throw new Error(`Plugin block ${block.key} lists its outputs wrongly`)
    const provides = (block.provides ?? []) as Record<string, unknown>[]
    if (!Array.isArray(provides) || provides.length > 20) throw new Error(`Plugin block ${block.key} lists what it provides wrongly`)
    return {
      key: block.key,
      title: block.title,
      description: block.description,
      fields: parseBlockFields(block.key, block.fields),
      outputs: outputs.map((output) => {
        if (!text(output.id, 40) || !OUTPUT_ID.test(output.id) || output.id === 'failed' || !text(output.label, 40)) {
          throw new Error(`An output of plugin block ${block.key} needs an id other than failed, and a label`)
        }
        return { id: output.id, label: output.label }
      }),
      provides: provides.map((item) => {
        if (!text(item.key, 40) || !FIELD_KEY.test(item.key) || !text(item.label, 60))
          throw new Error(`Plugin block ${block.key} provides something unnamed`)
        return { key: item.key, label: item.label }
      }),
    }
  })
}

function parseTriggers(triggers: Record<string, unknown>[]): PluginTrigger[] {
  const keys = new Set<string>()
  return triggers.map((trigger) => {
    if (!text(trigger.key, 40) || !PLUGIN_BLOCK_KEY.test(trigger.key) || keys.has(trigger.key))
      throw new Error('Each plugin trigger needs a key of its own')
    keys.add(trigger.key)
    if (!text(trigger.title, 60) || !text(trigger.description, 300)) throw new Error(`Plugin trigger ${trigger.key} needs a title and a description`)
    const fields = parseBlockFields(trigger.key, trigger.fields)
    if (fields.some((field) => field.kind !== 'text' && field.kind !== 'select'))
      throw new Error(`The fields of plugin trigger ${trigger.key} can only be text or select, since they are compared with each event`)
    const provides = (trigger.provides ?? []) as Record<string, unknown>[]
    if (!Array.isArray(provides) || provides.length > 20) throw new Error(`Plugin trigger ${trigger.key} lists what it provides wrongly`)
    return {
      key: trigger.key,
      title: trigger.title,
      description: trigger.description,
      fields,
      provides: provides.map((item) => {
        if (!text(item.key, 40) || !FIELD_KEY.test(item.key) || !text(item.label, 60))
          throw new Error(`Plugin trigger ${trigger.key} provides something unnamed`)
        return { key: item.key, label: item.label }
      }),
    }
  })
}

/** An event a plugin reports. Only the keys its trigger declares are kept, as short texts. */
export function parsePluginTriggerEvent(trigger: PluginTrigger, value: unknown): Record<string, string> {
  const declared = new Set([...trigger.fields.map((field) => field.key), ...trigger.provides.map((item) => item.key)])
  const data = parseBlockOutput(value)
  return Object.fromEntries(Object.entries(data).filter(([key]) => declared.has(key)))
}

function parseBlockFields(block: string, value: unknown): PluginBlockField[] {
  const fields = (value ?? []) as Record<string, unknown>[]
  if (!Array.isArray(fields) || fields.length > 20) throw new Error(`Plugin block ${block} lists its fields wrongly`)
  return fields.map((field) => {
    if (!text(field.key, 40) || !FIELD_KEY.test(field.key) || !text(field.label, 80))
      throw new Error(`A field of plugin block ${block} needs a key and a label`)
    const kind = PLUGIN_BLOCK_FIELD_KINDS.find((item) => item === field.kind)
    if (!kind) throw new Error(`Field ${field.key} of plugin block ${block} has an unknown kind`)
    const options = (field.options ?? []) as Record<string, unknown>[]
    if (!Array.isArray(options) || options.length > 100) throw new Error(`Field ${field.key} of plugin block ${block} lists its options wrongly`)
    return {
      key: field.key,
      label: field.label,
      kind,
      ...(field.required === true ? { required: true } : {}),
      ...(text(field.placeholder, 200) ? { placeholder: field.placeholder } : {}),
      ...(text(field.hint, 300) ? { hint: field.hint } : {}),
      ...(kind === 'select'
        ? {
            options: options.map((option) => {
              if (!text(option.value, 200) || !text(option.label, 200)) throw new Error(`An option of field ${field.key} needs a value and a label`)
              return { value: option.value, label: option.label }
            }),
            ...(field.dynamic === true ? { dynamic: true } : {}),
          }
        : {}),
      ...(text(field.initial, 4000) ? { initial: field.initial } : {}),
    }
  })
}

/** What a block answered. The plugin is someone else's server, so the handle has to be one of the block's outputs and the output plain text. */
export function parsePluginBlockAnswer(block: PluginBlock, value: unknown): PluginBlockAnswer {
  const raw = (value ?? {}) as Record<string, unknown>
  if (raw.wait === true) return { wait: true, output: parseBlockOutput(raw.output) }
  const handle = raw.handle === undefined ? block.outputs[0]?.id : raw.handle
  if (typeof handle !== 'string' || !block.outputs.some((output) => output.id === handle)) {
    throw new Error(`The plugin left block ${block.key} through ${String(handle)}, which it does not have`)
  }
  return { handle, output: parseBlockOutput(raw.output) }
}

export function parseBlockOutput(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('A block output has to be an object of texts')
  const output: Record<string, string> = {}
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (!FIELD_KEY.test(key)) continue
    output[key] = String(item ?? '').slice(0, 4000)
  }
  return output
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

/** One ticket in a plugin's read of activity. Titles and names come from trackers and people, so they are data. */
export interface PluginActivityIssue {
  id: string
  identifier: string
  title: string
  url: string | null
  project: string
  /** 0 for none, then 1 (most urgent) to 4. */
  priority: number
  status: string | null
  statusType: string | null
  /** Where the factory is with it, `untracked` while no agent has it. */
  factoryState: string
  /** The person it is assigned to in the tracker. */
  assignee: { id: string | null; name: string } | null
  /** The agent it is assigned to here. */
  agent: { id: string; handle: string; name: string } | null
  updatedAt: string
}

/** What happened in an organization since a moment, for `activity:read`. */
export interface PluginActivity {
  /** Tickets with an assignee or an agent that changed since then or are still open, most recently changed first. */
  issues: PluginActivityIssue[]
  /** Merge requests of those tickets merged since then. */
  merges: { issueId: string; url: string; mergedAt: string }[]
  /** What agents reported when their runs on those tickets succeeded since then. */
  reports: { issueId: string; agent: string; phase: string; summary: string; finishedAt: string }[]
  /** True when more tickets matched than one answer holds. */
  truncated: boolean
}

export interface PluginAgent {
  id: string
  handle: string
  name: string
  status: string
  runtime: string
  model: string | null
}

/** A run a plugin started, for `agents:run`. `output` is the agent's answer in the shape the plugin asked for. */
export interface PluginRun {
  id: string
  state: string
  /** True once the run succeeded, failed, or was cancelled. */
  finished: boolean
  agentId: string
  output: unknown
  error: string | null
  /** The run's page in Factorix. */
  url: string
  createdAt: string
  finishedAt: string | null
}

/** A person or an agent of an organization, for `members:read`. */
export interface PluginMember {
  id: string
  kind: 'person' | 'agent'
  name: string
  handle: string
  role: string
  status: string
}

/** A project a plugin can create a ticket in, for `tickets:write`. */
export interface PluginTicketProject {
  id: string
  name: string
}

/** A ticket a plugin created, for `tickets:write`. */
export interface PluginTicket {
  id: string
  identifier: string
  title: string
  url: string | null
  status: string | null
  statusType: string | null
  /** True once its status is completed or canceled. */
  closed: boolean
}
