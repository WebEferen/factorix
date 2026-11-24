# Plugin packages

A plugin package is a zip that an organization's admin uploads under Integrations, Plugins. Factorix runs it for that organization only, in a container of its own, with a Postgres of its own when it asks for one. It is the third way to run a plugin, beside bundled plugins and external ones installed by address ([plugins.md](plugins.md)), and the one a marketplace builds on: whoever wrote a plugin ships one file, and nobody has to host anything.

A packaged plugin is an ordinary SDK plugin. Everything in [plugins.md](plugins.md) about pages, settings, permissions, blocks, and triggers applies unchanged.

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

## Toward a marketplace

What exists now is the format and the runtime a marketplace needs. The next steps, roughly in order:

1. **A registry.** An index of packages with versions, descriptions, and screenshots, which Factorix reads so an admin installs from a list instead of a file. Installing from it is the same upload, fetched by the server.
2. **Signatures and trust levels.** Publishers sign packages, and Factorix records who signed what it runs. An installation admin decides which publishers an organization may install from: reviewed, verified publisher, or anyone.
3. **Updates.** The registry says when a newer version exists, and an admin upgrades with one click after seeing what changed in its permissions and hosts.
4. **More to extend.** New things a plugin can provide (a code host, notification channels, agent tools) land in the manifest and the SDK, and packages get them like every other plugin.
5. **Content packs.** Packages with no server at all: workflows, archetypes, and phase templates that an organization imports as data.
