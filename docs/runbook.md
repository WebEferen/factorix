# Runbook

## Deploy on a VM

```sh
git clone <repo> factorix && cd factorix
cp .env.example .env    # set FACTORIX_SECRET_KEY and FACTORIX_PUBLIC_URL, and COOKIE_SECURE=true behind TLS
# or skip the steps below and run ./install.sh, which also installs Docker
docker compose --profile build-only build
docker compose up -d
```

Put TLS in front of port 4101. It binds to 127.0.0.1 unless `FACTORIX_WEB_BIND` says otherwise. Keep `.env` safe: losing `FACTORIX_SECRET_KEY` makes stored connection secrets unreadable, and you would need to enter them again.

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

## Inspect a run from the host

```sh
docker ps --filter label=factorix.kind=agent
docker logs <container>
docker volume ls --filter name=fx-
```

Failed containers stay for an hour, and cleanup runs every 15 minutes. Settings, General sets how long containers and workspaces stay.

## Rotate secrets

Tokens: edit the connection under Settings. New runs use the new value.

Webhook secrets live on the connection. If one leaks, recreate the connection and register webhooks again.

## Prove the safety properties

```sh
yarn sandbox:build
yarn test:docker
```

These cover the credential boundary, worker crash recovery, cancel, and egress denial on real containers.
