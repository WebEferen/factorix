import { DELIVERY_HEADER, readPageToken, SIGNATURE_HEADER, sign, TIMESTAMP_HEADER, verify } from './signing.js'
import {
  type Activity,
  type Agent,
  type BlockAnswer,
  type BlockCall,
  type BlockField,
  type Connection,
  type Field,
  type Manifest,
  type Member,
  type PageContext,
  type Permission,
  PROTOCOL,
  type Run,
  type RunRequest,
  type Ticket,
  type TicketProject,
  type TicketRequest,
  type ToolCall,
  type Tracker,
  type TrackerEvent,
} from './types.js'

export interface PageDefinition {
  key: string
  /** What the entry in Factorix's menu says. */
  label: string
  /** Where the page lives under your plugin's address. Defaults to `/pages/<key>`. */
  path?: string
  /** `sidebar` puts it in the main menu, `settings` on the plugin's row under Integrations, Plugins. */
  placement?: 'sidebar' | 'settings'
  /** Returns the HTML of the page, or a whole response. `token` is the signed context, to send back with the page's own requests. */
  render(context: PageContext, request: Request, token: string): string | Response | Promise<string | Response>
  /**
   * Handles a POST to the page's own address, such as a form on it. The token is read the same way as for `render`, so
   * put it in the form's address (`action="?factorix=<token>"`). Answer with a redirect back to the page, or with HTML.
   */
  action?(context: PageContext, request: Request, token: string): string | Response | Promise<string | Response>
}

export interface BlockDefinition {
  /** Lowercase letters, digits, and underscores, starting with a letter. Keep it once workflows use the block. */
  key: string
  title: string
  description: string
  fields?: BlockField[]
  /** The ways out of the block. Defaults to one, `next`. A block that throws leaves through `failed`, which every block has. */
  outputs?: { id: string; label: string }[]
  /** What it hands to later blocks, as `{{steps.<block id>.<key>}}`, so the editor can offer them. */
  provides?: { key: string; label: string }[]
  /** Does the block's work. Answer quickly: anything slow answers `{ wait: true }` and calls `finishStep` when done. */
  run(call: BlockCall): BlockAnswer | Promise<BlockAnswer>
  /** The choices of a `dynamic` field, for one organization. */
  options?(input: { field: string; org: { id: string } }): { value: string; label: string }[] | Promise<{ value: string; label: string }[]>
}

/**
 * Something that happens in your plugin and can start a workflow, with no ticket. Report each one with
 * `factorix().fireTrigger`. Its fields narrow which events start a workflow: each one an admin fills in has to equal the
 * event's value under the same key, so they can only be `text` or `select`.
 */
export interface TriggerDefinition {
  /** Lowercase letters, digits, and underscores, starting with a letter, and no block's key. Keep it once workflows use it. */
  key: string
  title: string
  description: string
  fields?: BlockField[]
  /** What an event hands to the blocks after it, as `{{steps.<block id>.<key>}}`, so the editor can offer them. */
  provides?: { key: string; label: string }[]
  /** The choices of a `dynamic` field, for one organization. */
  options?(input: { field: string; org: { id: string } }): { value: string; label: string }[] | Promise<{ value: string; label: string }[]>
}

/**
 * A tool the organization's agents can call while they work. Factorix's worker calls it for them, so it reaches your
 * plugin even from a container with no network. Answer within 30 seconds, with text or anything JSON can hold, which the
 * agent reads as text. Throw to tell the agent what went wrong.
 */
export interface ToolDefinition {
  /** Lowercase letters, digits, and underscores, starting with a letter. Agents call it as `<plugin name>_<key>`. */
  key: string
  /** What the agent's model reads to decide when to call it and what to send. */
  description: string
  /** A JSON Schema of an object. Defaults to one with no fields. */
  inputSchema?: Record<string, unknown>
  run(call: ToolCall): unknown | Promise<unknown>
}

