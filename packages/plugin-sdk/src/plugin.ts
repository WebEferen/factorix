import { DELIVERY_HEADER, readPageToken, SIGNATURE_HEADER, sign, TIMESTAMP_HEADER, verify } from './signing.js'
import {
  type Activity,
  type Agent,
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
  type Tracker,
  type TrackerEvent,
} from './types.js'

export interface PageDefinition {
  key: string
  /** What the entry in Factorix's menu says. */
  label: string
  /** Where the page lives under your plugin's address. Defaults to `/pages/<key>`. */
  path?: string
  /** `sidebar` puts it in the main menu, `settings` on the plugin's row under Settings. */
  placement?: 'sidebar' | 'settings'
  /** Returns the HTML of the page, or a whole response. `token` is the signed context, to send back with the page's own requests. */
  render(context: PageContext, request: Request, token: string): string | Response | Promise<string | Response>
  /**
   * Handles a POST to the page's own address, such as a form on it. The token is read the same way as for `render`, so
   * put it in the form's address (`action="?factorix=<token>"`). Answer with a redirect back to the page, or with HTML.
   */
  action?(context: PageContext, request: Request, token: string): string | Response | Promise<string | Response>
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
  if (!definition.tracker && pages.length === 0) throw new Error('A plugin needs a tracker or at least one page')
  return {
    ...definition,
    manifest: {
      protocol: PROTOCOL,
      name: definition.name,
      version: definition.version,
      ...(definition.description ? { description: definition.description } : {}),
      provides: definition.tracker ? ['tracker'] : [],
      permissions: [...new Set(definition.permissions ?? [])],
      connection: { fields: definition.connection?.fields ?? [] },
      settings: { fields: definition.settings?.fields ?? [] },
      pages,
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

  return async (request) => {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === (base || '/')) return rpc(request)
    const page = plugin.pages?.find((candidate) => base + (candidate.path ?? `/pages/${candidate.key}`) === url.pathname)
    const handle = request.method === 'GET' ? page?.render : request.method === 'POST' ? page?.action : undefined
    if (!page || !handle) return json(404, { error: { message: 'Not found' } })
    const token = url.searchParams.get('factorix') ?? request.headers.get('x-factorix-page') ?? ''
    const context = readPageToken(options.secret, token)
    if (!context || context.page !== page.key) {
      const where = (page.placement ?? 'sidebar') === 'settings' ? 'under Settings, Plugins' : 'in the sidebar'
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
  }
}

export type FactorixClient = ReturnType<typeof factorix>
