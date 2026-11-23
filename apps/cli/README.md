<p align="center">
  <img src="https://raw.githubusercontent.com/WebEferen/factorix/main/apps/web/public/icon-192.png" width="80" height="80" alt="Factorix logo">
</p>

<h1 align="center">fx</h1>

<p align="center">
  The command line and MCP server for <a href="https://github.com/WebEferen/factorix">Factorix</a>, the agentic software factory.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@moxxy/factorix"><img src="https://img.shields.io/npm/v/%40moxxy%2Ffactorix?label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@moxxy/factorix"><img src="https://img.shields.io/node/v/%40moxxy%2Ffactorix" alt="Node.js version"></a>
  <a href="https://github.com/WebEferen/factorix/blob/main/apps/cli/LICENSE"><img src="https://img.shields.io/npm/l/%40moxxy%2Ffactorix" alt="MIT license"></a>
</p>

`fx` lets you work with Factorix agents without leaving the terminal. Hand a ticket to an agent, give it a one-off task on your checkout, follow its run live, answer what waits for you, and pull its changes back into your working tree. Your local coding agent gets the same operations over MCP.

```sh
fx assign ENG-42 engineer-1     # an agent takes the ticket: plan, code, review, merge request
fx logs ENG-42 -f               # watch it work
fx inbox                        # see what needs your decision
fx approve ENG-42 -m "Ship it"
```

## Contents