export interface PluginDefinition {
  name: string
  version: string
  description?: string
  /** What an admin fills in to connect one account. Reaches `tracker` as `connection.config` and `connection.secrets`. */
  connection?: { fields: Field[] }
  /** What an organization sets once for the whole plugin. Reaches pages as `context.settings`. */
  settings?: { fields: Field[] }
  /** What the plugin asks of Factorix through `factorix()`. An organization's admin allows them when turning the plugin on. */
  permissions?: Permission[]
  pages?: PageDefinition[]
  /** Steps it adds to the workflows of each organization that turns it on. */
  blocks?: BlockDefinition[]
  /** What can start those workflows from inside the plugin. */
  triggers?: TriggerDefinition[]
  /** Tools it gives the agents of each organization that turns it on. */
  tools?: ToolDefinition[]
  /** Builds a tracker for one connection. Called per request, so keep it cheap and keep nothing in it. */
  tracker?(connection: Connection): Tracker
}

export interface Plugin extends PluginDefinition {
  manifest: Manifest
}

export function definePlugin(definition: PluginDefinition): Plugin {
  const pages = (definition.pages ?? []).map((page) => ({
    key: page.key,
    label: page.label,
    path: page.path ?? `/pages/${page.key}`,
    placement: page.placement ?? ('sidebar' as const),
  }))
  for (const page of pages)
    if (!page.path.startsWith('/') || page.path.startsWith('//')) throw new Error(`Page ${page.key} needs a path that starts with one slash`)
  const blocks = (definition.blocks ?? []).map((block) => ({
    key: block.key,
    title: block.title,
    description: block.description,
    fields: block.fields ?? [],
    outputs: block.outputs ?? [{ id: 'next', label: 'Next' }],
    provides: block.provides ?? [],
  }))
  for (const block of blocks) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(block.key)) throw new Error(`Block ${block.key} needs a key of lowercase letters, digits, and underscores`)
    if (blocks.filter((other) => other.key === block.key).length > 1) throw new Error(`Two blocks share the key ${block.key}`)
    if (block.outputs.some((output) => output.id === 'failed'))
      throw new Error(`Block ${block.key} cannot name an output failed, which every block has`)
  }
  const triggers = (definition.triggers ?? []).map((trigger) => ({
    key: trigger.key,
    title: trigger.title,
    description: trigger.description,
    fields: trigger.fields ?? [],
    provides: trigger.provides ?? [],
  }))
  for (const trigger of triggers) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(trigger.key))
      throw new Error(`Trigger ${trigger.key} needs a key of lowercase letters, digits, and underscores`)
    if ([...blocks, ...triggers].filter((other) => other.key === trigger.key).length > 1)
      throw new Error(`Two blocks or triggers share the key ${trigger.key}`)
    if (trigger.fields.some((field) => field.kind !== 'text' && field.kind !== 'select'))
      throw new Error(`The fields of trigger ${trigger.key} can only be text or select`)
  }
  const tools = (definition.tools ?? []).map((tool) => ({
    key: tool.key,
    description: tool.description,
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
  }))
  for (const tool of tools) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(tool.key)) throw new Error(`Tool ${tool.key} needs a key of lowercase letters, digits, and underscores`)
    if (tools.filter((other) => other.key === tool.key).length > 1) throw new Error(`Two tools share the key ${tool.key}`)
    if (tool.inputSchema.type !== 'object') throw new Error(`The inputSchema of tool ${tool.key} has to describe an object`)
  }
  if (!definition.tracker && pages.length === 0 && blocks.length === 0 && triggers.length === 0 && tools.length === 0)
    throw new Error('A plugin needs a tracker, a page, a block, or a tool')
  const workflows = blocks.length + triggers.length > 0
  const permissions: Permission[] = [
    ...(definition.permissions ?? []),
    ...(workflows ? (['workflows:blocks'] as const) : []),
    ...(tools.length > 0 ? (['agents:tools'] as const) : []),
  ]
  return {
    ...definition,
    manifest: {
      protocol: PROTOCOL,
      name: definition.name,
      version: definition.version,
      ...(definition.description ? { description: definition.description } : {}),
      provides: definition.tracker ? ['tracker'] : [],
      permissions: [...new Set(permissions)],
      connection: { fields: definition.connection?.fields ?? [] },
      settings: { fields: definition.settings?.fields ?? [] },
      pages,
      blocks,
      triggers,
      tools,
    },
  }
}

