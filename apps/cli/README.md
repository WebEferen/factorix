# fx

The command line and MCP server for [Factorix](https://github.com/WebEferen/factorix). It hands work to agents and follows it without the browser.

```sh
npm install -g @moxxylabs/factorix
```

Needs Node 22 or newer. Create a token in Factorix under Settings, API tokens, then:

```sh
fx login --url https://factorix.example.com --token fxp_...
fx assign INS-123 engineer-1      # start the pipeline on an issue
fx logs INS-123 -f                # follow its current run
fx inbox                          # what waits for you
fx approve INS-123 -m "go ahead"
fx run "why is the billing test flaky?" -f   # a task with no ticket, on this checkout's origin
fx handoff "finish the retry logic" -f       # the same, starting from this checkout as it is now
fx handoff INS-123 "finish the retry logic"  # the same on an issue: its branch, its pipeline
fx pull 0a1b2c3d                  # fetch what the agent pushed into this checkout (a run or an issue)
fx preview INS-123                # start the issue's preview if needed and open it
```

A run started with `fx run` works from what is pushed and pushes nothing, so `fx diff` shows its result. `fx help` lists every command.

`fx handoff` sends what you have not pushed: local commits, uncommitted changes, and new files that are not ignored. They are pushed to origin with your own git access, and your checkout is not touched. `--dry-run` lists what would go. With an issue (`fx handoff INS-123 "finish the retry logic"`) they go to the issue's branch, the prompt becomes an instruction, and its pipeline starts from them. That needs an issue nobody is working on, and a branch on origin that has nothing your checkout lacks. Without an issue they go to a `factorix/handoff-*` branch, and the run pushes its commits to a `factorix/adhoc-*` branch of its own.

`fx pull` fetches what the agent pushed and applies the difference since the handoff to your working tree, so large and binary files come back too. If you changed the same files meanwhile it merges and stages. For a run it then removes both branches from origin, unless `--keep` is given. A run with no ticket always works on the machine Factorix is installed on, even when its repository belongs to a project on a runner.

A token can read what its owner can. What it may change is chosen when it is made: runs, issues, approvals, and previews, the last one off unless you tick it. `fx preview` needs it.

## MCP

`fx mcp` serves the same operations over stdio, so a local coding agent can hand work to Factorix and check on it:

```sh
claude mcp add factorix -- fx mcp
```

## Configuration

`fx login` saves to `~/.config/factorix/config.json`, readable only by you. `FACTORIX_URL`, `FACTORIX_TOKEN`, and `FACTORIX_AGENT` override it, which is all a CI job needs.

A token acts as the person who made it. It cannot do admin actions or create tokens, and revoking it in Factorix takes effect at once.
