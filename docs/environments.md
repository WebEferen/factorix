# Environments and previews

A project can describe how to run its code: which containers it needs, how to install and start them, and which secrets they read. Factorix uses that description to start a **preview** of any issue, so a reviewer opens the running change in the browser instead of checking out the branch.

Admins edit it under the project's Environment page. Start from example fills in a commented definition to adapt.

## The definition

The definition is YAML. Unknown keys are refused, so a typo shows up as an error on its line instead of being ignored.

```yaml
services:
  db:
    image: postgres:17
    env:
      POSTGRES_PASSWORD: local
    files:
      - { repo: app, path: database/init, to: /docker-entrypoint-initdb.d }
    data: /var/lib/postgresql/data
    ready:
      command: pg_isready -U postgres

  api:
    repo: app
    workdir: backend
    install: yarn install --frozen-lockfile
    setup: [yarn db:migrate, yarn db:seed]
    start: yarn dev --host 0.0.0.0
    port: 3000
    secrets: [backend]
    env:
      DATABASE_URL: postgres://postgres:local@${services.db.host}:5432/app
      APP_ORIGIN: ${preview.url}
    ready:
      http: /health
    dependsOn: [db]
    resources: { memoryMb: 3072, cpus: 2 }

expose:
  service: api
  paths:
    - { prefix: /admin, service: admin, strip: true }

notes: Sign in as the user the seed creates.
```

Each service is one container.

| Key         | Meaning                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `image`     | Runs that image as it is, with its own user and entrypoint.                                                                                                                                                                    |
| `repo`      | Runs one of the project's repositories on the sandbox image, as an unprivileged user. Give `image` too to use another image for it.                                                                                            |
| `workdir`   | Where inside the repository the commands run.                                                                                                                                                                                  |
| `install`   | Runs on every start and refresh. Installed files such as `node_modules` stay between refreshes.                                                                                                                                |
| `setup`     | Runs once per data generation, the first time a preview starts and again after Reset data. Use it for migrations and seeds.                                                                                                    |
| `start`     | The long-running command. Servers must listen on `0.0.0.0`, because other containers and the gateway reach them by name.                                                                                                       |
| `port`      | The port it serves on. The exposed service needs one.                                                                                                                                                                          |
| `ready`     | `command` runs inside the container, or `http` asks a path on `port`. Any answer below 500 counts. Without it, staying up for two seconds counts. `timeoutSeconds` defaults to 900 for repository services and 180 for images. |
| `env`       | Variables. They override values from secret sets.                                                                                                                                                                              |
| `secrets`   | Names of secret sets to load.                                                                                                                                                                                                  |
| `files`     | Read-only mounts of a path in a repository, such as init scripts.                                                                                                                                                              |
| `data`      | A path whose contents survive refreshes and stops. Reset data clears it.                                                                                                                                                       |
| `dependsOn` | Services that must be ready first. Cycles are refused.                                                                                                                                                                         |
| `resources` | Memory and CPU limits, capped by the project's limits.                                                                                                                                                                         |

`expose` names the service a preview opens. Each entry in `paths` sends a path prefix to another service, longest prefix first, and `strip` removes the prefix before forwarding. One origin serves the whole app, so the browser makes no cross-origin calls.

