import { execFileSync, spawn } from 'node:child_process'
import type { RunEvent } from '@factorix/runtime'
import type { AgentDto, ApprovalDto, ConnectionDto, IssueDetailDto, IssueDto, PreviewDto, RunDto } from '@factorix/schemas'
import type { Client } from './client'
import { renderEvent } from './render'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_PREFIX = /^[0-9a-f]{4,}$/i
export const TERMINAL_RUN_STATES = ['succeeded', 'failed', 'cancelled']

/** A mistake in what was asked, reported without a stack. */
export class UsageError extends Error {}

export async function findAgent(client: Client, ref: string | undefined): Promise<AgentDto> {
  const { agents } = await client.get<{ agents: AgentDto[] }>('/api/agents')
  const handles = agents.map((agent) => agent.handle).join(', ')
  const name = (ref ?? '').replace(/^@/, '')
  if (name) {
    const found = agents.find((agent) => agent.handle === name || agent.id === name)
    if (!found) throw new UsageError(`There is no agent called ${name}. Agents: ${handles}`)
    return found
  }
  const engineers = agents.filter((agent) => agent.status === 'active' && agent.archetype.role === 'engineer')
  if (engineers.length === 1) return engineers[0] as AgentDto
  throw new UsageError(`Name an agent. Agents: ${handles}`)
}

export async function findIssue(client: Client, ref: string): Promise<IssueDetailDto> {
  let id = ref
  if (!UUID.test(ref)) {
    const { issues } = await client.get<{ issues: IssueDto[] }>(`/api/issues?q=${encodeURIComponent(ref)}&limit=50`)
    const found = issues.find((issue) => issue.identifier.toLowerCase() === ref.toLowerCase())
    if (!found) throw new UsageError(`There is no issue called ${ref}.`)
    id = found.id
  }
  return (await client.get<{ issue: IssueDetailDto }>(`/api/issues/${id}`)).issue
}

/** Takes a run id, the start of one, or an issue, which means its active run or else its latest. */
export async function findRunId(client: Client, ref: string): Promise<string> {
  if (UUID.test(ref)) return ref
  if (ID_PREFIX.test(ref)) {
    const { runs } = await client.get<{ runs: RunDto[] }>('/api/runs?limit=300')
    const matches = runs.filter((run) => run.id.startsWith(ref.toLowerCase()))
    if (matches.length === 1) return (matches[0] as RunDto).id
    if (matches.length > 1) throw new UsageError(`${ref} matches ${matches.length} runs. Give more of the id.`)
  }
  const issue = await findIssue(client, ref)
  const id = issue.activeRunId ?? issue.runs[0]?.id
  if (!id) throw new UsageError(`${issue.identifier} has no runs yet.`)
  return id
}

/** Takes an approval id, the start of one, or an issue with exactly one decision waiting. */
export async function findApproval(client: Client, ref: string): Promise<ApprovalDto> {
  const { approvals } = await client.get<{ approvals: ApprovalDto[] }>('/api/approvals?status=pending')
  const matches = approvals.filter(
    (approval) =>
      approval.id === ref ||
      (ID_PREFIX.test(ref) && approval.id.startsWith(ref.toLowerCase())) ||
      approval.issueIdentifier?.toLowerCase() === ref.toLowerCase(),
  )
  if (matches.length === 0) throw new UsageError(`Nothing is waiting for a decision under ${ref}. See fx inbox.`)
  if (matches.length > 1) throw new UsageError(`${ref} has ${matches.length} decisions waiting. Use an id from fx inbox.`)
  return matches[0] as ApprovalDto
}

/** Turns a remote into the https address Factorix clones, without any credentials it carried. */
export function normalizeGitUrl(remote: string): string {
  const value = remote.trim()
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(value)
  if (scp) return `https://${scp[1]}/${scp[2]}`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new UsageError(`${value} is not a git address.`)
  }
  return `https://${url.hostname}${url.protocol.startsWith('http') && url.port ? `:${url.port}` : ''}${url.pathname}`
}

export function originUrl(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
  } catch {
    return undefined
  }
}

/** The code host account to clone with: the named one, or the first on the repository's server. */
export function pickConnection(connections: ConnectionDto[], gitUrl: string, name: string | undefined): ConnectionDto | undefined {
  if (name) {
    const found = connections.find((connection) => connection.name === name || connection.id === name)
    if (!found) throw new UsageError(`There is no connection called ${name}.`)
    return found
  }
  const host = new URL(gitUrl).hostname
  return connections.find((connection) => connection.accountRole === 'scm' && connection.egressHosts.includes(host))
}

export interface StartRunInput {
  prompt: string
  agent?: string
  repo?: string
  ref?: string
  /** Has the run push its commits to a branch of its own. */
  push?: boolean
  connection?: string
  cwd: string
}

