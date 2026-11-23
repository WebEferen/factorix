<p align="center">
  <img src="https://raw.githubusercontent.com/WebEferen/factorix/main/apps/web/public/icon-192.png" width="80" height="80" alt="Factorix logo">
</p>

<h1 align="center">Factorix plugin SDK</h1>

<p align="center">
  Extend <a href="https://github.com/WebEferen/factorix">Factorix</a> with your own trackers, pages, settings, and workflow blocks, served from your own server.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@moxxy/factorix-plugin-sdk"><img src="https://img.shields.io/npm/v/%40moxxy%2Ffactorix-plugin-sdk?label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@moxxy/factorix-plugin-sdk"><img src="https://img.shields.io/node/v/%40moxxy%2Ffactorix-plugin-sdk" alt="Node.js version"></a>
  <a href="https://github.com/WebEferen/factorix/blob/main/packages/plugin-sdk/LICENSE"><img src="https://img.shields.io/npm/l/%40moxxy%2Ffactorix-plugin-sdk" alt="MIT license"></a>
</p>

A Factorix plugin is a small server you run. Factorix calls it at one address, signed with a secret you share, and the plugin can add:

| You can add           | What it does                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A tracker**         | Factorix follows issues from your service the way it follows Linear or Jira: it syncs them, assigns agents through labels, moves statuses, and comments. |
| **Pages**             | Entries in Factorix's sidebar or under Settings that open your own HTML, with forms that post back to your plugin.                                       |
| **Settings**          | Fields an organization's admin fills in for your plugin. Factorix renders them from your manifest.                                                       |
| **Workflow blocks**   | Steps that organizations drop into their workflows, run by your plugin.                                                                                  |
| **Workflow triggers** | Events in your plugin that start workflows.                                                                                                              |
| **Work for agents**   | With the permissions an admin allows, your plugin reads what happened on tickets, creates tickets, and asks agents for work.                             |