`agents` names the services and variables agent runs get. See [Agent runs](#agent-runs).

### Templates

Values can refer to:

- `${services.<name>.host}` and `${services.<name>.port}`
- `${preview.url}` and `${preview.host}`, the preview's public address
- `${repos.<name>.path}`, where a repository is checked out

Write `$${...}` for a literal `${...}`.

## Secret sets

Secret sets sit next to the YAML because they point at connections. Each set has a name, a connection, and for Doppler a project and config. `only` keeps the listed keys, and `except` drops keys.

Two sources ship:

- **Doppler**: a service token reads one config. A service account token lets you pick a project and config from lists.
- **Environment secret**: key and value pairs stored encrypted in Factorix.

The worker fetches values when a preview starts and keeps them only in memory. The source's token never enters a container, values never appear in API responses or the audit log, and known values are masked in preview logs. Test on the Environment page shows key names and counts, never values.

A service's variables are layered: secret sets first, then its own `env`, then what Factorix sets for the network. That lets a definition point `DATABASE_URL` at the preview's own database while every other value comes from the vault.

A new source implements `SecretSourceConnector` in `packages/connectors/src/secrets.ts` and adds an entry to `SECRET_SOURCES`.

## Sharing a definition

Export on the Environment page downloads the saved version as a YAML file (`factorix/environment@1`). It holds the definition with its comments and each secret set's name, source kind, connection name, Doppler project and config, and key filters. It never holds values, tokens, or connection IDs, so it is safe to hand to a teammate or another Factorix. Any member can export.

Import, for admins, reads such a file and asks which local connection each secret set uses. It preselects a connection of the same kind and name, or the only connection of that kind, and a set you leave out is dropped. Import only fills the editor: Test it and save. The definition's `repo` names must match this project's repositories, which Test and Save check.

## Previews

Any member can start, open, refresh, and stop a preview from the issue page. Agents can too, through [their tools](#previews-from-agents).

- **Start** copies the issue's branch, or the default branch for repositories the issue did not change, and starts the services in dependency order.
- **Open** shows the app inside Factorix, or in a new tab.
- **Refresh** copies the latest commits and restarts the repository services. Images and data keep running. A ready preview refreshes by itself when an agent pushes.
- **Reset data** removes the data volumes and runs `setup` again.
- **Stop** removes every container and the network. Code and data volumes stay until the issue's workspace is cleaned up, so the next start is faster.

A preview runs what is pushed, never an agent's unpushed work. It keeps the definition it started with. If the definition changes, the panel says so, and stopping and starting picks up the new one.

Settings, General limits how many previews run at once, stops a preview nobody opened for a while, and stops any preview after a maximum age. The panel shows when it will stop by itself.

### What runs

Each preview gets its own Docker network, a volume with the code at `/workspace/repos/<name>`, and a volume per `data` path. Names and labels start with `fx-env` and carry `factorix.env=<id>`.

Code arrives in two steps. `mirror-fetch` holds the git token and updates the issue's mirror. `export` has no token and no network, and copies from the mirror into the preview's volume. The token never reaches a container that runs repository code.

When the egress proxy runs, the preview network is internal. Requests out go through the proxy with the project's network allowlist and no model keys, and blocked requests appear in the preview's log. Factorix sets `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and `NODE_USE_ENV_PROXY=1`, so most tools and Node's `fetch` use it without changes.

### Addresses

Each preview has its own host, `http://<id>.preview.localhost:4102` by default. Browsers and macOS send `*.localhost` to the local machine without DNS. On a server, set `FACTORIX_PREVIEW_URL` to a base such as `https://preview.example.com`, point a wildcard DNS record at the host, and give the gateway a wildcard certificate.

The preview gateway on port 4102 is the only way in. Opening a preview hands the browser a one-time ticket, which the gateway swaps for a cookie that works only on that preview's host. Factorix's own session cookie never reaches a preview, and preview code cannot read another preview's cookie. The gateway lets Factorix show the app in a frame and drops its own cookie before forwarding requests.

## Agent runs

`agents` gives each agent run what it needs to install, test, and run the code:

```yaml
agents:
  services: [db, cache]
  env:
    DATABASE_URL: postgres://postgres:local@${services.db.host}:5432/app
```

- `services` lists services that come from an image. Each run starts its own copies on a network of their own, and the agent's container joins it, so `db` resolves from the agent. They start empty, and `files` mounts come from the run's own checkout. Repository services are refused, since the agent runs that code itself.
- `env` sets variables for the agent. `${preview.url}` is refused, since a run has no preview.

Agent runs never get secret values, and neither do the services they start, because the agent can reach them. A service that names secret sets starts without them in a run, and the run log says so. Saving refuses a definition that still lists `agents.secrets`.

The agent's variables are `agents.env`, then what Factorix sets for the run. Service names go in `NO_PROXY`, so the agent reaches them directly while everything else still goes through the egress proxy. So do the hosts in the project's "Skip the proxy for" list, for previews and run services too.

The services and their data go when the run ends or pauses for a decision, and a resumed run starts fresh copies. If they fail to start, the run goes on without the services or the values, its log says why, and the agent is told.

The sandbox image has a stand-in `doppler` command, because a repository service already has its values in the environment. `doppler run [flags] -- <command>` runs the command, and anything else exits with a message saying so. In an agent run it finds no values. Options such as `--mount` are not supported, and services with their own `image:` do not have the command.

### Previews from agents

When the environment has `expose`, Claude and Codex runs on an issue get four tools from a `factorix` MCP server: `preview_start`, `preview_status`, `preview_logs`, and `preview_stop`. The agent can then check its change running before it finishes.

- `preview_start` runs the agent's working copy by default, including uncommitted files and untracked ones that are not ignored. With `source: branch` it runs what is pushed. It uses the issue's one preview, so it refreshes a running one, and it counts toward the limit on running previews.
- The copy reads the agent's workspace read-only and commits its files with a throwaway index inside the preview's own volume. The agent's files, index, and branch never change.
- Once the preview is ready, the agent's container joins its network and reaches each service at `<name>.preview.internal:<port>`. Its `NO_PROXY` leaves that domain out, so requests go straight to the preview.
- People open it from the issue page as usual. The panel says it runs an unpushed working copy, and Refresh or a push switches it back to the pushed branch.
- A preview an agent starts runs without secret values. One that a person started with them stays out of the agent's reach: the agent sees its state, but no addresses, logs, or errors, and `preview_start` asks it to stop that preview first. Refresh keeps whatever the last start had.

The tools act as the agent, on its own issue only, and the audit log records them under its name. A preview an agent started stops by itself like any other.

## When something goes wrong

| Symptom                                                    | What to check                                                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A service failed before it was ready                       | Its log, under Logs on the panel. An exit code means the command failed, a timeout means `ready` never passed.   |
| The app works in the container but not through the preview | The server listens on `localhost`. Make it listen on `0.0.0.0`.                                                  |
| Requests to an API fail                                    | The log names blocked hosts. Add them under the project's network settings.                                      |
| "The egress proxy is not running"                          | The worker could not find the proxy container. Unset `FACTORIX_PROXY_URL` only for local development without it. |
| "Open this preview from Factorix"                          | The gateway has no cookie for that host. Use Open on the issue page.                                             |
| A preview stopped by itself                                | The panel and audit log say why: nobody opened it, or it reached its maximum age.                                |
| An agent cannot reach a service                            | The run log says whether the run's services started, and if not, why.                                            |
