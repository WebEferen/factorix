import { createHandler, FactorixError, type Plugin } from './plugin.js'
import { SIGNATURE_HEADER, sign, signPageToken, TIMESTAMP_HEADER, verify } from './signing.js'
import { type BlockAnswer, type BlockCall, type Connection, type Manifest, type PageContext, PROTOCOL, type Tracker } from './types.js'

const DEFAULT_SECRET = 'test-secret-0123456789'

/** Calls a plugin the way Factorix does, without a network, for your tests. */
export function factorixClient(plugin: Plugin, options: { secret?: string; path?: string } = {}) {
  const secret = options.secret ?? DEFAULT_SECRET
  const path = options.path ?? '/factorix'
  const handler = createHandler(plugin, { secret, path })
  const call = async (method: string, params: unknown[], connection: Connection | null): Promise<unknown> => {
    const body = JSON.stringify({ protocol: PROTOCOL, method, params, connection })
    const timestamp = String(Date.now())
    const response = await handler(
      new Request(`http://plugin.test${path}`, {
        method: 'POST',
        headers: { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: sign(secret, timestamp, body) },
        body,
      }),
    )
    const answer = (await response.json()) as { result?: unknown; error?: { message: string } }
    if (!response.ok || answer.error) throw new Error(answer.error?.message ?? `The plugin answered ${response.status}`)
    return answer.result
  }
  return {
    handler,
    manifest: () => call('manifest', [], null) as Promise<Manifest>,
    tracker(connection: Partial<Connection> = {}): Required<Tracker> {
      const full = { id: 'connection-1', config: {}, secrets: {}, ...connection }
      return new Proxy(
        {},
        {
          get:
            (_target, method) =>
            (...params: unknown[]) =>
              call(`tracker.${String(method)}`, params, full),
        },
      ) as Required<Tracker>
    },
    /** Runs a block as a workflow reaching it does. `config` holds its fields with templates already filled. */
    runBlock(key: string, input: Partial<Omit<BlockCall, 'block'>> = {}): Promise<BlockAnswer> {
      return call(
        'workflow.block',
        [
          {
            plugin: { id: 'plugin-1' },
            org: { id: 'org-1' },
            run: { id: 'run-1', url: 'https://factorix.test/workflows/workflow-1/runs/run-1', workflowId: 'workflow-1', workflowName: 'Test' },
            nodeId: `${key}-1`,
            config: {},
            issue: null,
            ...input,
            block: key,
          },
        ],
        null,
      ) as Promise<BlockAnswer>
    },
    /** The choices a block lists for one of its `dynamic` fields. */
    blockOptions(key: string, field: string, org = { id: 'org-1' }): Promise<{ value: string; label: string }[]> {
      return call('workflow.options', [{ block: key, field, org }], null) as Promise<{ value: string; label: string }[]>
    },
    /**
     * Opens a page as a signed-in person would, and returns what the plugin served. With `form`, posts it to the page
     * the way a form on the page does, which reaches its `action`.
     */
    async openPage(
      key: string,
      context: Partial<PageContext> = {},
      options: { query?: Record<string, string>; form?: Record<string, string> } = {},
    ): Promise<Response> {
      const page = plugin.manifest.pages.find((candidate) => candidate.key === key)
      if (!page) throw new Error(`The plugin has no page ${key}`)
      const token = signPageToken(secret, {
        exp: Date.now() + 60_000,
        page: key,
        plugin: { id: 'plugin-1' },
        org: { id: 'org-1', name: 'Acme' },
        account: { id: 'account-1', name: 'Sam', role: 'admin' },
        settings: {},
        ...context,
      })
      const query = new URLSearchParams({ factorix: token, ...options.query })
      const address = `http://plugin.test${path}${page.path}?${query}`
      if (!options.form) return handler(new Request(address))
      return handler(
        new Request(address, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(options.form),
        }),
      )
    },
  }
}

type FakeCall =
  | 'settings'
  | 'activity'
  | 'agents'
  | 'runs'
  | 'run'
  | 'members'
  | 'projects'
  | 'tickets'
  | 'ticket'
  | 'workflow-steps'
  | 'workflow-triggers'

/**
 * Stands in for Factorix behind `factorix({ fetch })`, for your tests. Each handler gets the body the plugin sent
 * (`runId` added for `run`, which is `getRun`, and `ticketId` for `ticket`, which is `getTicket`) and returns what
 * Factorix would answer: settings, the activity, the agents, the run, the members, the projects, or the ticket.
 * `workflow-steps` is `finishStep`, whose answer is not read, and `workflow-triggers` is `fireTrigger`, which answers how many
 * workflows started. Throw a `FactorixError` to answer with its status. Signatures are checked like Factorix does.
 */