const TRACKER_METHODS = new Set([
  'viewer',
  'listTeams',
  'listProjects',
  'listWorkflowStates',
  'listLabels',
  'listIssues',
  'getIssue',
  'listComments',
  'listResources',
  'createIssue',
  'updateIssueState',
  'updateIssueLabels',
  'createLabel',
  'comment',
  'updateComment',
  'registerWebhook',
])
/** What Factorix gets when a tracker leaves an optional method out. */
const DEFAULTS: Record<string, unknown> = { listProjects: [], listResources: [], updateComment: null, registerWebhook: { id: 'none' } }
const MAX_BODY_BYTES = 2 * 1024 * 1024

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export interface HandlerOptions {
  /** The secret shared with Factorix: the one an installation admin types when installing the plugin. */
  secret: string
  /** The path part of the address given to Factorix. Defaults to `/factorix`. */
  path?: string
}

/**
 * Serves a plugin from any runtime that speaks `Request` and `Response`. Calls from Factorix arrive as POST on `path`,
 * signed, and pages as GET under it with a signed `factorix` parameter. Anything else gets a 404 or a 401.
 */
export function createHandler(plugin: Plugin, options: HandlerOptions): (request: Request) => Promise<Response> {
  const base = (options.path ?? '/factorix').replace(/\/$/, '')
  if (options.secret.length < 16) throw new Error('The plugin secret must be at least 16 characters')

  const rpc = async (request: Request): Promise<Response> => {
    const raw = new Uint8Array(await request.arrayBuffer())
    if (raw.byteLength > MAX_BODY_BYTES) return json(413, { error: { message: 'Request too large' } })
    if (!verify(options.secret, request.headers.get(TIMESTAMP_HEADER), request.headers.get(SIGNATURE_HEADER), raw)) {
      return json(401, { error: { message: 'Signature check failed. The secret here must match the one typed into Factorix' } })
    }
    let call: { protocol?: number; method?: string; params?: unknown[]; connection?: Connection | null }
    try {
      call = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      return json(400, { error: { message: 'The body is not JSON' } })
    }
    if (call.protocol !== PROTOCOL) return json(400, { error: { message: `This plugin speaks protocol ${PROTOCOL}` } })
    if (call.method === 'manifest') return json(200, { result: plugin.manifest })
    if (call.method === 'workflow.block' || call.method === 'workflow.options') return workflow(call.method, call.params?.[0])
    if (call.method === 'agent.tool') return agentTool(call.params?.[0] as ToolCall | undefined)
    const [scope, method] = String(call.method).split('.')
    if (scope !== 'tracker' || !method || !TRACKER_METHODS.has(method) || !plugin.tracker || !call.connection) {
      return json(404, { error: { message: `Unknown method ${String(call.method)}` } })
    }
    try {
      const tracker = plugin.tracker(call.connection) as unknown as Record<string, ((...params: unknown[]) => Promise<unknown>) | undefined>
      const implemented = tracker[method]
      if (!implemented)
        return method in DEFAULTS ? json(200, { result: DEFAULTS[method] }) : json(404, { error: { message: `The tracker has no ${method}` } })
      const result = await implemented.apply(tracker, Array.isArray(call.params) ? call.params : [])
      return json(200, { result: result ?? null })
    } catch (error) {
      return json(500, { error: { message: error instanceof Error ? error.message : 'The plugin failed' } })
    }
  }

  const workflow = async (method: string, input: unknown): Promise<Response> => {
    const name = (input as { block?: unknown } | undefined)?.block
    const block = plugin.blocks?.find((candidate) => candidate.key === name)
    // A trigger's dynamic fields are asked for under the same method, by its key.
    const trigger = method === 'workflow.options' ? plugin.triggers?.find((candidate) => candidate.key === name) : undefined
    if (trigger) {
      if (!trigger.options) return json(404, { error: { message: `Trigger ${trigger.key} lists no choices` } })
      const { field, org } = input as { field: string; org: { id: string } }
      return json(200, { result: await trigger.options({ field, org }) })
    }
    if (!block) return json(404, { error: { message: `This plugin has no block ${String(name)}` } })
    try {
      if (method === 'workflow.block') return json(200, { result: await block.run(input as BlockCall) })
      if (!block.options) return json(404, { error: { message: `Block ${block.key} lists no choices` } })
      const { field, org } = input as { field: string; org: { id: string } }
      return json(200, { result: await block.options({ field, org }) })
    } catch (error) {
      return json(500, { error: { message: error instanceof Error ? error.message : 'The block failed' } })
    }
  }

  const agentTool = async (call: ToolCall | undefined): Promise<Response> => {
    const tool = plugin.tools?.find((candidate) => candidate.key === call?.tool)
    if (!call || !tool) return json(404, { error: { message: `This plugin has no tool ${String(call?.tool)}` } })
    try {
      return json(200, { result: (await tool.run(call)) ?? null })
    } catch (error) {
      return json(500, { error: { message: error instanceof Error ? error.message : 'The tool failed' } })
    }
  }

  return async (request) => {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === (base || '/')) return rpc(request)
    const page = plugin.pages?.find((candidate) => base + (candidate.path ?? `/pages/${candidate.key}`) === url.pathname)
    const handle = request.method === 'GET' ? page?.render : request.method === 'POST' ? page?.action : undefined
    if (!page || !handle) return json(404, { error: { message: 'Not found' } })
    const token = url.searchParams.get('factorix') ?? request.headers.get('x-factorix-page') ?? ''
    const context = readPageToken(options.secret, token)
    if (!context || context.page !== page.key) {
      const where = (page.placement ?? 'sidebar') === 'settings' ? 'under Integrations, Plugins' : 'in the sidebar'
      return new Response(`This page opens from inside Factorix, and each opening lasts a few minutes. Open ${page.label} again ${where}.`, {
        status: 401,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }
    const rendered = await handle.call(page, context, request, token)
    if (rendered instanceof Response) return rendered
    return new Response(rendered, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    })
  }
}