export async function startRun(client: Client, input: StartRunInput): Promise<RunDto> {
  if (!input.prompt.trim()) throw new UsageError('Say what the agent should do.')
  const remote = input.repo ?? originUrl(input.cwd)
  if (!remote) throw new UsageError('Give a repository with --repo, or run this inside a git checkout that has an origin.')
  const gitUrl = normalizeGitUrl(remote)
  const [agent, { connections }] = await Promise.all([
    findAgent(client, input.agent),
    client.get<{ connections: ConnectionDto[] }>('/api/connections'),
  ])
  const { run } = await client.post<{ run: RunDto }>('/api/runs', {
    agentId: agent.id,
    prompt: input.prompt,
    gitUrl,
    ref: input.ref,
    push: input.push,
    scmConnectionId: pickConnection(connections, gitUrl, input.connection)?.id,
  })
  return run
}

/**
 * Prints a run's events. With `follow` it stays until the run ends, otherwise it stops at what has happened so far.
 * A run can end without a final event, so a quiet stream checks the run's state before waiting longer.
 */
export async function watchRun(
  client: Client,
  runId: string,
  options: { follow: boolean; onLine(line: string): void; idleMs?: number },
): Promise<RunDto> {
  const load = async () => (await client.get<{ run: RunDto }>(`/api/runs/${runId}`)).run
  const run = await load()
  const live = options.follow && !TERMINAL_RUN_STATES.includes(run.state)
  if (!live && run.lastSeq === 0) return run
  const abort = new AbortController()
  const idleMs = options.idleMs ?? (live ? 5000 : 2000)
  let timer: NodeJS.Timeout | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void onIdle(), idleMs)
  }
  const onIdle = async () => {
    const current = live ? await load().catch(() => null) : run
    if (current && live && !TERMINAL_RUN_STATES.includes(current.state)) arm()
    else abort.abort()
  }
  arm()
  try {
    for await (const data of client.events(`/api/runs/${runId}/events`, abort.signal)) {
      arm()
      const message = JSON.parse(data) as { kind: string; event?: RunEvent }
      if (message.kind !== 'event' || !message.event) continue
      const line = renderEvent(message.event)
      if (line) options.onLine(line)
      if (message.event.type === 'done' || (!live && message.event.seq >= run.lastSeq)) break
    }
  } catch (error) {
    if (!abort.signal.aborted) throw error
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
  return load()
}

export const runUrl = (client: Client, run: Pick<RunDto, 'id'>) => `${client.url}/runs/${run.id}`
export const issueUrl = (client: Client, issue: Pick<IssueDto, 'id'>) => `${client.url}/issues/${issue.id}`

export function describeRun(client: Client, run: RunDto): string {
  const lines = [
    `${run.id.slice(0, 8)}  ${run.state}${run.outcome ? ` (${run.outcome})` : ''}  @${run.agentHandle}  ${run.issueIdentifier ?? run.phase}`,
    runUrl(client, run),
  ]
  if (run.costUsd) lines.push(`cost: $${Number(run.costUsd).toFixed(2)}${run.costEstimated ? ' (estimated)' : ''}`)
  if (run.error) lines.push(`error: ${typeof run.error === 'string' ? run.error : JSON.stringify(run.error)}`)
  if (run.summary) lines.push('', run.summary)
  return lines.join('\n')
}

export function describeIssue(client: Client, issue: IssueDetailDto): string {
  const lines = [
    `${issue.identifier}  ${issue.title}`,
    `state: ${issue.factoryState}${issue.waitingFor ? `, waiting for ${issue.waitingFor}` : ''}${issue.pipelineStep ? `, step ${issue.pipelineStep}` : ''}`,
    `agent: ${issue.assignedAgentHandle ? `@${issue.assignedAgentHandle}` : 'none'}`,
    issueUrl(client, issue),
  ]
  if (issue.branchName) lines.push(`branch: ${issue.branchName}`)
  for (const mr of issue.mergeRequests) lines.push(`merge request: ${mr.url} (${mr.state})`)
  const pending = issue.approvals.filter((approval) => approval.status === 'pending')
  for (const approval of pending) lines.push(`waiting for you: ${approval.kind}  fx approve ${approval.id.slice(0, 8)}`)
  if (issue.runs.length > 0) {
    lines.push('', 'runs:')
    for (const run of issue.runs.slice(0, 8))
      lines.push(`  ${run.id.slice(0, 8)}  ${run.state.padEnd(16)}  ${run.pipelineStep ?? run.phase}  @${run.agentHandle}`)
  }
  return lines.join('\n')
}

export function describeApproval(approval: ApprovalDto): string {
  const about = approval.issueIdentifier
    ? `${approval.issueIdentifier} ${approval.issueTitle ?? ''}`.trim()
    : `run ${approval.runId?.slice(0, 8) ?? ''}`
  const summary = typeof approval.payload.summary === 'string' ? `: ${approval.payload.summary}` : ''
  return `${approval.id.slice(0, 8)}  ${approval.kind}  ${about}${summary}`
}