export function fakeFactorix(
  handlers: Partial<Record<FakeCall, (body: Record<string, unknown>) => unknown>>,
  options: { secret?: string } = {},
): { fetch: typeof fetch; calls: { call: FakeCall; pluginId: string; body: Record<string, unknown> }[] } {
  const secret = options.secret ?? DEFAULT_SECRET
  const calls: { call: FakeCall; pluginId: string; body: Record<string, unknown> }[] = []
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const wrap: Record<FakeCall, (value: unknown) => unknown> = {
    settings: (value) => value,
    activity: (activity) => ({ activity }),
    agents: (agents) => ({ agents }),
    runs: (run) => ({ run }),
    run: (run) => ({ run }),
    members: (members) => ({ members }),
    projects: (projects) => ({ projects }),
    tickets: (ticket) => ({ ticket }),
    ticket: (ticket) => ({ ticket }),
    'workflow-steps': () => ({ ok: true }),
    'workflow-triggers': (started) => ({ started: Number(started ?? 0) }),
  }
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = String(init?.body ?? '')
    const headers = new Headers(init?.headers)
    if (!verify(secret, headers.get(TIMESTAMP_HEADER), headers.get(SIGNATURE_HEADER), body))
      return answer(401, { error: { message: 'Plugin signature check failed' } })
    const match =
      /^\/webhooks\/plugins\/([^/]+)\/(settings|activity|agents|runs|members|projects|tickets|workflow-steps|workflow-triggers)(?:\/([^/]+))?$/.exec(
        new URL(String(input)).pathname,
      )
    if (!match?.[1] || !match[2]) return answer(404, { error: { message: 'Not found' } })
    const one = match[2] === 'runs' ? 'run' : match[2] === 'tickets' ? 'ticket' : null
    if (match[3] && !one) return answer(404, { error: { message: 'Not found' } })
    const call: FakeCall = match[3] && one ? one : (match[2] as FakeCall)
    const handle = handlers[call]
    if (!handle) return answer(404, { error: { message: `The fake has no ${call}` } })
    const sent = { ...(JSON.parse(body) as Record<string, unknown>), ...(match[3] ? { [`${call}Id`]: decodeURIComponent(match[3]) } : {}) }
    calls.push({ call, pluginId: match[1], body: sent })
    try {
      return answer(200, wrap[call](await handle(sent)))
    } catch (error) {
      if (error instanceof FactorixError) return answer(error.status, { error: { message: error.message } })
      throw error
    }
  }
  return { fetch: fake as typeof fetch, calls }
}

/**
 * Walks a tracker through what Factorix does with one: reads the teams and statuses, creates an issue, moves it, labels
 * it, comments, and finds it again in a sync. Throws with a plain message at the first thing that is off. It writes to
 * the tracker, so point it at a test account.
 */
export async function checkTracker(tracker: Tracker): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`Tracker check: ${message}`)
  }
  const viewer = await tracker.viewer()
  if (!viewer.id || !viewer.name) fail('viewer() must return an id and a name')
  const team = (await tracker.listTeams())[0] ?? fail('listTeams() returned nothing to follow')
  if (!/^[A-Z][A-Z0-9]*$/.test(team.key)) fail(`team key ${team.key} must be capital letters and digits, since issues are named ${team.key}-12`)
  const states = await tracker.listWorkflowStates(team.id)
  const open = states.find((state) => state.type === 'unstarted' || state.type === 'backlog') ?? fail('no status of type unstarted or backlog')
  const started =
    states.find((state) => state.type === 'started') ?? fail('no status of type started, which is where an agent moves an issue it picks up')
  if (!states.some((state) => state.type === 'completed')) fail('no status of type completed')

  const before = new Date(Date.now() - 1000).toISOString()
  const issue = await tracker.createIssue({
    teamId: team.id,
    title: 'Factorix tracker check',
    description: 'Made by **checkTracker**.',
    stateId: open.id,
  })
  if (!issue.identifier.startsWith(`${team.key}-`)) fail(`identifier ${issue.identifier} must start with ${team.key}-`)
  if (issue.stateId !== open.id || issue.teamId !== team.id) fail('createIssue() must put the issue in the team and status it was given')
  if (Number.isNaN(Date.parse(issue.updatedAt))) fail('updatedAt must be an ISO date')

  await tracker.updateIssueState(issue.id, started.id)
  const moved = (await tracker.getIssue(issue.id)) ?? fail('getIssue() lost the issue it just created')
  if (moved.stateId !== started.id || moved.stateType !== 'started') fail('updateIssueState() did not move the issue')

  const group = await tracker.createLabel({ teamId: team.id, name: 'Agent', isGroup: true })
  const label = await tracker.createLabel({ teamId: team.id, name: 'check-agent', parentId: group.id })
  if (label.parentId !== group.id) fail('a label created under the Agent group must come back with that group as its parent')
  await tracker.updateIssueLabels(issue.id, { add: [label.id] })
  if (!(await tracker.getIssue(issue.id))?.labels.some((item) => item.id === label.id)) fail('updateIssueLabels() did not add the label')
  await tracker.updateIssueLabels(issue.id, { remove: [label.id] })
  if ((await tracker.getIssue(issue.id))?.labels.some((item) => item.id === label.id)) fail('updateIssueLabels() did not remove the label')

  const comment = await tracker.comment(issue.id, '**[Factorix · check]** hello')
  const comments = await tracker.listComments(issue.id)
  const posted = comments.find((item) => item.id === comment.id) ?? fail('listComments() does not include the comment just posted')
  if (!posted.body.startsWith('**[Factorix · check]**'))
    fail('a comment must come back as the Markdown it was written in, since Factorix knows its own comments by how they start')

  const page = await tracker.listIssues({ teamId: team.id, updatedAfter: before, limit: 50 })
  if (!page.nodes.some((item) => item.id === issue.id)) fail('listIssues({ updatedAfter }) must include an issue changed after that moment')
  if ((await tracker.getIssue('no-such-issue-id')) !== null) fail('getIssue() must return null for an issue that does not exist')
}
