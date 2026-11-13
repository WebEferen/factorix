# Runbook

## Deploy on a VM

The installer sets up a fresh Linux server in one command, Docker and HTTPS included:

```sh
curl -fsSL https://raw.githubusercontent.com/WebEferen/factorix/main/install.sh | bash -s -- --domain factorix.example.com --email ops@example.com
```

Before running it, point DNS at the server: an A record for `factorix.example.com` and one for `*.preview.factorix.example.com`. `--preview-domain` picks another name for previews. Give the server 8 GB of memory or more and 40 GB of free disk, since agents and previews run beside Factorix.

It writes the domain, the HTTPS URLs, `COOKIE_SECURE=true`, and `COMPOSE_PROFILES=https` to `.env`. That profile starts Caddy on ports 80 and 443 (`docker/caddy/Caddyfile`), in front of web and the preview gateway, which stay on 127.0.0.1. Caddy gets a certificate for each preview's subdomain on its first visit, and only for previews the gateway is running. Let's Encrypt issues 50 new certificates a week per registered domain, counting every subdomain, so put previews on a domain of their own if many start each week. Running the installer again with the same options is safe.

To use your own TLS instead, skip `--domain`, set `FACTORIX_PUBLIC_URL`, `FACTORIX_PREVIEW_URL` and `COOKIE_SECURE=true` in `.env`, and put your proxy in front of port 4101 and the gateway's port 4102. By hand:

```sh
git clone <repo> factorix && cd factorix
cp .env.example .env    # set FACTORIX_SECRET_KEY, FACTORIX_PUBLIC_URL, FACTORIX_PREVIEW_URL, and COOKIE_SECURE=true behind TLS
docker compose --profile build-only build
docker compose up -d
```

Both ports bind to 127.0.0.1 unless `FACTORIX_WEB_BIND` says otherwise.

Previews are served by the gateway on port 4102, one subdomain each. Locally `*.preview.localhost` needs nothing. On a VM, set `FACTORIX_PREVIEW_URL` to something like `https://preview.example.com`, add a wildcard DNS record for `*.preview.example.com`, and put a wildcard certificate in front of port 4102. Pass the `Host` header through and allow WebSocket upgrades, which dev servers use for hot reload. Rebuild `web` afterwards, because its content security policy names the preview address. Keep `.env` safe: losing `FACTORIX_SECRET_KEY` makes stored connection secrets unreadable, and you would need to enter them again.

## Upgrades

```sh
git pull
docker compose --profile build-only build
docker compose up -d
```

Migrations run through the `migrate` service before the API and worker start. Running agents keep working through a worker restart. Take a backup first, because some migrations cannot be undone in place.

To rebuild only what changed, use `docker compose build migrate web`, and `yarn sandbox:build` when `packages/runner` or `docker/sandbox*` changed. The `api`, `worker`, and `egress-proxy` services share the image built under `migrate`, so `docker compose build api` does nothing.

## Backups

```sh
docker compose exec -T postgres pg_dump -U factorix factorix > factorix.sql
```

Keep `FACTORIX_SECRET_KEY` with the backup, in a separate safe place: the dump holds connection secrets encrypted with it. Redis holds queues and short-lived grants, and the outbox and recovery rebuild what matters.

To restore into an empty database, stop the API and worker first:

```sh
docker compose stop api worker egress-proxy
docker compose exec -T postgres psql -U factorix factorix < factorix.sql
docker compose up -d
```

## Disk

Each issue gets its own clone and mirror of every repository in its project. Package caches go when a run ends. The worker then removes a workspace at its next cleanup, every 15 minutes, once it passes its limit: straight away after an issue is done or cancelled, 7 days after it fails, and 30 days after the last run while it is open. Change these under Settings, General.

A workspace with a run still going is never removed. A later run on that issue clones again and starts a new agent session, so size the disk for the open issues at once, times the size of the project's repositories. Check with `docker system df`. `docker builder prune -af` clears the build cache.

## Something looks stuck

| Symptom                            | Where to look                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A run sits in Queued               | `docker compose logs worker`. Check the Docker socket and Agents running at once under Settings, General.           |
| A run fails while preparing        | The run's logs, with Show logs on. A clone error usually means the GitLab token.                                    |
| A merge stopped partway            | The issue names what merged and what stopped it. Retry the rest, revert what merged, or keep it.                    |
| A revert did not land              | The issue names what is left. Fix it in GitLab and try again, or leave it and undo it by hand.                      |
| Cannot remove a repository         | It has an open merge request. Merge or close that first.                                                            |
| The model fails with 401           | The agent's or organization's model key. In the proxy logs, `No API key` means none is set.                         |
| An agent cannot reach a host       | The run log names the denied host. Add it under the project's network settings.                                     |
| Issues do not update               | Check webhook deliveries in Linear or GitLab, or press sync on the project.                                         |
| A setting seems to have no effect  | Settings, General shows the value in force and its environment default. The worker reads changes within 15 seconds. |
| The tracker state stopped changing | Look for `sync.conflict` in the audit log. Someone moved the issue by hand.                                         |
| A preview will not start           | Logs on the issue's Preview panel. [docs/environments.md](environments.md) lists the usual causes.                  |

## Inspect a run from the host

```sh
docker ps --filter label=factorix.kind=agent
docker logs <container>
docker volume ls --filter name=fx-
```

Failed containers stay for an hour, and cleanup runs every 15 minutes. Settings, General sets how long containers and workspaces stay.

Previews and the services of agent runs use `label=factorix.kind=env`, and `label=factorix.env=<id>` picks one. The worker finds the gateway and the egress proxy by their `factorix.role` label, and cleanup removes only objects labelled with its own stack. Both use `FACTORIX_STACK`, so two stacks on one Docker host need different stack names.

## Runners

A runner takes a project's sandboxes off the main machine. Add it under Settings, Runners, then on the other machine, from a checkout:

```sh
docker compose -f docker-compose.runner.yml --profile build-only build
FACTORIX_URL=https://factorix.example.com FACTORIX_RUNNER_TOKEN=fxr_... FACTORIX_STORE_SECRET=$(openssl rand -hex 24) \
  docker compose -f docker-compose.runner.yml up -d --build
```

Put the three values in a `.env` beside the file to keep them across restarts. `FACTORIX_STORE_SECRET` is local to the runner: it lets its egress proxy, and nothing else, ask what a run token allows.

- The runner needs to reach `FACTORIX_URL` over HTTPS. Nothing connects to it.
- Its proxy must answer at the address in `FACTORIX_PROXY_URL` on the main machine, which is `http://egress-proxy:8080` in both compose files.
- It uses the same sandbox image name as the main machine. Rebuild it on both after changing `packages/runner` or `docker/sandbox*`.
- Upgrade runners together with Factorix. An older runner refuses calls it does not know with a message that says to update it.
- One process per token. A second one takes the connection over and the first reconnects, so they would fight.
- Previews of its projects run there and open through the gateway on the main machine. A runner started before previews were supported needs `up -d --build` again, which adds its `preview-tunnel` service. Without that service a preview starts and its log says nobody can open it.
- `docker compose -f docker-compose.runner.yml logs runner` shows whether it is connected. Settings, Runners shows the same from the other side.
- Removing a runner sends its projects back to the main machine. Working copies it held are lost, and pushed work is not.

## Rotate secrets

Tokens: edit the connection under Settings. New runs use the new value.

Webhook secrets live on the connection. If one leaks, recreate the connection and register webhooks again.

## Prove the safety properties

```sh
yarn sandbox:build
yarn test:docker
```

These cover the credential boundary, worker crash recovery, cancel, egress denial, and previews end to end on real containers.
