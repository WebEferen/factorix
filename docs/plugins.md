# Plugins

A plugin adds something to Factorix from a server of its own: a tracker, pages in the sidebar or under Settings, settings an organization fills in, and, when an organization allows it, a read of what happened on tickets and requests to its agents. Its code never runs inside the API or the worker, and Factorix's database and session never reach it. Everything between the two is signed JSON over HTTP.

Two plugins ship with Factorix. The daily digest lives in [`plugins/digest`](../plugins/digest) and is a good one to read next to this page. Company lives in [`plugins/company`](../plugins/company): it keeps who is in which department, and runs the company's processes with an engine of its own, where a form starts a case and people, approvals, agents, and tickets take it step by step.

## Two ways to run one

|                      | Bundled                                          | External                                                                    |
| -------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| Where the code lives | `plugins/<name>` in this repository              | Any repository, any language                                                |
| Who runs it          | The `plugins` container, one process per plugin  | Whoever owns it, behind HTTPS                                               |
| Installing           | Nothing to do: the worker registers it           | An installation admin enters its address and secret under Settings, Plugins |
| Secret               | Derived from `FACTORIX_PLUGINS_KEY` and its name | Chosen by whoever runs it, at least 16 characters                           |
| Pages                | `https://<name>.plugins.<domain>`                | Its own address                                                             |
| Database             | Its own Postgres database, on request            | Its own                                                                     |

Either way, each organization turns a plugin on for itself under Settings, Plugins, and sees what it may do before it does.

## Building a bundled plugin

### 1. A folder

```
plugins/hello/
  package.json
  src/main.ts
  src/plugin.ts
  src/plugin.test.ts
```

The folder name is the plugin's name: lower case letters, digits, and dashes. `package.json` says where the plugin starts and whether it needs a database:

```json
{
  "name": "factorix-plugin-hello",
  "private": true,
  "type": "module",
  "factorix": { "main": "src/main.ts", "database": false },
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" },
  "dependencies": { "@moxxylabs/factorix-plugin-sdk": "0.2.0", "tsx": "4.23.15" }
}
```

A bundled plugin imports only the SDK, never `@factorix/*`. That keeps it a plugin like any other, one that could move to its own server tomorrow. Run `yarn install` once so the workspace links it.

### 2. The plugin

```ts
// src/plugin.ts
import { definePlugin } from '@moxxylabs/factorix-plugin-sdk'

export const plugin = definePlugin({
  name: 'Hello',
  version: '1.0.0',
  description: 'Says hello to whoever opens it',
  settings: { fields: [{ key: 'greeting', label: 'Greeting', type: 'text', placeholder: 'Hello' }] },
  pages: [
    {
      key: 'hello',
      label: 'Hello',
      placement: 'sidebar',
      render: (context) => `<h1>${context.settings.greeting ?? 'Hello'}, ${context.account.name}</h1>`,
    },
  ],
})
```

```ts
// src/main.ts
import { serve } from '@moxxylabs/factorix-plugin-sdk/node'
import { plugin } from './plugin'

await serve(plugin, { secret: String(process.env.PLUGIN_SECRET), port: Number(process.env.PORT), hostname: process.env.HOST })
```

The manifest Factorix reads is built from `definePlugin`. What each part does:

- `settings.fields`: what an organization's admin fills in on the plugin's row under Settings, Plugins. Factorix renders the form. A `secret` field is stored encrypted and never shown again.
- `connection.fields`: for a plugin that provides a tracker, what an admin fills in when connecting one account under Settings, Connections.
- `pages`: `sidebar` puts an entry in the main menu, `settings` a link on the plugin's row.
- `permissions`: what the plugin may ask of Factorix (below).
- `tracker`: a tracker Factorix follows like Linear or Jira. See the SDK README.

### 3. What the plugin host gives it

The plugin host starts `main` with tsx, from the plugin's folder, with these variables and nothing else from its own environment:

| Variable        | What it is                                                                                |
| --------------- | ----------------------------------------------------------------------------------------- |
| `PLUGIN_SECRET` | This plugin's secret. Signs everything between it and Factorix.                           |
| `PORT`, `HOST`  | Where to listen. Always loopback: the host routes to it.                                  |
| `FACTORIX_URL`  | Where to call Factorix.                                                                   |
| `DATABASE_URL`  | Its own empty database, when `"database": true`.                                          |
| `<KEY>`         | Installation config: the host's `PLUGIN_<NAME>_<KEY>` reaches plugin `<name>` as `<KEY>`. |

The SDK has `migrateUp(client, migrations)` for the plugin's own tables. Keep the organization's id on every row: one plugin serves every organization that turned it on.

