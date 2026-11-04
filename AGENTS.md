# Factorix

Agentic software factory. It mirrors Linear issues, runs agents in Docker sandboxes, and opens GitLab merge requests.

## Layout

- `apps/api`: Fastify API (`src/server.ts`) and BullMQ worker (`src/worker.ts`). Both share `src/services`.
- `apps/web`: Next.js App Router UI. Calls the API through rewrites, so everything is same-origin.
- `apps/egress-proxy`: the only network path out of an agent container. Swaps run tokens for real model keys.
- `packages/core`: pure domain with no IO. State machines, the pipeline engine, phase templates, prompts.
- `packages/runtime`: the contract between worker and runner. `RunSpec`, `RunEvent`, `RunCommand`.
- `packages/runner`: runs inside the sandbox and hosts the SDKs. The only package that depends on them.
- `packages/sandbox`: `SandboxProvider` and the Docker implementation. `profiles.ts` is the credential boundary.
- `packages/connectors`: `TrackerConnector` (Linear) and `ScmConnector` (GitLab).
- `packages/db`: Knex client, raw SQL migrations, row types.
- `packages/schemas`: zod inputs and DTO types shared by API and web.

## Commands

Use Node 22 (`.nvmrc`) and Yarn 1. Docker must be running for integration and Docker tests.

```sh
yarn dev               # Postgres, Redis, API, worker, web
yarn lint
yarn typecheck
yarn test:unit
yarn test:integration  # real Postgres and Redis
yarn sandbox:build     # after changing packages/runner or docker/sandbox*
yarn test:docker       # real containers, real git, needs the sandbox image
yarn prepare-mr
docker compose build migrate web   # rebuild the running stack: api, worker, and the proxy share the image built by migrate
```

## Rules that keep it safe

- The repositories in `project_repos` are the limit of what agents may change, each checked out at `/workspace/repos/<name>`. An issue has one row in `issue_merge_requests` per repository it changed, and everything that touches a merge request reads `mergeRequestsOf`, which keeps the merge order the agent chose for that ticket. `iid` is only unique inside one repository, so never look one up without the repository.
- The git token never enters a container that runs agent or repo code. Change `STEP_PROFILES` in `packages/sandbox/src/profiles.ts` only with a matching test in `docker.docker.test.ts`.
- The API and worker never import an SDK. Only `packages/runner` does.
- Tracker and agent text is untrusted. Render it through the `Markdown` component, never as HTML. The API converts each source's dialect to portable Markdown first, and only images and videos from the media proxy load inline.
- `audit_log` is append-only, enforced by a database trigger. Write through `writeAudit`.
- Publish domain events with `emit` inside the same transaction as the state change. The relay moves them to queues.
- Query rows come back camelCase, and identifiers are snake-cased for you. Wrap JSONB writes in `json()`.
- Update bodies go through `updateOf` in `packages/schemas`. Zod's `.partial()` still applies defaults, which would wipe fields.
- Anything a workflow changes in the tracker records an echo marker first, so it cannot start another workflow. Runs execute a stored copy of the published definition, never the draft.

## Extending

- New archetype: create it on the Archetypes page. It needs no code, and its "Works as" role decides which pipeline steps its agents can take. `Other` agents stay out of the pipeline: assigned a ticket, they run once with read-only repositories and post a report on it.
- New pipeline role or phase: add a template in `packages/core/src/phases`, a step in the pipeline definition, and the role to `ARCHETYPE_ROLES` in `packages/schemas`. The engine does not change.
- New SCM or tracker: implement the connector interface and its webhook codec, then register it in `apps/api/src/deps.ts`. Add its markup, reference links, issue filters, issue sorts, and egress hosts to `TRACKER_SOURCES` or `SCM_SOURCES` in `packages/connectors`. The filter toolbar renders whatever the source declares.
- New model runtime: add an adapter in `packages/runner/src/adapters`, with a capability entry in `packages/runtime`. The UI adapts from capabilities.
- New workflow block: add it to `WORKFLOW_BLOCKS` in `packages/schemas/src/workflows.ts`, a handler to `BLOCK_HANDLERS` in `apps/api/src/services/workflow-blocks.ts`, and an icon and summary in `apps/web/modules/workflows/blocks.tsx`. The palette and inspector render from the catalog.
- New default egress host: a connector declares `egressHosts` on its source, and hosts every restricted project needs go in `PACKAGE_REGISTRY_HOSTS` in `packages/schemas`. Settings, Network extends or replaces the defaults for the organization, and a project adds its own under Extra allowed hosts. All of it goes through `egressGroups`, so the UI lists what the worker enforces. Declare only what an agent can use without the connection's credentials, since every host is also somewhere it could send data.
- New notification channel: implement `NotificationConnector` in `packages/connectors`, register it in `realConnectors.notifier`, and add its kind to `NOTIFICATION_KINDS` and `CONNECTION_KINDS`, plus its entry on the connections page. The Send notification block offers every connection of those kinds.

## Conventions

Strict TypeScript, ESM, no build step for internal packages. Biome: 2 spaces, single quotes, no semicolons, 150 columns. Tests sit next to code: `*.test.ts`, `*.int.test.ts`, `*.docker.test.ts`. Branches are `<team>-<n>-<slug>`, merges are squashed. UI follows the tokens in `apps/web/app/globals.css` and the primitives in `apps/web/modules/ui`.
