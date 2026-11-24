# Plugin packages

A plugin package is a zip that an organization's admin uploads under Integrations, Plugins. Factorix runs it for that organization only, in a container of its own, with a Postgres of its own when it asks for one. It is the third way to run a plugin, beside bundled plugins and external ones installed by address ([plugins.md](plugins.md)), and the one the market builds on: whoever wrote a plugin ships one signed file, and nobody has to run a server for it.

A packaged plugin is an ordinary SDK plugin. Everything in [plugins.md](plugins.md) about pages, settings, permissions, blocks, and triggers applies unchanged.

A package can carry content in place of a server: skills, archetypes, and workflows that Factorix imports as data. See [Content packs](#content-packs).

## The format

```
hello-1.0.0.zip
  factorix-plugin.json     what Factorix reads first
  dist/server.mjs          the entry: one bundled JavaScript file
  public/...               anything else it lists under "files"
  README.md                optional
```

`factorix-plugin.json`:

```json
{
  "format": 1,
  "name": "hello",
  "version": "1.0.0",
  "description": "Says hello",
  "publisher": "Acme",
  "entry": "dist/server.mjs",
  "database": true,
  "egress": ["api.example.com", "*.example.org"],
  "permissions": ["members:read"],
  "memoryMb": 256
}
```

- `name` is lowercase letters, digits, and dashes. An organization has one package of each name, and uploading the same name again replaces it.
- `entry` is a `.mjs`, `.cjs`, or `.js` file that Node 22 runs as it is. Nothing is installed where it runs, so bundle every dependency into it.
- `egress` lists the hosts its server may reach. Factorix's own address is always allowed, and everything else is refused.
- `permissions` is the most its server may ask for. A server whose manifest asks for more does not start.
- `memoryMb` is 64 to 1024.

Factorix refuses an archive over 10 MB, over 64 MB unpacked, or over 2000 files, and any entry that is a link, encrypted, zip64, or a path that leaves the archive.

## Building one

```sh
npm install @moxxy/factorix-plugin-sdk
npx esbuild src/main.ts --bundle --platform=node --target=node22 --format=esm --outfile=dist/server.mjs
npx factorix-plugin pack
```

`pack` reads the `factorix` field of `package.json` and writes `<name>-<version>.zip` next to it:

```json
{
  "name": "factorix-plugin-hello",
  "version": "1.0.0",
  "description": "Says hello",
  "factorix": {
    "entry": "dist/server.mjs",
    "database": true,
    "egress": ["api.example.com"],
    "permissions": ["members:read"],
    "files": ["public"]
  }
}
```

The server reads everything it needs from its environment:

```ts
import { definePlugin } from '@moxxy/factorix-plugin-sdk'
import { serve } from '@moxxy/factorix-plugin-sdk/node'

const plugin = definePlugin({
  name: 'hello',
  version: '1.0.0',
  permissions: ['members:read'],
  pages: [
    /* ... */
  ],
})
await serve(plugin, { secret: process.env.PLUGIN_SECRET!, port: Number(process.env.PORT), hostname: process.env.HOST })
```

| Variable        | What it holds                                                 |
| --------------- | ------------------------------------------------------------- |
| `PLUGIN_SECRET` | The secret its calls are signed with. Factorix made it.       |
| `PORT`, `HOST`  | Where to listen: `8080` on `0.0.0.0`.                         |
| `FACTORIX_URL`  | Factorix's public address, for the SDK's `factorix()` client. |
| `DATABASE_URL`  | Its own Postgres, when `database` is true.                    |
| `HTTP_PROXY`    | The egress proxy. Node's `fetch` uses it on its own.          |

## Installing and upgrading

1. An admin opens Integrations, Plugins, chooses Upload package, and picks the zip.
2. Factorix shows what it asks for: permissions, hosts, a database, memory. Nothing of it has run yet.
3. The admin picks where it runs, this Factorix or one of the organization's runners, and installs it. Its data stays on that machine.
4. It shows Starting, and then the admin turns it on like any other plugin.

Uploading a newer version replaces it in place: same machine, same database, same settings. A permission the new version adds waits until an admin saves its settings. Restart starts it again from the stored package. Remove stops it and deletes its container and its database, and cannot be undone.

## How it runs

- The worker writes the package into a volume, starts its server from it read-only as an unprivileged user, and, when it asks, a Postgres beside it. Both sit on a network of their own.
- Its only way out is the egress proxy, with a grant that lists its `egress` hosts and Factorix's address.
- Factorix's only way in is the preview gateway, on a port only the internal network reaches. A runner's packages are reached through the runner's tunnel, never through a port on the runner.
- Its pages load from Factorix's own address under `/_package/<slug>`, with the same sandbox policy as bundled pages: no cookies either way and no origin of their own.
- The worker checks every running package each sweep, starts again one that stopped, and renews its grant.

## Content packs

A content pack runs nothing. Its manifest has `content` where a plugin has `entry`, and no database, egress, permissions, or memory:

```json
{
  "format": 1,
  "name": "security-kit",
  "version": "1.0.0",
  "description": "Security reviews",
  "content": {
    "skills": [{ "key": "review-checklist", "name": "Review checklist", "file": "skills/review-checklist.md" }],
    "archetypes": [
      {
        "key": "security",
        "name": "Security reviewer",
        "role": "reviewer",
        "description": "Reviews for security",
        "prompt": "archetypes/security.md"
      }
    ],
    "workflows": [{ "key": "triage", "file": "workflows/triage.json" }]
  }
}
```

- A skill's key is its slug, and its file is its Markdown.
- An archetype's `role` is `engineer`, `reviewer`, or `other`, and its `prompt` file is its system prompt.
- A workflow's file holds `{ "name", "description", "definition" }`, the graph the workflow editor stores. Its skill fields name skills by slug, and only built-in and integration blocks may appear, since a plugin's block names that plugin's id in one installation.

Put the same `content` block in the `factorix` field of `package.json`, with no `entry`, and `factorix-plugin pack` builds it.

Uploading one shows what it would do to each item before anything changes, and importing it makes every item the organization's own:

- A workflow arrives as a draft that does nothing. Its agent, project, connection, channel, and people fields are left empty for the admin to fill before publishing it.
- A newer version rewrites only what nobody changed since the pack wrote it. It keeps what someone edited, does not bring back what someone deleted, and leaves an item it dropped as it is. A workflow's update changes its draft only, so what runs stays the same until someone publishes.
- If the organization already has a skill with one of its slugs, or an archetype with one of its names, nothing is imported until that is renamed or removed.
- Remove deletes what it imported, except anything changed, published, or used by an agent since.

## The market

Integrations, Market lists packages from registries an installation admin added. Installing one from there is the same as uploading it, except that Factorix downloads it and checks who signed it first.

### Registries

A registry is a folder of static files that any web host can serve:

```
market/
  registry.json         who publishes here, written by whoever runs the registry
  index.json            every package and version, built from the zips
  index.json.sig        the registry's signature over index.json
  acme/hello-1.0.0.zip
  acme/hello-1.0.0.zip.sig   the publisher's signature over the zip
```

An installation admin adds one by its address and the public key that signs its index. Factorix reads the index then and every hour after. It keeps the last index whose signature checked out, and it refuses one older than that, so a host that replays an old index cannot bring back a version the registry withdrew.

### Trust

Every version in a registry is signed by its publisher. Beyond that, the registry vouches for some of them:

| Level              | Meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| Reviewed           | The registry read this version's code.                     |
| Verified publisher | The registry knows who the publisher is.                   |
| Signed             | Only the publisher's signature, which every version needs. |

For each registry, the installation admin picks the least an organization may install: reviewed versions, packages by verified publishers, or any signed package. Settings, General, Let admins upload packages turns off uploading a file, so that organizations install only from registries.

### Installing and updating

An admin picks a package and Factorix downloads that version. It installs it only when the zip has the sha256 the signed index pins, a key the index lists for the publisher signed it, and its `factorix-plugin.json` asks for exactly what the index says. The admin then sees the same summary as for an upload, and Factorix records the registry, the publisher, the trust level, and the key on what it installs.

When the registry lists a newer version of something an organization installed from it, the Market shows Update. The update dialog marks every permission, host, and database the new version asks for that the running one did not. A new permission still waits until an admin saves the plugin's settings.

A package installed from one publisher is never replaced by another publisher's package of the same name, since the new one would get the old one's data and settings. Remove the old one first. Removing a registry leaves what came from it running, without updates.

### Publishing

A publisher makes a key once and signs each zip it packs:

```sh
npx factorix-plugin keygen acme.key          # prints the public key to give the registry
npx factorix-plugin pack
npx factorix-plugin sign hello-1.0.0.zip --key acme.key
```

Whoever runs the registry lists publishers and reviewed versions in `registry.json`, copies in the zips with their `.sig` files, and builds the index with a key of its own:

```json
{
  "name": "Acme market",
  "publishers": [{ "id": "acme", "name": "Acme", "verified": true, "keys": ["ed25519:..."] }],
  "reviewed": ["hello@1.0.0"]
}
```

```sh
npx factorix-plugin registry ./market --key registry.key
```

The build refuses a zip without a `.sig`, or one no listed publisher signed. A package name belongs to one publisher per registry. A zip may also live elsewhere on HTTPS, since the index pins its sha256. To withdraw a version, delete its zip and build again.

## What comes next

New things a plugin can provide, such as a code host and notification channels, land in the manifest and the SDK, and packages get them like every other plugin, as they got tools for agents.
