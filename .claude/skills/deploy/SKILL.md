---
name: deploy
description: Deploy Factorix to its server over SSH, back up the database first, verify the rollout, and clean up old backups. Use when asked to deploy, roll out, release to the server, upgrade the server, or check what is deployed.
---

Deploys what is on `origin/main` to the Factorix server. The server pulls from GitHub, so only pushed commits can be deployed.

## Where the server is

This file never names the server. Neither does anything else in the repository.

- The SSH destination is `$FACTORIX_DEPLOY_HOST` when set, otherwise the alias `factorix` from `~/.ssh/config`.
- If neither works, ask the user for the destination. Do not guess, and do not search shell history for it.
- Never write the address, domain, user, or any value from the server's `.env` into this skill, the repository, a commit, a merge request, or memory. In messages to the user, refer to "the server".

Every command below runs as `ssh "$HOST" '<command>'`, with `HOST` set to that destination. Factorix lives in `$FACTORIX_DIR` on the server, or `~/factorix`.

## 1. Check what will ship

Locally:

```sh
git fetch origin
git status --short
git log --oneline origin/main -1
git log --oneline origin/main..HEAD
```

On the server:

```sh
cd ~/factorix && git rev-parse --short HEAD && git status --short && docker compose ps --format '{{.Service}} {{.Status}}'
```

Tell the user which commit is running and which one would replace it (`git log --oneline <running>..origin/main`).

Stop and ask before going on when:

- there are local commits or changes that are not on `origin/main`, since they would not ship,
- the server's checkout has local changes,
- the range adds a migration (`git diff --name-only <running>..origin/main -- packages/db/migrations`). Say so, because a migration may not be undoable in place.

A deploy changes a running system, so get a clear go-ahead for this deploy from the user. An earlier go-ahead does not cover a later one.

## 2. Back up the database

```sh
mkdir -p ~/factorix-backups && chmod 700 ~/factorix-backups
cd ~/factorix && f=~/factorix-backups/compose-backup-before-$(git rev-parse --short HEAD)-$(date -u +%Y%m%dT%H%M%SZ).sql
(umask 077 && docker compose exec -T postgres pg_dump -U factorix factorix > "$f") && ls -l "$f" && grep -c 'PostgreSQL database dump complete' "$f"
```

The dump must be non-empty and the last command must print `1`. Do not look for the marker with `tail`: Postgres 17 writes one more line after it. Do not continue without it. On a first install there is nothing to back up.

## 3. Roll out

```sh
cd ~/factorix && git pull --ff-only && docker compose --profile build-only build && docker compose up -d --wait
```

The build takes minutes. Run it with `nohup` and a log file, then poll the log, so a dropped SSH session does not stop it. Migrations run in the `migrate` service before the API and worker start. Agent runs keep going through a worker restart.

## 4. Verify

```sh
cd ~/factorix && git rev-parse --short HEAD
docker compose ps -a --format '{{.Service}} {{.State}} {{.Status}}'
curl -fsS http://127.0.0.1:4100/healthz
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4101/
docker compose logs --since 10m api worker | grep -iE 'error|unhandled|migration' | tail -n 30
```

The rollout is good when:

- the checkout is at the commit you named in step 1,
- every service is running and healthy, and `migrate` exited with 0,
- `/healthz` answers and the web page returns 200 or a redirect to login,
- the logs show no new errors,
- the public address answers over HTTPS when the server has a domain (read `FACTORIX_PUBLIC_URL` on the server and request it from there, without printing it).

Report what you checked and what each check returned. If you could not check something, say so.

## 5. Clean up backups

Only after step 4 passed: delete the older dumps in `~/factorix-backups` and keep the one taken for this rollout. Tell the user the name of the file that remains. Each dump holds encrypted connection secrets, so spare copies add exposure.

## If it goes wrong

Do not improvise on a broken production system. Collect `docker compose ps -a` and the failing service's logs, tell the user what failed, and propose the way back:

```sh
cd ~/factorix && git checkout <previous commit> && docker compose --profile build-only build && docker compose up -d --wait
```

If a migration already ran, the old code may not work with the new schema. Restoring the dump loses everything written since it was taken, so do it only when the user says so:

```sh
cd ~/factorix && docker compose stop api worker egress-proxy
docker compose exec -T postgres psql -U factorix factorix < ~/factorix-backups/<dump>
docker compose up -d
```

## A new server

A fresh Linux machine needs only SSH access as root or a sudo user. From the server, with DNS for the domain and `*.preview.<domain>` already pointing at it:

```sh
curl -fsSL https://raw.githubusercontent.com/WebEferen/factorix/main/install.sh | bash -s -- --domain <domain>
```

Without a domain it serves on `127.0.0.1:4101` only, reachable through an SSH tunnel: `ssh -L 4101:127.0.0.1:4101 "$HOST"`. Ask the user for the domain. Never take it from this file's history or memory.

## Never

- Print or copy the server's `.env`, `FACTORIX_SECRET_KEY`, or a dump's contents.
- Run `docker compose down -v`, `docker volume rm`, or `docker system prune --volumes`. They delete the database and workspaces.
- Deploy uncommitted work by copying files to the server.