Your code never runs inside Factorix, and Factorix's database and sessions never reach your plugin. A plugin gets only the connection an admin made for it, the settings an organization saved for it, and the calls its permissions allow.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Install it in Factorix](#install-it-in-factorix)
- [Trackers](#trackers)
- [Pages](#pages)
- [Calling Factorix](#calling-factorix)
- [Workflow blocks](#workflow-blocks)
- [Workflow triggers](#workflow-triggers)
- [Your own tables](#your-own-tables)
- [Testing](#testing)
- [Protocol reference](#protocol-reference)

## Install

```sh
npm install @moxxy/factorix-plugin-sdk
```

You need Node.js 22 or newer. The SDK has no dependencies, ships its own TypeScript types, and is an ES module. Besides the main entry it has two more: `@moxxy/factorix-plugin-sdk/node` serves a plugin with Node's HTTP server, and `@moxxy/factorix-plugin-sdk/testing` runs one in your tests.

## Quick start

A plugin with a connection form, a setting, a page, and a tracker, in one file:

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

const secret = process.env.PLUGIN_SECRET
if (!secret) throw new Error('Set PLUGIN_SECRET to at least 16 random characters')
await serve(plugin, { secret, port: 8787 })
```

Run it with a fresh secret, which you will type into Factorix too:

```sh
PLUGIN_SECRET=$(openssl rand -hex 24) npx tsx plugin.ts
```

`AcmeTracker` is yours to write: an object with the methods of the [`Tracker`](#trackers) type. [`examples/memory-tracker.ts`](https://github.com/WebEferen/factorix/blob/main/packages/plugin-sdk/examples/memory-tracker.ts) is a complete one that keeps its issues in memory.

`serve` answers at `/factorix` by default. On a runtime that is not plain Node, such as Bun, Deno, or an edge function, use `createHandler(plugin, { secret })` instead. It returns a `(request: Request) => Promise<Response>` function.

> **Bundled plugins.** Plugins that ship with Factorix live in its [`plugins/`](https://github.com/WebEferen/factorix/tree/main/plugins) folder, and Factorix starts and installs them by itself. [`plugins/digest`](https://github.com/WebEferen/factorix/tree/main/plugins/digest) is a complete example with a sidebar page, its own tables, a schedule, and an agent that writes a daily digest. The full guide is [`docs/plugins.md`](https://github.com/WebEferen/factorix/blob/main/docs/plugins.md).

## Install it in Factorix

1. Run the plugin where Factorix can reach it, behind HTTPS. Connection secrets travel to this address, and people's browsers open its pages there too.
2. An installation admin opens **Settings → Plugins**, chooses **Install plugin**, and enters the plugin's address (ending in `/factorix`) and its secret.
3. An organization's admin turns the plugin on, reviews the permissions it asks for, and fills in its settings.
4. For a tracker, add a connection under **Settings → Connections** with the kind **Plugin**, then create a project on it.

When you release a version with a changed manifest, press **Refresh** on the plugin's row so Factorix reads it again.

## Trackers

`tracker(connection)` returns an object that Factorix calls for one connection. It is created for each request, so keep it cheap and keep no state in it.

| Methods                                                                                                                                          | Purpose                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `viewer()`                                                                                                                                       | Who the connection signs in as. Used by the connection's **Test** button.                     |
| `listTeams()`, `listWorkflowStates(teamId)`, `listLabels(teamId)`                                                                                | What a project can follow, and the statuses and labels in it.                                 |
| `listIssues(query)`, `getIssue(id)`, `listComments(issueId)`                                                                                     | Reading issues. `listIssues` returns them oldest change first, so a sync can stop and resume. |
| `createIssue(input)`, `updateIssueState(issueId, stateId)`, `updateIssueLabels(issueId, change)`, `createLabel(input)`, `comment(issueId, body)` | Writing back as agents work.                                                                  |
| `updateComment`, `listProjects`, `listResources`, `registerWebhook`                                                                              | Optional.                                                                                     |

Without events, Factorix polls a tracker every few minutes. To tell it about changes sooner, implement `registerWebhook`, keep the `url` it receives, and send events there:

```ts
import { factorix } from '@moxxy/factorix-plugin-sdk'

const fx = factorix({ url: 'https://factorix.example.com', secret })
await fx.sendEvent(callbackUrl, { kind: 'issue.upserted', issue: { id: 'issue-12' } }, deliveryId)
```

Factorix trusts only the issue's id in an event and reads the rest back through `getIssue`. Pass the same `deliveryId` again when you retry, and Factorix drops the repeat.

## Pages

A page's address carries a `factorix` parameter: who opened it, their organization, the plugin's id in that Factorix, and the plugin's settings, signed and valid for five minutes. The SDK checks it before `render` runs. `render` also receives the token, so the page's own requests can send it back (as `?factorix=` or an `x-factorix-page` header) and you can check them with `readPageToken`.

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

The page runs in a sandboxed frame on your own address. It cannot read Factorix's cookies or navigate its window. Its link expires after five minutes, so a page left open longer asks the person to open it again.

## Calling Factorix

`factorix()` signs calls back to Factorix. Each call acts for one organization that has turned the plugin on, and needs the plugin's id in that Factorix. A page has it as `context.plugin.id`, and a block as `call.plugin.id`. Keep it from there for work you do later.

```ts
import { factorix, FactorixError } from '@moxxy/factorix-plugin-sdk'

const fx = factorix({ url: process.env.FACTORIX_URL, secret, pluginId: context.plugin.id })

const { settings, secrets } = await fx.settings(orgId) // secret settings never travel in the page token
const activity = await fx.activity(orgId, since) // activity:read
const agents = await fx.agents(orgId) // agents:run
const run = await fx.startRun(orgId, { agentId, prompt, outputSchema }) // agents:run
const done = await fx.getRun(orgId, run.id) // done.output once done.state is 'succeeded'
const members = await fx.members(orgId) // members:read
const projects = await fx.projects(orgId) // tickets:write
const ticket = await fx.createTicket(orgId, { projectId: projects[0].id, title: 'Order a laptop' }) // tickets:write
const now = await fx.getTicket(orgId, ticket.id) // now.closed once it is completed or canceled
await fx.finishStep(orgId, { runId, nodeId, handle: 'sent' }) // workflows:blocks
await fx.fireTrigger(orgId, { trigger: 'reacted', data: { who: 'Kim' }, eventId }) // workflows:blocks
```

### Permissions

Anything beyond its own settings is a permission the plugin names in `definePlugin({ permissions })`. An organization's admin sees the list when turning the plugin on, and Factorix answers only what that admin allowed.

| Permission         | What it allows                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activity:read`    | The organization's tickets that have an assignee or an agent and changed since a given moment or are still open (up to 31 days back), the merge requests of those tickets merged since then, and what agents reported on them.                                                                                                                                              |
| `agents:run`       | The organization's agents, and runs of them with no ticket and no repository. A run gets your prompt and answers in the shape of `outputSchema`, a JSON Schema of an object. Close every object with `additionalProperties: false` and list every property under `required`, so both Claude and Codex can fill it. At most three of a plugin's runs are unfinished at once. |
| `members:read`     | The organization's people and agents, with their names, handles, roles, and whether each is active. No email addresses.                                                                                                                                                                                                                                                     |
| `tickets:write`    | The names of the organization's projects, and tickets you create in them, in whatever tracker each project follows. Give `agentId` to hand a ticket to an agent. You read back only tickets you created.                                                                                                                                                                    |
| `workflows:blocks` | Blocks and triggers in the organization's workflows, and what each block receives when it runs. `definePlugin` adds it for a plugin with `blocks` or `triggers`.                                                                                                                                                                                                            |

A permission that a newer version of your plugin adds stays refused until the admin saves the plugin's settings again.

### Errors

A refused call throws `FactorixError`, with a `status`:

| Status | Meaning                                                                         |
| ------ | ------------------------------------------------------------------------------- |
| `401`  | The secret does not match the one Factorix has.                                 |
| `403`  | The organization's admin did not allow this permission.                         |
| `404`  | The organization has not turned the plugin on, or the run is not this plugin's. |
| `409`  | The agent is disabled, or the plugin already has three unfinished runs.         |

> **Treat text as data.** Ticket and activity text comes from trackers and people. When you put it into a prompt, mark it as data, as `plugins/digest` does, because an agent follows what its prompt asks.

## Workflow blocks

A block is a step that an organization's workflows can take, run by your plugin:

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
      provides: [{ key: 'ts', label: 'Message id' }],
      async run(call) {
        return { handle: 'sent', output: { ts: await post(call.config.channel, call.config.text) } }
      },
      options: async ({ org }) => listChannels(org.id),
    },
  ],
})
```

- A field is `text`, `template`, `longTemplate`, `number`, or `select`. Factorix fills the `{{...}}` placeholders of templates before your block runs, so `call.config` holds plain text.
- A `dynamic` select gets its choices from `options`, for each organization.
- A block leaves through the output it names, the first one by default. When `run` throws, it leaves through `failed`, which every block has.
- `output` reaches later blocks as `{{steps.<block id>.<key>}}`. List its keys under `provides` so the editor can offer them.
- Slow work answers `{ wait: true }` right away and calls `finishStep` with `call.run.id` and `call.nodeId` when it is done, using `call.plugin.id` as the `pluginId`. A held step fails after seven days without word.

A call carries ticket text, so treat it as data. When an organization turns the plugin off, its blocks stop running.

## Workflow triggers

A trigger is something that happens in your plugin and starts workflows. Those workflows run with no ticket.

```ts
definePlugin({
  // ...
  triggers: [
    {
      key: 'reacted',
      title: 'Reaction added',
      description: 'Starts when someone reacts in chat.',
      fields: [{ key: 'emoji', label: 'Emoji', kind: 'text', hint: 'Leave empty for any.' }],
      provides: [{ key: 'who', label: 'Who reacted' }],
    },
  ],
})

// whenever it happens:
await fx.fireTrigger(orgId, { trigger: 'reacted', data: { emoji: 'tada', who: 'Kim' }, eventId: reactionId })
```

- The trigger's fields narrow which events start a workflow: each field an admin fills in has to equal the event's value under the same key, ignoring case. They can only be `text` or `select`.
- `data` holds those values and what the trigger `provides`, as text. Later blocks read them as `{{steps.<trigger id>.<key>}}`.
- The same `eventId` starts each workflow only once, so it is safe to send an event again when you are not sure it arrived. `fireTrigger` returns how many workflows started.
- A trigger's key cannot be the same as a block's.

## Your own tables

A plugin that stores data uses its own database. The SDK includes a small migration runner that goes both ways:

```ts
import { migrateDown, migrateUp } from '@moxxy/factorix-plugin-sdk'

const migrations = [{ id: '0001_boards', up: 'CREATE TABLE boards (id text PRIMARY KEY, org_id text NOT NULL)', down: 'DROP TABLE boards' }]

await migrateUp(client, migrations) // on start
await migrateDown(client, migrations, 1) // roll the newest one back
```

`client` is one Postgres connection, such as a `pg` `Client` or a client taken from a `Pool`. Each migration runs in a transaction, and a lock keeps two instances from running the same one. Keep the organization's id on every row, since one plugin serves every organization that turned it on. A bundled plugin that asks for a database gets an empty one of its own as `DATABASE_URL`.

## Testing

`@moxxy/factorix-plugin-sdk/testing` runs your plugin without a network:

```ts
import { factorix } from '@moxxy/factorix-plugin-sdk'
import { checkTracker, factorixClient, fakeFactorix } from '@moxxy/factorix-plugin-sdk/testing'

const client = factorixClient(plugin)
await checkTracker(client.tracker({ config: { site: 'https://acme.test' }, secrets: { token: 't' } }))
expect(await client.runBlock('post', { config: { channel: 'C1', text: 'Hi' } })).toEqual({ handle: 'sent', output: { ts: '1.5' } })
expect((await client.openPage('reports')).status).toBe(200)
expect((await client.openPage('notes', { account: { id: 'a', name: 'Kim', role: 'admin' } }, { form: { note: 'hi' } })).status).toBe(303)

const fake = fakeFactorix({ agents: () => [{ id: 'agent-1', handle: 'eng', name: 'Eng', status: 'active', runtime: 'claude', model: null }] })
const fx = factorix({ url: 'https://factorix.test', secret: 'test-secret-0123456789', pluginId: 'plugin-1', fetch: fake.fetch })
```

- `factorixClient` calls your plugin the way Factorix does, signatures included. `openPage` with `form` posts to a page's `action`.
- `fakeFactorix` answers your plugin's calls to Factorix: give it a handler for each call your test needs, and throw a `FactorixError` from one to refuse.
- `checkTracker` walks a tracker through a sync, a status change, agent labels, and a comment, and reports what is off. It writes to the tracker, so point it at a test account.

## Protocol reference

You only need this to write a plugin without the SDK. Protocol version 1: everything is JSON over HTTPS, signed with the shared secret.

| Header                 | Value                                                                |
| ---------------------- | -------------------------------------------------------------------- |
| `x-factorix-timestamp` | Milliseconds since the epoch. More than five minutes off is refused. |
| `x-factorix-signature` | `sha256=` followed by the hex HMAC-SHA256 of `<timestamp>.<body>`.   |

**Factorix to plugin** is a `POST` to the plugin's address:

```json
{ "protocol": 1, "method": "tracker.listTeams", "params": [], "connection": { "id": "…", "config": {}, "secrets": {} } }
```

The answer is `{ "result": … }`, or `{ "error": { "message": "…" } }` with a status of 400 or above. `manifest`, `workflow.block`, and `workflow.options` come without a connection. `workflow.block` has the block's call as its only param and answers `{ "handle", "output" }` or `{ "wait": true }`. `workflow.options` has `{ "block", "field", "org" }` and answers `[{ "value", "label" }]`. The manifest lists what the plugin asks of Factorix as `"permissions": ["activity:read", "agents:run"]`.

**Plugin to Factorix** calls are `POST`s, signed the same way. Every path under `/webhooks/plugins/<pluginId>/` takes the organization as `orgId` in the body.

| Path                                              | Body                                                                      | Answer                  | Permission         |
| ------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------- | ------------------ |
| `/webhooks/plugin/<connectionId>`                 | `{ event }`, and an optional `x-factorix-delivery` header to drop repeats | `{ ok, duplicate }`     | none               |
| `/webhooks/plugins/<pluginId>/settings`           | `{ orgId }`                                                               | `{ settings, secrets }` | none               |
| `/webhooks/plugins/<pluginId>/activity`           | `{ orgId, since }`                                                        | `{ activity }`          | `activity:read`    |
| `/webhooks/plugins/<pluginId>/agents`             | `{ orgId }`                                                               | `{ agents }`            | `agents:run`       |
| `/webhooks/plugins/<pluginId>/runs`               | `{ orgId, agentId, prompt, outputSchema }`                                | `{ run }`               | `agents:run`       |
| `/webhooks/plugins/<pluginId>/runs/<runId>`       | `{ orgId }`                                                               | `{ run }`               | `agents:run`       |
| `/webhooks/plugins/<pluginId>/members`            | `{ orgId }`                                                               | `{ members }`           | `members:read`     |
| `/webhooks/plugins/<pluginId>/projects`           | `{ orgId }`                                                               | `{ projects }`          | `tickets:write`    |
| `/webhooks/plugins/<pluginId>/tickets`            | `{ orgId, projectId, title, description, priority, agentId }`             | `{ ticket }`            | `tickets:write`    |
| `/webhooks/plugins/<pluginId>/tickets/<ticketId>` | `{ orgId }`                                                               | `{ ticket }`            | `tickets:write`    |
| `/webhooks/plugins/<pluginId>/workflow-steps`     | `{ orgId, runId, nodeId, handle, output, error }`                         | `{ ok: true }`          | `workflows:blocks` |
| `/webhooks/plugins/<pluginId>/workflow-triggers`  | `{ orgId, trigger, data, eventId }`                                       | `{ started }`           | `workflows:blocks` |

A refusal is a status of 400 or above with `{ "error": { "message": "…" } }`.

## Limits

Today a plugin can provide a tracker, pages, settings, workflow blocks and triggers, and work for agents. It cannot serve a code host or attachments yet.

## Developing the SDK

The SDK lives in the Factorix repository under [`packages/plugin-sdk`](https://github.com/WebEferen/factorix/tree/main/packages/plugin-sdk). Inside the repository nothing is built: bundled plugins read the SDK's sources. To try the example tracker from there:

```sh
PLUGIN_SECRET=$(openssl rand -hex 24) yarn workspace @moxxy/factorix-plugin-sdk example
```

The Release workflow publishes a new patch version every day when the SDK changed. To publish by hand: `yarn workspace @moxxy/factorix-plugin-sdk release`, which builds `dist/` with its own `package.json` and publishes that folder.

## License

[MIT](https://github.com/WebEferen/factorix/blob/main/packages/plugin-sdk/LICENSE)