### 4. Pages

A page is HTML the plugin serves, shown in a sandboxed frame. Its address carries a `factorix` parameter: who opened it, their organization, the plugin's settings, and the plugin's id, signed and good for five minutes. The SDK checks it before `render` runs.

A page that changes something gives the page an `action`. It runs for a POST to the page's own path, checked the same way, so a form only needs to post back with the token:

```ts
{
  key: 'hello',
  label: 'Hello',
  render: (context, request, token) => `<form method="post" action="?factorix=${token}"><button>Wave</button></form>`,
  action: async (context, request, token) => {
    const form = await request.formData()
    // ...change something for context.org.id, then show the page again.
    return new Response(null, { status: 303, headers: { location: `?factorix=${token}` } })
  },
}
```

Escape every piece of text that came from a tracker, a person, or an agent, and consider a content security policy with a nonce, as the digest's page sends. Check `context.account.role === 'admin'` before letting someone change what the whole organization sees. After five minutes the token expires, and the SDK answers with a short note to open the page again from the sidebar.

A page people keep open asks for the next token before that: `window.parent.postMessage({ type: 'factorix:token', token }, '*')`, with the token it holds now. Factorix answers the frame it opened with `{ type: 'factorix:token', token }`, signed for whoever is signed in at that moment. A bundled plugin's page runs without an origin, so Factorix answers it only when the token it sent is the last one it was given. Put the new token into the page's links and forms, as the script in Company's `view.ts` does. A token is checked by its signature, so a page loses nothing by listening.

The frame may write to the clipboard (`navigator.clipboard`), open links in a new tab (`target="_blank"`), and download files. It cannot navigate Factorix's window or read its cookies.

A bundled plugin's pages open under `/_plugin/<name>` on Factorix's own address. The plugin host sends them with a `sandbox` content security policy, so each one runs without an origin even when opened on its own: no cookies, no `localStorage`, and a `fetch` to its own server is cross-origin. Forms and links work as usual. The host also keeps Factorix's cookies out of the request and drops `Set-Cookie` and `Clear-Site-Data` from the answer.

### 5. Asking Factorix for more

A plugin names what it needs in `permissions`, and the organization's admin sees each one, in plain words, when turning it on. Factorix answers only for organizations that turned the plugin on and only with permissions their admin allowed. When a new version asks for more, the plugin's row says "Asks for more" until an admin saves its settings again.

| Permission         | What it opens                                                                                                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activity:read`    | Tickets with a person or an agent on them that changed since a moment or are still open, their merged merge requests, and what agents reported, for up to 31 days back.                                                                                                                                                      |
| `agents:run`       | The organization's agents, and runs that hand one of them a request. A run has no ticket and no repository, answers in the JSON shape the plugin names, and appears under Runs like any other. At most three are unfinished per plugin and organization.                                                                     |
| `members:read`     | The people and agents of the organization: names, handles, roles, and whether each is active. No email addresses.                                                                                                                                                                                                            |
| `tickets:write`    | The names of the organization's projects, and tickets the plugin creates in them, in whatever tracker each project follows. A ticket can be handed to an agent as it is created. The plugin reads back only tickets it created.                                                                                              |
| `workflows:blocks` | Blocks and triggers in the organization's workflows, and what each block is given when it runs: its fields with templates filled, the ticket's identifier, title, and link, and the workflow's name. `finishStep` ends only steps of the plugin's own blocks, and `fireTrigger` starts only workflows built on its triggers. |

```ts
import { factorix } from '@moxxylabs/factorix-plugin-sdk'

const fx = factorix({ url: process.env.FACTORIX_URL, secret: process.env.PLUGIN_SECRET, pluginId: context.plugin.id })

