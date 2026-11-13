import { parseArgs } from 'node:util'
import type { AccountDto, AgentDto, ApprovalDto, IssueDto, PreviewDto, RunDto } from '@factorix/schemas'
import { ApiError, Client } from './client'
import { readConfig, writeConfig } from './config'
import {
  applyDiff,
  applyRange,
  deleteRemoteBranch,
  fetchBranch,
  forgetHandoff,
  HANDOFF_BRANCH,
  handoffBase,
  handoffBranch,
  pushSnapshot,
  pushToIssueBranch,
  rememberHandoff,
  repoRoot,
  takeSnapshot,
} from './handoff'
import { runMcpServer } from './mcp'
import {
  decide,
  describeApproval,
  describeIssue,
  describeRun,
  findAgent,
  findIssue,
  findRunId,
  issueHandoffTarget,
  issueUrl,
  looksLikeIssue,
  openInBrowser,
  openPreview,
  startIssueHandoff,
  startRun,
  TERMINAL_RUN_STATES,
  UsageError,
  watchRun,
} from './ops'
import { table } from './render'

const HELP = `fx hands work to Factorix agents from a terminal.

  fx login --url <address> --token <token>   Save where Factorix is and your API token (Settings, API tokens)
  fx whoami

  fx run <prompt> [-a agent] [--repo url] [--ref branch] [-f]
                                             Start an agent on a task with no ticket. The repository defaults to
                                             this checkout's origin. With no prompt it reads standard input.
                                             Nothing is pushed: fx diff shows what it changed.
  fx handoff [issue] <prompt> [-a agent] [-f] [--dry-run]
                                             Hand this checkout to an agent as it is now: commits you have not
                                             pushed, uncommitted changes, and new files that are not ignored,
                                             pushed to origin as you. With an issue they go to its branch and
                                             its pipeline starts from them. Without one they go to a
                                             factorix/handoff-* branch and a run with no ticket works on them.
  fx pull <run|issue> [--keep]               Fetch what the agent pushed since the handoff and put it into this
                                             checkout. For a run it then removes the branches the handoff made.
  fx runs                                    Recent runs
  fx logs <run|issue> [-f]                   What a run did. -f follows it until it ends.
  fx status <run|issue>
  fx diff <run|issue>
  fx msg <run|issue> <text>                  Message a running agent
  fx cancel <run|issue>

  fx issues [query] [--all]                  Search issues
  fx issue <issue>                           State, merge requests, and runs of one issue
  fx assign <issue> <agent|none>             Hand an issue to an agent, which starts the pipeline
  fx tell <issue> <text>                     Leave an instruction for the agent's next run
  fx retry <issue>
  fx preview <issue> [stop|refresh|reset] [--path /page] [--no-open]
                                             Start the issue's preview if it is not running, wait until it
                                             answers, and open it in the browser.

  fx inbox                                   What waits for you
  fx approve <id|issue> [-m message] [--choice retry|revert|keep]
  fx reject <id|issue> -m <message>

  fx agents
  fx mcp                                     Run as an MCP server over stdio, for a local coding agent

FACTORIX_URL, FACTORIX_TOKEN, and FACTORIX_AGENT override what fx login saved.`