export interface FactorixOptions {
  /** The address of the Factorix installation. A plugin in Factorix's own `plugins/` folder gets it as `FACTORIX_URL`. */
  url: string
  secret: string
  /** The plugin's id in that installation, needed for every call but `sendEvent`. Pages get it as `context.plugin.id`. */
  pluginId?: string
  /** Stands in for the global `fetch`, for tests. */
  fetch?: typeof fetch
}

/** A call Factorix refused. `status` is 403 for a permission the organization did not allow, and 404 when it has not turned the plugin on. */
export class FactorixError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'FactorixError'
  }
}

/** The calls a plugin makes to Factorix, signed with the shared secret. Every call but `sendEvent` acts for one organization. */
export function factorix(options: FactorixOptions) {
  const send = options.fetch ?? fetch
  const post = async (target: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> => {
    const text = JSON.stringify(body)
    const timestamp = String(Date.now())
    const response = await send(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(options.secret, timestamp, text),
        ...headers,
      },
      body: text,
    })
    const raw = await response.text()
    let answer: { error?: { message?: unknown } | string; message?: unknown } | null = null
    try {
      answer = JSON.parse(raw)
    } catch {}
    if (!response.ok) {
      const message = typeof answer?.error === 'object' ? answer.error.message : (answer?.message ?? raw)
      throw new FactorixError(response.status, `Factorix answered ${response.status}: ${String(message).slice(0, 300)}`)
    }
    return answer
  }
  const origin = options.url.replace(/\/$/, '')
  const call = (path: string, orgId: string, body: Record<string, unknown> = {}) => {
    if (!options.pluginId) throw new Error(`Calling Factorix for ${path} needs the pluginId, which pages get as context.plugin.id`)
    return post(`${origin}/webhooks/plugins/${options.pluginId}/${path}`, { ...body, orgId }) as Promise<Record<string, unknown>>
  }
  return {
    /**
     * Tells Factorix something changed. `callbackUrl` is the address `registerWebhook` was given, or the connection's
     * id. Give a `deliveryId` when the source has one, and a repeated delivery is dropped.
     */
    async sendEvent(callbackUrl: string, event: TrackerEvent, deliveryId?: string): Promise<void> {
      const target = callbackUrl.startsWith('http') ? callbackUrl : `${origin}/webhooks/plugin/${callbackUrl}`
      await post(target, { event }, deliveryId ? { [DELIVERY_HEADER]: deliveryId } : {})
    },
    /** What an organization set for this plugin, secret fields included. */
    async settings(orgId: string): Promise<{ settings: Record<string, string>; secrets: Record<string, string> }> {
      return (await call('settings', orgId)) as never
    },
    /** What happened on the organization's tickets since `since`, at most 31 days back. Needs `activity:read`. */
    async activity(orgId: string, since: Date | string): Promise<Activity> {
      return (await call('activity', orgId, { since: new Date(since).toISOString() })).activity as Activity
    },
    /** The organization's agents. Needs `agents:run`. */
    async agents(orgId: string): Promise<Agent[]> {
      return (await call('agents', orgId)).agents as Agent[]
    },
    /**
     * Asks one of the organization's agents for work, in a run with no ticket and no repository. The run is queued and
     * the answer comes later: read it with `getRun`. At most three of a plugin's runs are unfinished at once. Needs `agents:run`.
     */
    async startRun(orgId: string, request: RunRequest): Promise<Run> {
      return (await call('runs', orgId, { ...request })).run as Run
    },
    /** A run this plugin started, with the agent's answer once it succeeded. Needs `agents:run`. */
    async getRun(orgId: string, runId: string): Promise<Run> {
      return (await call(`runs/${encodeURIComponent(runId)}`, orgId)).run as Run
    },
    /** The people and agents of the organization. Needs `members:read`. */
    async members(orgId: string): Promise<Member[]> {
      return (await call('members', orgId)).members as Member[]
    },
    /** The projects a ticket can be created in. Needs `tickets:write`. */
    async projects(orgId: string): Promise<TicketProject[]> {
      return (await call('projects', orgId)).projects as TicketProject[]
    },
    /** Creates a ticket in one of the organization's projects, in whatever tracker that project follows. Needs `tickets:write`. */
    async createTicket(orgId: string, request: TicketRequest): Promise<Ticket> {
      return (await call('tickets', orgId, { ...request })).ticket as Ticket
    },
    /** A ticket this plugin created, as it stands now. Needs `tickets:write`. */
    async getTicket(orgId: string, ticketId: string): Promise<Ticket> {
      return (await call(`tickets/${encodeURIComponent(ticketId)}`, orgId)).ticket as Ticket
    },
    /**
     * Ends a step one of your blocks held with `{ wait: true }`. `handle` and `output` work as in the block's answer, and
     * `error` fails the step instead. Throws `FactorixError` 409 once the step has ended. Needs `workflows:blocks`.
     */
    async finishStep(
      orgId: string,
      step: { runId: string; nodeId: string; handle?: string; output?: Record<string, string>; error?: string },
    ): Promise<void> {
      await call('workflow-steps', orgId, { ...step })
    },
    /**
     * Reports that one of your triggers happened, and starts the organization's workflows built on it. `data` holds the
     * values its fields are compared with and what it provides, as texts; other keys are dropped. Sending the same
     * `eventId` again starts nothing new, so a retry is safe. Answers how many workflows started. Needs `workflows:blocks`.
     */
    async fireTrigger(orgId: string, event: { trigger: string; data?: Record<string, string>; eventId?: string }): Promise<number> {
      return Number((await call('workflow-triggers', orgId, { ...event })).started ?? 0)
    },
  }
}

export type FactorixClient = ReturnType<typeof factorix>