const activity = await fx.activity(orgId, since)
const [agent] = await fx.agents(orgId)
const run = await fx.startRun(orgId, {
  agentId: agent.id,
  prompt: 'Summarize these tickets in one sentence.\n<tickets>…</tickets>',
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary'],
    properties: { summary: { type: 'string' } },
  },
})
// Later, from a sweep or when the page loads:
const done = await fx.getRun(orgId, run.id) // done.finished, done.state, done.output
```

A refusal throws a `FactorixError` whose `status` is the one in the table at the end of this page. The digest, for example, turns its own schedule off when Factorix answers 404, since that means the organization turned the plugin off.

The plugin's id is in every page's context. A plugin that works without a page open, as the digest does on its schedule, keeps the id it saw with the organization's other settings.

An output schema follows the rules both Claude and Codex accept: every object has `additionalProperties: false` and lists every property under `required`. The agent's answer is text it wrote from your prompt, so check it against what you asked before storing it, as the digest does with `digestContentFrom`.

### 6. Workflow blocks

A plugin can add steps to workflows. Its blocks show in the workflow editor under the plugin's name for every organization that turned it on, and Factorix calls the block's `run` when a workflow reaches it.

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
      provides: [{ key: 'ts', label: 'Message' }],
      async run(call) {
        const ts = await post(call.org.id, call.config.channel, call.config.text)
        return { handle: 'sent', output: { ts } }
      },
      options: async ({ org }) => (await channels(org.id)).map((channel) => ({ value: channel.id, label: `#${channel.name}` })),
    },
  ],
})
```

- A field is `text`, `template`, `longTemplate`, `number`, or `select`. Factorix fills a template's `{{...}}` placeholders before the block sees it, so `call.config` holds plain text, and only for the fields the block declares.
- A `select` with `dynamic` gets its choices from the block's `options`, per organization, while someone edits the workflow.
- `outputs` are the ways out, `next` when the block names none. Every block also has `failed`, taken when `run` throws, with the error as the step's reason.
- `output` is what later blocks read as `{{steps.<block id>.<key>}}`: up to 20 keys, each a text of up to 4000 characters. `provides` lists them for the editor.
- Work that takes longer than a moment answers `{ wait: true }` and calls `fx.finishStep(orgId, { runId: call.run.id, nodeId: call.nodeId, handle, output })` when it is done, or passes `error` to fail the step. `call.plugin.id` is the `pluginId` that call needs. A held step fails after seven days without word. Company's "Start a company process" works this way: its step waits until the case closes.

A plugin with blocks asks for `workflows:blocks`, which `definePlugin` adds. A call carries ticket text, so treat it as data. When an organization turns the plugin off, its blocks stop running and a workflow that uses them cannot be published.

A plugin can also start workflows. A trigger is something that happens inside it, and a workflow that starts from one runs with no ticket, so the editor keeps blocks that work on a ticket away from it. Report each event with `fireTrigger`:

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

await fx.fireTrigger(orgId, { trigger: 'reacted', data: { emoji: 'tada', who: 'Kim' }, eventId: reactionId })
```

- A trigger's fields narrow which events start a workflow: each one an admin fills in has to equal the event's value under the same key, ignoring case. They can only be `text` or `select`, and a dynamic `select` gets its choices from the trigger's `options`.
- `data` holds those values and what the trigger `provides`, as texts. Other keys are dropped. Later blocks read them as `{{steps.<trigger id>.<key>}}`.
- The same `eventId` starts each workflow once, so send an event again when you are not sure it arrived. `fireTrigger` answers how many workflows started.
- A trigger needs `workflows:blocks` too, and its key cannot be a block's. Company's "Company case closed" works this way: it fires when a case someone started closes, and never for a case a workflow started, so a workflow cannot keep starting itself.

### 7. Tests

`@moxxylabs/factorix-plugin-sdk/testing` runs a plugin without a network:

- `factorixClient(plugin)` calls it the way Factorix does, signatures included: `manifest()`, `openPage(key, context, { form })` to open a page or post a form to it, `tracker(connection)`, `runBlock(key, call)`, and `blockOptions(key, field)`.
- `fakeFactorix({ activity, agents, runs, run, settings, 'workflow-steps', 'workflow-triggers' })` stands in for Factorix's side. Pass its `fetch` to `factorix({ ..., fetch })` and read back the signed `calls` the plugin made.

Put tests next to the code as `src/*.test.ts`, and tests that need the plugin's database as `src/*.int.test.ts`. `yarn test:unit` and `yarn test:integration` pick up `plugins/*` too.

### 8. Running it

- `yarn dev` starts the plugin host with the rest. Put these in `.env` once:

  ```sh
  FACTORIX_PLUGINS_KEY=<openssl rand -base64 32>
  FACTORIX_PLUGINS_INTERNAL_URL=http://localhost:4110
  FACTORIX_PLUGINS_DATABASE_URL=postgres://factorix:factorix@localhost:55432/postgres
  ```

  Pages open at `http://localhost:4101/_plugin/<name>`.
- `yarn start` (and the server) runs the `plugins` and `plugins-db` containers. `install.sh` writes `FACTORIX_PLUGINS_KEY` to `.env`.
- A plugin shows up under Settings, Plugins within a minute of starting. A changed manifest is read again within a minute too.

## Configuring a plugin

Settings live at three levels:

1. **The installation** (`.env`, the people who run Factorix): `FACTORIX_PLUGINS_KEY`, and anything a bundled plugin reads from its environment through `PLUGIN_<NAME>_<KEY>`. In Docker, pass those to the `plugins` service in a `docker-compose.override.yml`.
2. **An organization** (Settings, Plugins, its admins): turn the plugin on, allow what it asks for, and fill in its settings fields. Anything the plugin keeps per organization in its own pages, like the digest's schedule, is set there too.
3. **A connection** (Settings, Connections), for a plugin that provides a tracker: one account of the service behind it.

## On a server

Bundled plugins need no DNS record of their own: their pages come from Factorix's address, which the web passes to the plugin host. `install.sh` writes `FACTORIX_PLUGINS_KEY`, and that is all they need.

## Installing an external plugin

1. Run it behind HTTPS, at an address Factorix's API and your people's browsers both reach. Connection secrets travel to it.
2. An installation admin opens Settings, Plugins, chooses Install plugin, and enters the address (the SDK serves it at `/factorix`) and the secret it was started with.
3. Each organization's admin turns it on. After releasing a version with a changed manifest, press Refresh on its row.

## What a plugin sees

- The settings and connections made for it, and nothing else of an organization, unless it holds a permission.
- Who opened its page, in a token that expires in five minutes. Never Factorix's session cookie.
- With `activity:read`, ticket titles, statuses, names, links, and agent reports. Treat all of it as data: it came from trackers and people.
- With `agents:run`, its own runs only. The agent gets no repository and no secret values, and its prompt is the plugin's.
- With `members:read`, who is in the organization, without email addresses.
- With `tickets:write`, project names and the tickets it created itself, never anyone else's.
- With `workflows:blocks`, what each of its blocks is given when it runs, and nothing else of the workflow.

Bundled plugins share one container. Each gets only its own secret, but nothing stops one process from reading another's memory there, so a plugin nobody here reviewed belongs on its own server, installed by address.

## The protocol

Version 1. JSON over HTTP, signed with the plugin's secret: `x-factorix-timestamp` (milliseconds; more than five minutes off is refused) and `x-factorix-signature`, `sha256=` and the hex HMAC-SHA256 of `<timestamp>.<body>`.

Factorix calls the plugin with `POST <address>` and `{ "protocol": 1, "method": "manifest" | "tracker.<method>" | "workflow.block" | "workflow.options", "params": [], "connection": … }`. The answer is `{ "result": … }` or `{ "error": { "message": … } }`. `workflow.block` gets the call as its one param and answers `{ handle?, output? }` or `{ wait: true, output? }`. `workflow.options` gets `{ block, field, org }` and answers `[{ value, label }]`.

The plugin calls Factorix with `POST <factorix>/webhooks/…`. Every call except events names an `orgId`:

| Path                                              | Body                                                             | Needs                |
| ------------------------------------------------- | ---------------------------------------------------------------- | -------------------- |
| `/webhooks/plugin/<connectionId>`                 | `{ event }`                                                      | a tracker connection |
| `/webhooks/plugins/<pluginId>/settings`           | `{ orgId }`                                                      |                      |
| `/webhooks/plugins/<pluginId>/activity`           | `{ orgId, since }`                                               | `activity:read`      |
| `/webhooks/plugins/<pluginId>/agents`             | `{ orgId }`                                                      | `agents:run`         |
| `/webhooks/plugins/<pluginId>/runs`               | `{ orgId, agentId, prompt, outputSchema? }`                      | `agents:run`         |
| `/webhooks/plugins/<pluginId>/runs/<runId>`       | `{ orgId }`                                                      | `agents:run`         |
| `/webhooks/plugins/<pluginId>/members`            | `{ orgId }`                                                      | `members:read`       |
| `/webhooks/plugins/<pluginId>/projects`           | `{ orgId }`                                                      | `tickets:write`      |
| `/webhooks/plugins/<pluginId>/tickets`            | `{ orgId, projectId, title, description?, priority?, agentId? }` | `tickets:write`      |
| `/webhooks/plugins/<pluginId>/tickets/<ticketId>` | `{ orgId }`                                                      | `tickets:write`      |
| `/webhooks/plugins/<pluginId>/workflow-steps`     | `{ orgId, runId, nodeId, handle?, output?, error? }`             | `workflows:blocks`   |
| `/webhooks/plugins/<pluginId>/workflow-triggers`  | `{ orgId, trigger, data?, eventId? }`                            | `workflows:blocks`   |

Errors: 401 for a bad signature, 403 for a permission the organization did not allow, 404 for an organization that has not turned the plugin on, a run it did not start, a ticket it did not create, or a project or agent the organization does not have, 409 for a disabled agent, too many unfinished runs, or a step that already ended.