export async function decide(
  client: Client,
  ref: string,
  input: { decision: 'approved' | 'rejected'; message?: string; choice?: string },
): Promise<ApprovalDto> {
  const approval = await findApproval(client, ref)
  await client.post(`/api/approvals/${approval.id}/decide`, input)
  return approval
}

const PREVIEW_LIVE = ['starting', 'ready', 'refreshing']

/**
 * Starts an issue's preview unless it is already up, waits until it answers, and returns an address that signs the browser in.
 * The address works once and only for a short while, so it is asked for last.
 */
export async function openPreview(
  client: Client,
  issue: Pick<IssueDto, 'id' | 'identifier'>,
  options: { path?: string; onLine(line: string): void; pollMs?: number; timeoutMs?: number },
): Promise<string> {
  const base = `/api/issues/${issue.id}/preview`
  let { preview } = await client.get<{ preview: PreviewDto }>(base)
  if (preview.unavailable) throw new UsageError(preview.unavailable)
  if (!preview.state || !PREVIEW_LIVE.includes(preview.state)) {
    options.onLine(`Starting the preview of ${issue.identifier}.`)
    preview = (await client.post<{ preview: PreviewDto }>(`${base}/start`)).preview
  }
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000)
  const said = new Map<string, string>()
  while (preview.state !== 'ready') {
    if (preview.state === 'failed' || preview.state === 'stopped' || preview.state === 'stopping')
      throw new UsageError(`The preview ${preview.state === 'failed' ? `failed: ${preview.error ?? 'see its logs in Factorix'}` : 'was stopped'}.`)
    for (const service of preview.services) {
      if (said.get(service.name) === service.state) continue
      said.set(service.name, service.state)
      options.onLine(`  ${service.name}: ${service.state}${service.message ? ` (${service.message})` : ''}`)
    }
    if (Date.now() > deadline) throw new UsageError('The preview is still starting. Run fx preview again later.')
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 3000))
    preview = (await client.get<{ preview: PreviewDto }>(base)).preview
  }
  return (await client.post<{ url: string }>(`${base}/open`, options.path ? { path: options.path } : {})).url
}

/** Best effort: the address is printed either way. */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try {
    const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // No browser to hand it to.
  }
}

const ISSUE_REF = /^[a-z][a-z0-9]*-\d+$/i
export const looksLikeIssue = (word: string | undefined): word is string => Boolean(word && ISSUE_REF.test(word))
/** The states in which nothing is working on an issue, so its branch can take a push. */
const IDLE_ISSUE_STATES = ['untracked', 'done', 'failed', 'cancelled']
const sameRepo = (a: string, b: string) => a.replace(/\.git$/, '').toLowerCase() === b.replace(/\.git$/, '').toLowerCase()

/** Checks that this checkout can be handed to the issue, before anything is pushed. */
export async function issueHandoffTarget(
  client: Client,
  ref: string,
  input: { cwd: string; agent?: string },
): Promise<{ issue: IssueDetailDto; agent: AgentDto }> {
  const issue = await findIssue(client, ref)
  const remote = originUrl(input.cwd)
  const gitUrl = remote ? normalizeGitUrl(remote) : null
  if (!gitUrl || !issue.project.repos.some((repo) => sameRepo(normalizeGitUrl(repo.scmCloneUrl), gitUrl)))
    throw new UsageError(`This checkout's origin is not a repository of ${issue.project.name}, which ${issue.identifier} belongs to.`)
  if (!IDLE_ISSUE_STATES.includes(issue.factoryState))
    throw new UsageError(
      `${issue.identifier} is ${issue.factoryState}, so an agent already has it. Leave a note with fx tell, or cancel it first with fx cancel.`,
    )
  const agent = await findAgent(client, input.agent ?? issue.assignedAgentId ?? undefined)
  return { issue, agent }
}

/** Leaves the instruction and starts the pipeline. Returns the run it started, when one shows up in time. */
export async function startIssueHandoff(
  client: Client,
  issue: IssueDetailDto,
  agent: AgentDto,
  prompt: string,
  options: { waitMs?: number; pollMs?: number } = {},
): Promise<string | null> {
  await client.post(`/api/issues/${issue.id}/instructions`, { body: prompt })
  await client.post(`/api/issues/${issue.id}/assign`, { agentId: agent.id })
  const deadline = Date.now() + (options.waitMs ?? 30_000)
  while (Date.now() < deadline) {
    const current = (await client.get<{ issue: IssueDetailDto }>(`/api/issues/${issue.id}`)).issue
    if (current.activeRunId) return current.activeRunId
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000))
  }
  return null
}