- [Install](#install)
- [Get started](#get-started)
- [Everyday use](#everyday-use)
- [Command reference](#command-reference)
- [Handing off your checkout](#handing-off-your-checkout)
- [Use it from a coding agent (MCP)](#use-it-from-a-coding-agent-mcp)
- [Configuration](#configuration)
- [Tokens and permissions](#tokens-and-permissions)

## Install

```sh
npm install -g @moxxy/factorix
```

You need Node.js 22 or newer. The package is a single file with no dependencies, so it installs in a second. To try it without installing, use `npx @moxxy/factorix help`.

## Get started

1. In Factorix, open **Settings → API tokens** and create a token. Pick what it may change (see [Tokens and permissions](#tokens-and-permissions)).
2. Log in with your Factorix address and the token:

   ```sh
   fx login --url https://factorix.example.com --token fxp_...
   ```

3. Check that it worked:

   ```sh
   fx whoami
   ```

That's it. `fx help` lists every command.

## Everyday use

**Put an agent on a ticket.** The agent runs the project's pipeline: it plans, implements, gets reviewed, and opens merge requests.

```sh
fx issues checkout                 # find the ticket
fx assign ENG-42 engineer-1        # hand it over
fx tell ENG-42 "Keep the old endpoint working"   # an instruction for the agent's next run
fx logs ENG-42 -f                  # follow the current run until it ends
```

**Ask for something with no ticket.** The agent works from what is pushed to this checkout's origin, cloned through your organization's GitLab or GitHub connection for that host. It pushes nothing back, so you read the result as a diff.

```sh
fx run "Why is the billing test flaky?" -f
fx diff 0a1b2c3d
```

**Hand off what you are in the middle of.** Your unpushed commits and uncommitted changes go to the agent, and `fx pull` brings its work back.

```sh
fx handoff "Finish the retry logic and add tests" -f
fx pull 0a1b2c3d
```

**Decide what waits for you.** Plans, questions, tool approvals, and merges show up in your inbox.

```sh
fx inbox
fx approve ENG-42 -m "Go ahead"
fx reject ENG-42 -m "Split the migration into its own merge request"
```

**Try the change.** Start the ticket's preview if it is not running yet and open it in your browser.

```sh
fx preview ENG-42
```

Wherever a command takes `<run|issue>`, you can pass a ticket identifier like `ENG-42`, which means its current run, or the first characters of a run id.

## Command reference

### Account

| Command                                    | What it does                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `fx login --url <address> --token <token>` | Saves your Factorix address and API token, after checking they work.        |
| `fx whoami`                                | Shows who you are logged in as, and in which organization.                  |
| `fx agents`                                | Lists the agents you can hand work to, with their role, runtime, and model. |

### Runs

| Command                                                       | What it does                                                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `fx run <prompt> [-a agent] [--repo url] [--ref branch] [-f]` | Starts an agent on a task with no ticket. The repository defaults to this checkout's origin. With no prompt, it reads standard input. |
| `fx handoff [issue] <prompt> [-a agent] [-f] [--dry-run]`     | Hands this checkout to an agent as it is now. See [Handing off your checkout](#handing-off-your-checkout).                            |
| `fx pull <run\|issue> [--keep]`                               | Puts what the agent pushed since the handoff into this checkout.                                                                      |
| `fx runs`                                                     | Lists recent runs.                                                                                                                    |
| `fx logs <run\|issue> [-f]`                                   | Shows what a run did. `-f` follows it until it ends.                                                                                  |
| `fx status <run\|issue>`                                      | Shows a run's state, result, and cost.                                                                                                |
| `fx diff <run\|issue>`                                        | Prints the diff a run produced.                                                                                                       |
| `fx msg <run\|issue> <text>`                                  | Sends a message to a running agent.                                                                                                   |
| `fx cancel <run\|issue>`                                      | Cancels a run.                                                                                                                        |

### Issues

| Command                                                                | What it does                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `fx issues [query] [--all]`                                            | Searches open issues, or all of them with `--all`.                          |
| `fx issue <issue>`                                                     | Shows an issue's state, merge requests, and runs.                           |
| `fx assign <issue> <agent\|none>`                                      | Hands an issue to an agent, which starts its pipeline. `none` unassigns it. |
| `fx tell <issue> <text>`                                               | Leaves an instruction for the agent's next run.                             |
| `fx retry <issue>`                                                     | Starts a failed or cancelled issue again.                                   |
| `fx preview <issue> [stop\|refresh\|reset] [--path /page] [--no-open]` | Starts the issue's preview if needed, waits until it answers, and opens it. |

### Decisions

| Command                                                              | What it does                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `fx inbox`                                                           | Lists what waits for you: approvals, and issues that failed.                                     |
| `fx approve <id\|issue> [-m message] [--choice retry\|revert\|keep]` | Approves a plan, question, tool call, or merge. `--choice` answers a merge that stopped halfway. |
| `fx reject <id\|issue> -m <message>`                                 | Rejects it. The message tells the agent what to change.                                          |

### Integration

| Command   | What it does                                                |
| --------- | ----------------------------------------------------------- |
| `fx mcp`  | Runs as an MCP server over stdio, for a local coding agent. |
| `fx help` | Lists every command.                                        |

With `-f`, `fx run` and `fx handoff` exit with status 1 when the run does not succeed, so you can use them in scripts and CI.

## Handing off your checkout

`fx handoff` sends everything you have not pushed: local commits, uncommitted changes, and new files that are not ignored. It pushes them to origin with your own git access and leaves your checkout untouched. Add `--dry-run` to see what would go.

- **Without an issue**, your work goes to a `factorix/handoff-*` branch and an agent starts a run on it. The run pushes its commits to a `factorix/adhoc-*` branch of its own.
- **With an issue** (`fx handoff ENG-42 "Finish the retry logic"`), your work goes to the issue's branch, the prompt becomes an instruction, and the issue's pipeline starts from there. Nobody may be working on that issue yet, and its branch on origin must not have commits your checkout lacks.

When the agent is done, `fx pull <run|issue>` fetches its work and applies the difference since the handoff to your working tree, binary and large files included. If you changed the same files in the meantime, it merges and stages the result. For a run, it then deletes both branches from origin, unless you pass `--keep`.

A run with no ticket always works on the machine Factorix is installed on, even when its repository belongs to a project that runs on a remote runner.

## Use it from a coding agent (MCP)

`fx mcp` serves the same operations over stdio, so an agent on your machine can hand work to Factorix and check on it. It uses the login you saved with `fx login`.

With Claude Code:

```sh
claude mcp add factorix -- fx mcp
```

With any client that reads an `mcpServers` file:

```json
{
  "mcpServers": {
    "factorix": { "command": "fx", "args": ["mcp"] }
  }
}
```

The server offers these tools: `factorix_agents`, `factorix_issues`, `factorix_issue`, `factorix_assign`, `factorix_instruct`, `factorix_run`, `factorix_run_status`, `factorix_run_log`, `factorix_run_diff`, `factorix_run_message`, `factorix_run_cancel`, `factorix_inbox`, and `factorix_decide`. Text that comes from tickets and runs is marked as untrusted data for the agent that reads it.

## Configuration

`fx login` saves your settings to `~/.config/factorix/config.json` (or under `$XDG_CONFIG_HOME`), readable only by you. Environment variables take precedence over the file:

| Variable          | What it sets                                                              |
| ----------------- | ------------------------------------------------------------------------- |
| `FACTORIX_URL`    | The Factorix address.                                                     |
| `FACTORIX_TOKEN`  | The API token.                                                            |
| `FACTORIX_AGENT`  | The agent `fx run`, `fx handoff`, and `fx assign` use when you name none. |
| `FACTORIX_CONFIG` | Another path for the config file.                                         |

In CI, the environment is all you need:

```yaml
- run: npx @moxxy/factorix run "Check this branch for missing translations" -f
  env:
    FACTORIX_URL: https://factorix.example.com
    FACTORIX_TOKEN: ${{ secrets.FACTORIX_TOKEN }}
```

## Tokens and permissions

A token acts as the person who created it and can read whatever they can. What it may change is chosen when it is created:

| Scope     | Allows                                                                                                                            | Default |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Runs      | Start runs, message them, and cancel them.                                                                                        | On      |
| Issues    | Assign issues to agents, leave instructions, retry and cancel them.                                                               | On      |
| Approvals | Approve and reject what waits for a decision, merges included.                                                                    | On      |
| Previews  | Start, stop, and open previews. An open preview is the running app, with the secrets its project gives it. `fx preview` needs it. | Off     |

No token can perform admin actions or create other tokens. Revoking a token in Factorix takes effect immediately.

## Links

- [Factorix](https://github.com/WebEferen/factorix): the project, with setup instructions for your own server
- [Plugin SDK](https://www.npmjs.com/package/@moxxy/factorix-plugin-sdk): build trackers, pages, and workflow blocks for Factorix
- [Issues](https://github.com/WebEferen/factorix/issues): report a bug or ask for a feature

## License

[MIT](https://github.com/WebEferen/factorix/blob/main/apps/cli/LICENSE)
