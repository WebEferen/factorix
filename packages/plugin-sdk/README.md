# Factorix plugin SDK

Build plugins for [Factorix](https://github.com/WebEferen/factorix). The SDK lives in the Factorix repository under `packages/plugin-sdk` and is published to npm from there. A plugin is a server you run. Factorix calls it at one address, and it can add:

- **A tracker.** Factorix follows issues from your service the way it follows Linear or Jira: it syncs them, assigns agents through labels, moves statuses, and comments.
- **Pages.** Entries in Factorix's sidebar or under Settings that open your own HTML in a frame, with forms that post back to your plugin.
- **Settings.** Fields an organization's admin fills in for your plugin, rendered by Factorix from your manifest.
- **Work for agents.** With the permissions an organization's admin allows, a plugin reads what happened on its tickets and asks its agents for work.

Your code never runs inside Factorix, and Factorix's database and session never reach your plugin. What the plugin gets is the connection an admin made for it, the settings an organization saved for it, and the calls its permissions allow.

Plugins that ship with Factorix live in its `plugins/` folder, one folder each, and Factorix starts and installs them by itself. `plugins/digest` is a complete one: a sidebar page, its own tables, a schedule, and an agent that writes each day's digest. The guide to building, installing, and configuring plugins is `docs/plugins.md` in the Factorix repository. This README covers the SDK itself.

## A plugin in one file

```ts
import { definePlugin } from '@moxxy/factorix-plugin-sdk'
import { serve } from '@moxxy/factorix-plugin-sdk/node'

const plugin = definePlugin({
  name: 'Acme board',
  version: '1.0.0',
  connection: {
    fields: [
      { key: 'site', label: 'Site', type: 'url', required: true },
      { key: 'token', label: 'API token', type: 'secret', required: true },
    ],
  },
  settings: { fields: [{ key: 'region', label: 'Region', type: 'text' }] },
  permissions: ['activity:read'],
  pages: [{ key: 'reports', label: 'Reports', render: (context) => `<h1>Hello ${context.account.name}</h1>` }],
  tracker: (connection) => new AcmeTracker(connection.config.site, connection.secrets.token),
})

await serve(plugin, { secret: process.env.PLUGIN_SECRET, port: 8787 })
```

Outside the Factorix repository, `npm install @moxxy/factorix-plugin-sdk`. `tracker` returns an object with the methods of the `Tracker` type. `examples/memory-tracker.ts` is a complete one that keeps its issues in memory. From the Factorix repository:

```sh
PLUGIN_SECRET=$(openssl rand -hex 24) yarn workspace @moxxy/factorix-plugin-sdk example
```

`createHandler(plugin, { secret })` gives the same thing as a `(Request) => Promise<Response>` function, for any runtime that is not plain Node.

## Installing it in Factorix

A plugin in Factorix's own `plugins/` folder is installed by Factorix itself, see `docs/plugins.md`. One that runs anywhere else:

1. Run the plugin somewhere Factorix can reach, behind HTTPS. Connection secrets travel to this address, and people's browsers open its pages there too.
2. An installation admin opens Settings, Plugins, chooses Install plugin, and enters the address (ending in `/factorix`) and the secret the plugin was started with.
3. An organization's admin turns the plugin on there, sees the permissions it asks for, and fills in its settings.
4. For a tracker: Settings, Connections, Add, kind Plugin. Then create a project on that connection.

After you release a new version with a changed manifest, press Refresh on the plugin's row.

## Events

Without events Factorix polls a tracker every few minutes. To tell it sooner, implement `registerWebhook`, remember the `url` it is given, and send events there:

```ts
import { factorix } from '@moxxy/factorix-plugin-sdk'

const fx = factorix({ url: 'https://factorix.example.com', secret: process.env.PLUGIN_SECRET })
await fx.sendEvent(callbackUrl, { kind: 'issue.upserted', issue: { id: 'issue-12' } }, deliveryId)
```

Factorix trusts only the issue's id in an event and reads the rest back through `getIssue`.

## Pages

A page's address carries a `factorix` parameter: who opened it, their organization, the plugin's id in that Factorix, and the plugin's settings, signed and good for five minutes. The SDK checks it before `render` runs. `render` also gets the token itself, so the page's own requests can send it back (as `?factorix=` or an `x-factorix-page` header) and be checked the same way with `readPageToken`.

A form on the page posts to the page's own address, which reaches its `action`. Put the token in the form's address and answer with a redirect back to the page:

```ts
{
  key: 'notes',
  label: 'Notes',
  render: (context, request, token) => `<form method="post" action="?factorix=${token}"><input name="note"><button>Save</button></form>`,
  async action(context, request, token) {
    if (context.account.role !== 'admin') return new Response('Admins only', { status: 403 })
    await save(context.org.id, (await request.formData()).get('note'))
    return new Response(null, { status: 303, headers: { location: `?factorix=${token}` } })
  },
}
```

The page runs in a sandboxed frame on your own address. It cannot read Factorix's cookies or navigate its window. Its link stops working after five minutes, so a page left open that long asks the person to open it again.

## Calling Factorix

`factorix()` signs calls back to Factorix. Each one acts for one organization, which has to have turned the plugin on, and needs the plugin's id: a page has it as `context.plugin.id`, and a plugin with work to do outside a page keeps it from there.

```ts
import { factorix, FactorixError } from '@moxxy/factorix-plugin-sdk'

const fx = factorix({ url: process.env.FACTORIX_URL, secret: process.env.PLUGIN_SECRET, pluginId: context.plugin.id })
const { settings, secrets } = await fx.settings(orgId) // secret settings are never in the page token
const activity = await fx.activity(orgId, since) // needs activity:read
const agents = await fx.agents(orgId) // needs agents:run
const run = await fx.startRun(orgId, { agentId, prompt, outputSchema })
const done = await fx.getRun(orgId, run.id) // done.output once done.state is succeeded
const members = await fx.members(orgId) // needs members:read
const projects = await fx.projects(orgId) // needs tickets:write
const ticket = await fx.createTicket(orgId, { projectId: projects[0].id, title: 'Order a laptop' })
const now = await fx.getTicket(orgId, ticket.id) // now.closed once its status is completed or canceled
await fx.finishStep(orgId, { runId, nodeId, handle: 'sent' }) // needs workflows:blocks, ends a step a block held
await fx.fireTrigger(orgId, { trigger: 'reacted', data: { who: 'Kim' }, eventId }) // needs workflows:blocks, starts workflows built on it
```

What a plugin may ask beyond its own settings is a permission it names in `definePlugin({ permissions })`:

- `activity:read`: the organization's tickets that have an assignee or an agent and changed since a moment or are still open (at most 31 days back), the merge requests of those tickets merged since then, and what agents reported on them.
- `agents:run`: the organization's agents, and runs of them with no ticket and no repository. A run gets your prompt and answers in the shape of `outputSchema`, a JSON Schema of an object. Claude and Codex both fill it, so close every object with `additionalProperties: false` and list every property under `required`. At most three of a plugin's runs are unfinished at once.
- `members:read`: the organization's people and agents, with their names, handles, roles, and whether each is active. No email addresses.
- `tickets:write`: the names of the organization's projects, and tickets you create in them, in whatever tracker each project follows. Give `agentId` to hand the ticket to an agent. You read back only tickets you created.
- `workflows:blocks`: blocks and triggers in the organization's workflows, and what each block is given when it runs. A trigger starts workflows with no ticket, and each filled-in field of it has to equal the event's value under the same key. `definePlugin` adds it for a plugin with `blocks` or `triggers`.

An organization's admin sees these when turning the plugin on, and Factorix answers only what that admin allowed. A permission a newer version of your plugin adds is refused until the admin saves the plugin's settings again. A refused call throws `FactorixError`, whose `status` is 403 for a permission that was not allowed, 404 when the organization has not turned the plugin on or the run is not this plugin's, 409 for a disabled agent or too many runs, and 401 for a wrong secret.

Text in the activity comes from trackers and people. When you put it into a prompt, mark it as data, as `plugins/digest` does, since the agent follows what its prompt asks.

## Workflow blocks

A block is a step an organization's workflows can take, run by your plugin:

```ts
definePlugin({
  name: 'Chat',
  version: '1.0.0',
  blocks: [
    {
      key: 'post',
      title: 'Post to chat',
      description: 'Posts a message to a channel.',
      fields: [
        { key: 'channel', label: 'Channel', kind: 'select', dynamic: true, required: true },
        { key: 'text', label: 'Message', kind: 'template', required: true },
      ],
      outputs: [
        { id: 'sent', label: 'Sent' },
        { id: 'muted', label: 'Muted' },
      ],
      async run(call) {
        return { handle: 'sent', output: { ts: await post(call.config.channel, call.config.text) } }
      },
      options: async ({ org }) => listChannels(org.id),
    },
  ],
})
```

`call.config` holds the block's fields with `{{...}}` placeholders already filled. A `dynamic` select gets its choices from `options`. A block leaves through the output it names, the first by default, or through `failed` when `run` throws. `output` reaches later blocks as `{{steps.<block id>.<key>}}`. Slow work answers `{ wait: true }` and calls `finishStep` with `call.run.id` and `call.nodeId` once done, using `call.plugin.id` as the `pluginId`. A held step fails after seven days without word.

## Your own tables

A plugin that needs to store something uses its own database. The SDK has a small runner for migrations that go both ways:

```ts
import { migrateDown, migrateUp } from '@moxxy/factorix-plugin-sdk'

const migrations = [{ id: '0001_boards', up: 'CREATE TABLE boards (id text PRIMARY KEY, org_id text NOT NULL)', down: 'DROP TABLE boards' }]
await migrateUp(client, migrations) // on start
await migrateDown(client, migrations, 1) // roll the newest one back
```

`client` is one Postgres connection, such as a `pg` Client or a client taken from a Pool. Each migration runs in a transaction, and a lock keeps two instances from running the same one. Keep the organization's id on every row: one plugin serves every organization that turned it on. A plugin in Factorix's `plugins/` folder that asks for a database gets an empty one of its own as `DATABASE_URL`.

## Testing

```ts
import { checkTracker, factorixClient, fakeFactorix } from '@moxxy/factorix-plugin-sdk/testing'

const client = factorixClient(plugin)
await checkTracker(client.tracker({ config: { site: 'https://acme.test' }, secrets: { token: 't' } }))
expect(await client.runBlock('post', { config: { channel: 'C1', text: 'Hi' } })).toEqual({ handle: 'sent', output: { ts: '1.5' } })
expect((await client.openPage('reports')).status).toBe(200)
expect((await client.openPage('notes', { account: { id: 'a', name: 'Kim', role: 'admin' } }, { form: { note: 'hi' } })).status).toBe(303)

const fake = fakeFactorix({ agents: () => [{ id: 'agent-1', handle: 'eng', name: 'Eng', status: 'active', runtime: 'claude', model: null }] })
const fx = factorix({ url: 'https://factorix.test', secret: 'test-secret-0123456789', pluginId: 'plugin-1', fetch: fake.fetch })
```

`factorixClient` calls your plugin the way Factorix does, signatures included, and `openPage` with `form` posts to a page's `action`. `fakeFactorix` answers your plugin's calls to Factorix without a network: give it a handler for each call your test needs, and throw a `FactorixError` from one to refuse. `checkTracker` walks a tracker through a sync, a status change, agent labels, and a comment, and says what is off. It writes to the tracker, so point it at a test account.

## The protocol

Version 1. Everything is JSON over HTTPS, signed with one shared secret:

- `x-factorix-timestamp`: milliseconds since the epoch. More than five minutes off is refused.
- `x-factorix-signature`: `sha256=` and the hex HMAC-SHA256 of `<timestamp>.<body>`.

Factorix to plugin, `POST <address>`:

```json
{ "protocol": 1, "method": "tracker.listTeams", "params": [], "connection": { "id": "…", "config": {}, "secrets": {} } }
```

The answer is `{ "result": … }`, or `{ "error": { "message": "…" } }` with a status of 400 or above. `manifest`, `workflow.block`, and `workflow.options` come with no connection. `workflow.block` has the block's call as its one param and answers `{ "handle", "output" }` or `{ "wait": true }`. `workflow.options` has `{ "block", "field", "org" }` and answers `[{ "value", "label" }]`.

The manifest names what the plugin asks of Factorix as `"permissions": ["activity:read", "agents:run"]`.

Plugin to Factorix, each signed the same way:

- `POST <factorix>/webhooks/plugin/<connectionId>` with `{ "event": … }`, and an optional `x-factorix-delivery` header to drop repeats.
- `POST <factorix>/webhooks/plugins/<pluginId>/settings` with `{ "orgId": "…" }`, answered with `{ "settings", "secrets" }`.
- `POST <factorix>/webhooks/plugins/<pluginId>/activity` with `{ "orgId", "since" }`, answered with `{ "activity" }`. Needs `activity:read`.
- `POST <factorix>/webhooks/plugins/<pluginId>/agents` with `{ "orgId" }`, answered with `{ "agents" }`. Needs `agents:run`.
- `POST <factorix>/webhooks/plugins/<pluginId>/runs` with `{ "orgId", "agentId", "prompt", "outputSchema" }`, answered with `{ "run" }`. Needs `agents:run`.
- `POST <factorix>/webhooks/plugins/<pluginId>/runs/<runId>` with `{ "orgId" }`, answered with `{ "run" }`. Needs `agents:run`.
- `POST <factorix>/webhooks/plugins/<pluginId>/members` with `{ "orgId" }`, answered with `{ "members" }`. Needs `members:read`.
- `POST <factorix>/webhooks/plugins/<pluginId>/projects` with `{ "orgId" }`, answered with `{ "projects" }`. Needs `tickets:write`.
- `POST <factorix>/webhooks/plugins/<pluginId>/tickets` with `{ "orgId", "projectId", "title", "description", "priority", "agentId" }`, answered with `{ "ticket" }`. Needs `tickets:write`.
- `POST <factorix>/webhooks/plugins/<pluginId>/tickets/<ticketId>` with `{ "orgId" }`, answered with `{ "ticket" }`. Needs `tickets:write`.
- `POST <factorix>/webhooks/plugins/<pluginId>/workflow-steps` with `{ "orgId", "runId", "nodeId", "handle", "output", "error" }`, answered with `{ "ok": true }`. Needs `workflows:blocks`.
- `POST <factorix>/webhooks/plugins/<pluginId>/workflow-triggers` with `{ "orgId", "trigger", "data", "eventId" }`, answered with `{ "started" }`. Needs `workflows:blocks`.

A refusal is a status of 400 or above with `{ "error": { "message": "…" } }`.

Limits today: a plugin provides a tracker, pages, settings, workflow blocks and triggers, and work for agents. It cannot serve a code host or attachments yet.

## Publishing the SDK

From the Factorix repository: `yarn workspace @moxxy/factorix-plugin-sdk release`. It builds `dist/` with its own `package.json` and publishes that folder. Inside the repository nothing is built: plugins read the SDK's sources.
