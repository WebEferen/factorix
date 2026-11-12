# Architecture

```
 Linear <-- webhooks, GraphQL --> +-----------+ <-- webhooks, REST --> GitLab
                                  | apps/api  |
 Browser --> apps/web (rewrites)->| + worker  |
                                  +-----+-----+
                  Postgres (state, events, audit, outbox)   Redis (queues, pub/sub, proxy grants)
                                        |
                                  docker socket
          +-----------------------------+------------------------------+
          | step containers             | agent container              |
          | mirror-fetch, push: token   | runner + Claude or Codex SDK |
          | checkout, bundle, diff,     | stdout: RunEvent JSONL       |
          | docs: no token              | stdin: RunSpec, RunCommand   |
          +-----------------------------+--------------+---------------+
                                                       |
                                                 egress proxy --> model APIs, registries
```

## Why the SDK runs in the container

Both SDKs spawn their own CLI and run tools in that process tree, so tool execution cannot be redirected from outside. A thin runner hosts the SDK in the sandbox. The worker attaches to its stdio and needs no network path to it. The runner journals events to the workspace volume, so a restarted worker reattaches and replays what it missed.

## The credential boundary

The agent can write anything in its workspace, including `.git/config` and hooks. Running git there with a token would hand the token to the agent, so token steps never touch it:

- `mirror-fetch` holds the token and writes only to a separate mirror volume.
- `checkout` has no token and copies from the mirror into the workspace.
- `bundle` has no token and no network. It turns the agent's commits into a git bundle.
- `push` holds the token, mounts the workspace read-only, and imports the bundle into the mirror without running git in the workspace.

`STEP_PROFILES` in `packages/sandbox/src/profiles.ts` states this as data, and a Docker test plants a `core.fsmonitor` attack to prove it holds.

Model keys stay out of agent containers too. Each run gets a token in Redis. The egress proxy swaps it for the real key and enforces the project's allowlist. Denials appear in the run log. An agent reaches its HTTP MCP servers at the proxy's `/mcp/<name>`, which puts the connection's headers on the request, so those stay out as well. A stdio MCP server runs inside the container, so it starts without the values stored on its connection, and Environment secret connections never reach an agent. Without the proxy, Claude and Codex runs are refused, and only scripted runs work.

The allowlist is package registries, the hosts each of the project's connectors declares, and the project's own additions. Settings, Network can extend those defaults for the whole organization or replace them with its own list. GitLab is on it so installs can fetch packages from public projects. Agents hold no token, so private code and pushes stay out of reach, but an agent could still send data to an account whose token it was given. The same is true of `npm publish` on the registries.

An exact entry may name an internal host, such as a private registry. The proxy still refuses Factorix's own services (Postgres, Redis, the API, the worker, the preview gateway), any other address on a network it shares with them, and link-local and unspecified addresses, whatever the list says. A project's "Skip the proxy for" list goes into `NO_PROXY` for its runs, run services, and previews. It is for names that only exist inside the run, like a host a test suite fakes, and grants nothing, because the agent's network has no other way out.

## Several repositories

The repositories on a project are a limit on what agents may change, and a ticket usually needs only some of them. The limit is enforced outside the agent: it holds no git credentials, its network cannot reach GitLab, and the factory only pushes the repositories on the project, so a new folder or a changed remote goes nowhere. Each repository keeps its row and folder name across edits, so workspaces and threads stay attached.

- The workspace and mirror volumes are per issue and hold one folder per repository: `/workspace/repos/<name>` and `/mirror/<name>.git`. Every step runs against one repository, chosen by `FX_REPO_NAME`. The script validates that name before using it as a path, because token-holding steps use it too.
- With one repository the agent starts inside it, as a project always did. With several it starts in `/workspace/repos`, and the prompt lists each folder with its base branch and test command.
- All repositories use the same branch name for an issue. A repository only gets a merge request if the agent committed there.
- Setup commands run at checkout when a project has one repository. With several, the agent runs them in the repositories it works in, so a ticket does not wait on installs it never needed.
- Checks are instructions to the agent, listed per repository. The factory does not run them itself, so CI stays the gate for merging.
- The agent reports `mergeOrder` for the ticket, because only the ticket says which change the others depend on. Names that match no merge request are ignored, and anything unnamed follows, in the order the repositories were picked.
- Every push runs before any merge request opens, so a failed push never leaves half a change up for review, and a retry opens only what is missing. When an issue has more than one, each gets a note listing the others and the merge order, repeated if the order changes.
- Review gives one verdict for the whole change. Each comment names the repository it belongs to, and falls back to a note when the line cannot take an inline comment.
- CI and mergeability are checked on every open merge request before anything merges, then they merge in the ticket's order. A true atomic merge across repositories does not exist, so a refused merge stops there and asks a person: retry the rest, revert what merged, or keep it. Reverting closes what is still open, reverts newest first through a new merge request per repository, and asks again if one cannot land.
- An issue finishes when no merge request is left open. It counts as merged if any merged, and as cancelled only if all closed.

## Pipelines