const out = (line: string) => process.stdout.write(`${line}\n`)
const issueKey = (identifier: string) => `issue-${identifier.toLowerCase()}`
const runKey = (runId: string) => `run-${runId}`

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  let text = ''
  for await (const chunk of process.stdin.setEncoding('utf8')) text += chunk
  return text
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      token: { type: 'string' },
      agent: { type: 'string', short: 'a' },
      repo: { type: 'string' },
      ref: { type: 'string' },
      connection: { type: 'string' },
      follow: { type: 'boolean', short: 'f' },
      message: { type: 'string', short: 'm' },
      choice: { type: 'string' },
      all: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      keep: { type: 'boolean' },
      path: { type: 'string' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, ...rest] = positionals
  if (!command || values.help || command === 'help') {
    out(HELP)
    return 0
  }
  const config = readConfig()

  if (command === 'login') {
    const url = (values.url ?? config.url)?.replace(/\/+$/, '')
    const token = values.token ?? config.token
    if (!url || !token) throw new UsageError('Give both: fx login --url https://factorix.example.com --token fxp_...')
    const { account } = await new Client(url, token).get<{ account: AccountDto }>('/api/auth/me')
    const path = writeConfig({ url, token, agent: values.agent ?? config.agent })
    out(`Logged in to ${url} as ${account.displayName}. Saved to ${path}.`)
    return 0
  }

  if (!config.url || !config.token) throw new UsageError('Not logged in. Create a token under Settings, API tokens, then run fx login.')
  const client = new Client(config.url, config.token)
  const arg = (index: number, what: string): string => {
    const value = rest[index]
    if (!value) throw new UsageError(`Missing ${what}. See fx help.`)
    return value
  }
  const follow = (runId: string) => watchRun(client, runId, { follow: true, onLine: out })

  switch (command) {
    case 'whoami': {
      const { account, org } = await client.get<{ account: AccountDto; org: { name: string } }>('/api/auth/me')
      out(`${account.displayName} (${account.role}) in ${org.name} at ${client.url}`)
      return 0
    }
    case 'agents': {
      const { agents } = await client.get<{ agents: AgentDto[] }>('/api/agents')
      out(table(agents.map((agent) => [`@${agent.handle}`, agent.archetype.role, agent.runtime, agent.model ?? '', agent.status])))
      return 0
    }
    case 'run': {
      const prompt = rest.join(' ') || (await readStdin())
      const run = await startRun(client, {
        prompt,
        agent: values.agent ?? config.agent,
        repo: values.repo,
        ref: values.ref,
        connection: values.connection,
        cwd: process.cwd(),
      })
      out(describeRun(client, run))
      if (!values.follow) return 0
      out('')
      return (await follow(run.id)).state === 'succeeded' ? 0 : 1
    }
    case 'handoff': {
      const issueRef = looksLikeIssue(rest[0]) ? rest[0] : undefined
      const prompt = (issueRef ? rest.slice(1) : rest).join(' ') || (await readStdin())
      if (!prompt.trim()) throw new UsageError('Say what the agent should do.')
      const snapshot = takeSnapshot(process.cwd())
      const target = issueRef ? await issueHandoffTarget(client, issueRef, { cwd: snapshot.root, agent: values.agent ?? config.agent }) : undefined
      const branch = target ? target.issue.workBranch : handoffBranch(snapshot)
      out(
        `Handing off ${snapshot.unpushed} unpushed ${snapshot.unpushed === 1 ? 'commit' : 'commits'} and ${snapshot.files.length} changed ${
          snapshot.files.length === 1 ? 'file' : 'files'
        } as ${branch}${target ? `, the branch of ${target.issue.identifier}, to @${target.agent.handle}` : ''}.`,
      )
      for (const file of snapshot.files.slice(0, 30)) out(`  ${file}`)
      if (snapshot.files.length > 30) out(`  and ${snapshot.files.length - 30} more`)
      if (values['dry-run']) return 0
      if (target) {
        pushToIssueBranch(snapshot, branch)
        rememberHandoff(snapshot.root, issueKey(target.issue.identifier), snapshot.commit)
        const runId = await startIssueHandoff(client, target.issue, target.agent, prompt)
        out(issueUrl(client, target.issue))
        out(`When it has pushed: fx pull ${target.issue.identifier}`)
        if (!values.follow || !runId) return 0
        out('')
        return (await follow(runId)).state === 'succeeded' ? 0 : 1
      }
      pushSnapshot(snapshot, branch)
      const run = await startRun(client, {
        prompt,
        agent: values.agent ?? config.agent,
        ref: branch,
        push: true,
        connection: values.connection,
        cwd: snapshot.root,
      })
      rememberHandoff(snapshot.root, runKey(run.id), snapshot.commit)
      out(describeRun(client, run))
      out(`When it is done: fx pull ${run.id.slice(0, 8)}`)
      if (!values.follow) return 0
      out('')
      return (await follow(run.id)).state === 'succeeded' ? 0 : 1
    }
    case 'pull': {
      const ref = arg(0, 'a run or an issue')
      const root = repoRoot(process.cwd())
      const report = (applied: { files: string[]; merged: boolean }) => {
        if (applied.files.length === 0) return out('Nothing new to apply.')
        out(
          `Applied ${applied.files.length} ${applied.files.length === 1 ? 'file' : 'files'}${applied.merged ? ', merged with your own changes and staged' : ''}:`,
        )
        for (const file of applied.files) out(`  ${file}`)
      }
      const issueBase = looksLikeIssue(ref) ? handoffBase(root, issueKey(ref)) : null
      if (issueBase) {
        const issue = await findIssue(client, ref)
        const head = fetchBranch(root, issue.workBranch)
        report(applyRange(root, issueBase, head))
        rememberHandoff(root, issueKey(ref), head)
        return 0
      }
      const runId = await findRunId(client, ref)
      const { run } = await client.get<{ run: RunDto }>(`/api/runs/${runId}`)
      if (!TERMINAL_RUN_STATES.includes(run.state))
        throw new UsageError(`That run is still ${run.state}. Follow it with fx logs ${runId.slice(0, 8)} -f.`)
      const base = handoffBase(root, runKey(run.id))
      if (run.resultBranch && base) {
        report(applyRange(root, base, fetchBranch(root, run.resultBranch)))
        forgetHandoff(root, runKey(run.id))
      } else if (run.hasDiff) {
        report(applyDiff(root, (await client.get<{ diff: string }>(`/api/runs/${runId}/diff`)).diff))
      } else {
        out('This run changed nothing.')
      }
      if (base && !values.keep) {
        for (const branch of [run.resultBranch, run.adHocRef?.startsWith(HANDOFF_BRANCH) ? run.adHocRef : null]) {
          if (!branch) continue
          try {
            deleteRemoteBranch(root, branch)
            out(`Removed ${branch} from origin.`)
          } catch (error) {
            out(`Could not remove ${branch} from origin: ${(error as Error).message}`)
          }
        }
      }
      return 0
    }
    case 'preview': {
      const issue = await findIssue(client, arg(0, 'an issue'))
      const action = rest[1]
      if (action) {
        if (!['stop', 'refresh', 'reset'].includes(action)) throw new UsageError(`There is no fx preview ${action}. Use stop, refresh, or reset.`)
        const { preview } = await client.post<{ preview: PreviewDto }>(`/api/issues/${issue.id}/preview/${action}`)
        out(`${issue.identifier} preview: ${preview.state ?? 'not started'}`)
        return 0
      }
      const url = await openPreview(client, issue, { path: values.path, onLine: out })
      out(url)
      if (!values['no-open']) openInBrowser(url)
      return 0
    }
    case 'runs': {
      const { runs } = await client.get<{ runs: RunDto[] }>('/api/runs?limit=20')
      out(
        table(
          runs.map((run) => [
            run.id.slice(0, 8),
            run.state,
            `@${run.agentHandle}`,
            run.issueIdentifier ?? run.phase,
            (run.issueTitle ?? run.adHocPrompt ?? '').split('\n')[0]?.slice(0, 70) ?? '',
          ]),
        ) || 'No runs yet.',
      )
      return 0
    }
    case 'logs': {
      const id = await findRunId(client, arg(0, 'a run or an issue'))
      const run = await watchRun(client, id, { follow: values.follow === true, onLine: out })
      if (!TERMINAL_RUN_STATES.includes(run.state)) out(`\n(${run.state}, fx logs ${id.slice(0, 8)} -f follows it)`)
      return 0
    }
    case 'status': {
      const id = await findRunId(client, arg(0, 'a run or an issue'))
      out(describeRun(client, (await client.get<{ run: RunDto }>(`/api/runs/${id}`)).run))
      return 0
    }
    case 'diff': {
      const { diff } = await client.get<{ diff: string }>(`/api/runs/${await findRunId(client, arg(0, 'a run or an issue'))}/diff`)
      out(diff || 'This run has no diff.')
      return 0
    }
    case 'msg': {
      const id = await findRunId(client, arg(0, 'a run or an issue'))
      await client.post(`/api/runs/${id}/messages`, { text: rest.slice(1).join(' ') || arg(1, 'the message') })
      out('Sent.')
      return 0
    }
    case 'cancel': {
      await client.post(`/api/runs/${await findRunId(client, arg(0, 'a run or an issue'))}/cancel`, {})
      out('Cancel requested.')
      return 0
    }
    case 'issues': {
      const query = rest.join(' ')
      const { issues } = await client.get<{ issues: IssueDto[] }>(
        `/api/issues?limit=30&scope=${values.all ? 'all' : 'open'}${query ? `&q=${encodeURIComponent(query)}` : ''}`,
      )
      out(
        table(
          issues.map((issue) => [
            issue.identifier,
            issue.factoryState,
            issue.assignedAgentHandle ? `@${issue.assignedAgentHandle}` : '-',
            issue.title.slice(0, 80),
          ]),
        ) || 'No issues match.',
      )
      return 0
    }
    case 'issue': {
      out(describeIssue(client, await findIssue(client, arg(0, 'an issue'))))
      return 0
    }
    case 'assign': {
      const issue = await findIssue(client, arg(0, 'an issue'))
      const name = rest[1] ?? values.agent ?? config.agent
      const agent = name === 'none' ? null : await findAgent(client, name)
      await client.post(`/api/issues/${issue.id}/assign`, { agentId: agent?.id ?? null })
      out(`${issue.identifier} is ${agent ? `with @${agent.handle}` : 'unassigned'}. ${issueUrl(client, issue)}`)
      return 0
    }
    case 'tell': {
      const issue = await findIssue(client, arg(0, 'an issue'))
      await client.post(`/api/issues/${issue.id}/instructions`, { body: rest.slice(1).join(' ') || arg(1, 'the instruction') })
      out(`Left on ${issue.identifier}.`)
      return 0
    }
    case 'retry': {
      const issue = await findIssue(client, arg(0, 'an issue'))
      await client.post(`/api/issues/${issue.id}/retry`, {})
      out(`${issue.identifier} is starting again.`)
      return 0
    }
    case 'inbox': {
      const inbox = await client.get<{ approvals: ApprovalDto[]; failedIssues: IssueDto[] }>('/api/inbox')
      const lines = [...inbox.approvals.map(describeApproval), ...inbox.failedIssues.map((issue) => `failed    ${issue.identifier}  ${issue.title}`)]
      out(lines.join('\n') || 'Nothing is waiting.')
      return 0
    }
    case 'approve':
    case 'reject': {
      if (command === 'reject' && !values.message) throw new UsageError('Say why with -m, so the agent knows what to change.')
      const approval = await decide(client, arg(0, 'an approval id or an issue'), {
        decision: command === 'approve' ? 'approved' : 'rejected',
        message: values.message,
        choice: values.choice,
      })
      out(`${command === 'approve' ? 'Approved' : 'Rejected'}: ${describeApproval(approval)}`)
      return 0
    }
    case 'mcp':
      await runMcpServer(client, process.cwd())
      return 0
    default:
      throw new UsageError(`There is no fx ${command}. See fx help.`)
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    if (error instanceof UsageError || error instanceof ApiError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`${(error as Error).message}\n`)
    } else {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    }
    process.exitCode = 1
  },
)