`advance(definition, cursor, context, event)` in `packages/core` is a pure function that returns the next cursor and a list of actions. The API applies those actions in the same transaction that takes the issue's row lock. A step asks for a role, not a named agent: the assigned agent if its archetype works as that role, then the project default, then the oldest active agent with that role. Agents whose archetype works as `other` start at their own `task` step through `entryByRole`: one run with read-only repositories, whose report goes on the ticket as a comment, with no branch, merge request, or tracker status change. Nobody stands in for them. Adding a role means adding a step and a phase template.

The built-in pipeline is plan (under `plan_first`), approve, implement, review, address, then merge by a person or, under `full_auto`, by the factory.

## Workflows

Admins build workflows on a canvas from a catalog of blocks in `packages/schemas`. Edits save to a draft. Publishing validates the draft and copies it, and each run stores the definition it started with, so editing never changes what is already running. Anyone can run a published workflow on tickets by hand. Starting by itself from a ticket event also needs the workflow to be on.

`planWorkflow` in `packages/core` is pure: given the graph and the step states it returns what is ready, what to skip, and the outcome. A block waits until all its incoming connections are settled and runs if at least one was taken, so parallel branches join once and an untaken branch skips what is only reachable through it. A failed block ends the run unless its Failed output is connected.

Steps run from a queue. A step is claimed by moving it from `queued` to `running`, and a step found stuck in `running` is failed and not retried, because it may already have posted. A connector that asks to slow down raises `RetryLaterError`, which puts the step back on the queue without counting as a failure. Timers live in `workflow_steps.wake_at`, and a sweep every 15 seconds resumes them, so a wait survives restarts. The sweep also catches agent results and queue jobs that went missing.

These guard against runaway flows:

- Connections cannot form a loop, and validation rejects one at publish.
- Status changes, labels, and tickets made by a workflow leave echo markers and start nothing. Project imports start nothing either.
- A workflow runs once at a time per ticket, and at most 100 automatic runs per hour, or 10 per ticket per hour. Going over writes `workflow.throttled` to the audit log.
- A ticket created by a workflow carries a depth, and creation stops after 3 generations.

Notifications go through `NotificationConnector`, with Slack as the first implementation. Values from a ticket are escaped before they are placed in a message, so ticket text cannot add links or ping a channel. Only links written in the template stay links.

## Whose account does the work

Agents use the project's connections unless they have their own, linked in `agent_connections` under the roles `scm` and `tracker`. Commits, pushes, merge requests, reviews, and comments follow the agent's account, resolved per run. Merges, webhooks, polling, and status changes stay on the project's account, so a project keeps working if an agent is removed. A repository id only means something on one server, so a git account on another server is ignored with a warning. Tokens stay in step containers either way.

## Settings

The environment sets the defaults and `platform_settings` overrides them, one row per setting, read through `readSettings`. Nothing is cached, so a change reaches the API on the next request, and the worker checks every 15 seconds. A stored value that no longer validates falls back to the environment.

## Disk

Each run ends with a `clear-cache` step, which has no token, mirror, or network. Every 15 minutes the worker removes workspaces past their limit, along with their stopped containers, and clears the session references stored on them. A workspace with a live run is never removed, and one left marked in use after its last run ended is freed. If a volume cannot be removed, the row stays as it was and the next pass retries.

## Keeping Linear and Factorix honest

When a run starts, the worker reads the documents and links attached to the issue (Resources in Linear) with the same tracker account the agent comments with, and puts them in the prompt as untrusted text. Each document is capped at 20,000 characters and all of them at 60,000. If the tracker fails, the run goes on without them and the log says so.

Files, such as uploads attached to the issue or pasted into its description, are read the same way and copied into the container at `/workspace/.factorix/issue-files`, outside the repositories: at most 20 files, 10 MB each and 25 MB in all. The description points at the copies, and the agent never gets the tracker's URL or credentials. A source declares files through `listResources` and uploads through its markup's `isMediaUrl`, and `fetchMedia` reads both.

Before the prompt and any text file reach the agent, the worker masks every connection token in the organization, the values of the project's secret sets whose names say they are secret, and known token formats such as `glpat-` or `lin_api_`. Images, PDFs, and other binary files go as they are.

Every outbound write records an echo marker, because a personal API key makes the factory's writes look like yours. Factory comments also carry a visible prefix and footer. Linear owns title, description, priority, labels, assignee, and state. Factorix writes state only through the project's state map, and only if the current state is the one it last set. Otherwise it logs `sync.conflict` and leaves it alone.

Webhooks are verified, deduplicated, and queued. A polling sweep covers anything they miss.

## Runs and crashes

A run holds a lease extended by a heartbeat. If a worker dies, the lease expires and recovery re-enqueues the run. The next worker reattaches to the live container, or reads its logs if it already finished, and continues from the last persisted sequence number. Events are inserted with a unique `(run_id, seq)`, so replays cannot duplicate them.

Domain events go through a transactional outbox, so a queue never disagrees with Postgres.

## Runtime differences

Claude and Codex differ, and `RuntimeCapabilities` records how. Codex has no per-tool approval, so rules that need it are refused when the agent is saved and the form hides the field. Codex reports tokens, so its cost shows as estimated. Mid-run messages queue for the next turn on runtimes that cannot take them live.
