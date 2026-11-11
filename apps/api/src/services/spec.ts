import type { TrackerResource } from '@factorix/connectors'
import { type OpenThread, PHASES, type PhaseContext, renderSystemPrompt, resolvePolicy } from '@factorix/core'
import type { ApprovalRow, ConnectionRow, IssueInstructionRow, IssueRow, MrDiscussionRow, ProjectRow, RunRow } from '@factorix/db'
import {
  BRIDGE_SOCKET,
  type McpServerSpec,
  type PermissionPolicy,
  type Phase,
  type ReasoningEffort,
  type RunSpec,
  type RuntimeId,
  type ScriptedPlan,
} from '@factorix/runtime'
import type { AppDeps } from '../deps'
import { decryptConnection, trackerConnectionFor, trackerFor } from './connections'
import { mergeRequestsOf } from './repos'

export interface SpecRepo {
  id?: string | null
  name: string
  path: string
  baseBranch: string
  setupCommands?: string[]
  checkCommands?: string[]
}

/** One repository keeps the classic layout where the agent starts at its root. Several put the agent above them. */
export function workingDirectory(repos: Pick<SpecRepo, 'name'>[]): string {
  return repos.length === 1 ? `/workspace/repos/${repos[0]?.name}` : '/workspace/repos'
}

export interface AgentSnapshot {
  handle: string
  displayName: string
  archetype: { name: string; role: string; systemPrompt: string }
  systemPrompt: string
  runtime: RuntimeId
  model: string | null
  reasoningEffort: ReasoningEffort | null
  maxBudgetUsd: number | null
  maxTurns: number | null
  policy: PermissionPolicy
  skills: { name: string; markdown: string }[]
}

function scriptFolders(repos: SpecRepo[]): string[] {
  return repos.length > 1 ? repos.map((repo) => repo.name) : ['.']
}

export function defaultScript(phase: Phase, runId: string, repos: SpecRepo[]): ScriptedPlan {
  const folders = scriptFolders(repos)
  const first = folders[0] as string
  switch (phase) {
    case 'plan':
      return {
        steps: [{ say: 'Reading the repository to write a plan.' }, { exec: `git -C ${first} log --oneline -5 && ls` }],
        structuredOutput: {
          summary: 'Add a small marker file that proves the factory ran.',
          steps: ['Create FACTORIX_DEMO.md', 'Commit it'],
          filesTouched: ['FACTORIX_DEMO.md'],
          risks: [],
          questions: [],
        },
      }
    case 'implement':
      return {
        steps: [
          { say: 'Implementing the change.' },
          ...folders.flatMap((folder) => [
            { writeFile: { path: `${folder}/FACTORIX_DEMO.md`, content: `Written by the scripted runtime in run ${runId}.\n` } },
            {
              exec: `git -C ${folder} add FACTORIX_DEMO.md && git -C ${folder} commit -qm "docs: add factorix demo marker" && git -C ${folder} log -1 --format=%B`,
            },
          ]),
        ],
        structuredOutput: {
          summary: 'Added FACTORIX_DEMO.md.',
          approach: 'Wrote a marker file with the scripted runtime.',
          testing: 'No tests apply to the marker file.',
          notes: '',
        },
      }
    case 'review':
      return {
        steps: [{ say: 'Reviewing the merge request.' }, { exec: `git -C ${first} log -3 --oneline` }],
        structuredOutput: { verdict: 'approve', summary: 'The marker file is harmless.', comments: [] },
      }
    case 'address_review':
      return {
        steps: [
          { say: 'Addressing review feedback.' },
          { writeFile: { path: `${first}/FACTORIX_DEMO.md`, content: `Updated by the scripted runtime in run ${runId}.\n` } },
          { exec: `git -C ${first} add -A && git -C ${first} commit -qm "docs: address review"` },
        ],
        structuredOutput: { summary: 'Updated the marker file.', threads: [] },
      }
    case 'task':
      return {
        steps: [{ say: 'Looking into the ticket.' }, { exec: `git -C ${first} log -1 --oneline` }],
        structuredOutput: { summary: 'Nothing here needs attention.' },
      }
    case 'ad_hoc':
      return { steps: [{ say: 'Running the ad-hoc task.' }, { exec: 'ls -la' }, { writeFile: { path: 'ADHOC.md', content: 'scripted\n' } }] }
  }
}

function openThreadsFrom(rows: MrDiscussionRow[], repos: { id?: string | null; name: string }[]): OpenThread[] {
  const seen = new Set<string>()
  const threads: OpenThread[] = []
  for (const row of rows) {
    if (row.resolved || row.origin === 'system' || seen.has(row.discussionId)) continue
    seen.add(row.discussionId)
    threads.push({
      discussionId: row.discussionId,
      repo: repos.length > 1 ? repos.find((repo) => repo.id === row.repoId)?.name : undefined,
      path: row.path,
      line: row.line,
      author: row.authorLogin,
      body: row.body,
    })
  }
  return threads
}

const FACTORIX_MCP_SERVER: McpServerSpec = {
  type: 'stdio',
  command: 'node',
  args: ['/opt/factorix/runner/index.mjs', '--mcp'],
  env: { FACTORIX_BRIDGE: BRIDGE_SOCKET },
}

/** An edit-only agent may use only what its policy allows, so the platform's own tools are allowed explicitly. */
function withFactorixTools(policy: PermissionPolicy): PermissionPolicy {
  return { ...policy, allow: [...policy.allow, 'mcp__factorix__*'] }
}

async function mcpServersFor(deps: Pick<AppDeps, 'db' | 'secrets'>, run: RunRow): Promise<Record<string, McpServerSpec>> {
  const rows = (await deps
    .db('connections')
    .join('agent_connections', 'connections.id', 'agent_connections.connection_id')
    .where({ 'agent_connections.agent_id': run.agentId, 'agent_connections.role': 'mcp' })
    .select('connections.*')) as ConnectionRow[]
  const servers: Record<string, McpServerSpec> = {}
  for (const row of rows) {
    const key = row.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    const secret = decryptConnection(deps, row)
    const values = secret ? (JSON.parse(secret) as Record<string, string>) : {}
    if (row.kind === 'mcp_stdio') {
      servers[key] = { type: 'stdio', command: String(row.config.command), args: (row.config.args as string[] | undefined) ?? [], env: values }
    } else if (row.kind === 'mcp_http') {
      servers[key] = { type: 'http', url: String(row.config.url), headers: values }
    }
  }
  return servers
}

export async function buildPhaseContext(
  deps: Pick<AppDeps, 'db'>,
  run: RunRow,
  issue: IssueRow | null,
  repos: SpecRepo[],
  branch: string,
  ciFailures: string[],
): Promise<PhaseContext> {
  const context: PhaseContext = {
    repos: repos.map((repo) => ({
      name: repo.name,
      path: repo.path,
      defaultBranch: repo.baseBranch,
      setupCommands: repo.setupCommands,
      checkCommands: repo.checkCommands,
    })),
    branch,
    adHocPrompt: run.adHoc?.prompt,
    ciFailures,
  }
  if (!issue) return context
  context.issue = { identifier: issue.identifier, title: issue.title, description: issue.description, url: issue.trackerUrl }
  const mergeRequests = await mergeRequestsOf(deps.db, issue.id)
  for (const repo of context.repos) repo.mrUrl = mergeRequests.find((mr) => mr.repo.name === repo.name)?.mrUrl

  const instructions = await deps
    .db<IssueInstructionRow>('issue_instructions')
    .where({ issueId: issue.id })
    .whereNull('consumedByRunId')
    .orderBy('created_at')
  context.instructions = instructions.map((row) => (row.author ? `${row.author}: ${row.body}` : row.body))

  const approval = await deps
    .db<ApprovalRow>('approvals')
    .where({ issueId: issue.id, kind: 'plan', status: 'approved' })
    .orderBy('decided_at', 'desc')
    .first()
  if (approval) {
    context.approvedPlan = (approval.payload as { plan?: unknown }).plan
    context.planNotes = (approval.decision as { message?: string } | null)?.message ?? null
  }

  const discussions = await deps.db<MrDiscussionRow>('mr_discussions').where({ issueId: issue.id }).orderBy('created_at')
  context.openThreads = openThreadsFrom(discussions, repos)

  const previous = await deps
    .db<RunRow>('runs')
    .where({ issueId: issue.id, state: 'succeeded' })
    .whereIn('phase', ['implement', 'address_review'])
    .orderBy('created_at', 'desc')
    .first()
  context.previousSummary = previous?.summary ?? null
  return context
}

/** What people attached to the issue, read with the account this agent comments with. A tracker error leaves them out and never stops the run. */
export async function readIssueResources(
  deps: Pick<AppDeps, 'db' | 'secrets' | 'connectors'>,
  input: { run: RunRow; issue: IssueRow | null; project: ProjectRow | null },
  warn: (message: string) => void,
): Promise<TrackerResource[]> {
  const { run, issue, project } = input
  if (!issue || !project) return []
  try {
    const connection = await trackerConnectionFor(deps.db, run.orgId, project.trackerConnectionId, run.agentId)
    return await trackerFor(deps, connection).listResources(issue.trackerIssueId)
  } catch (error) {
    warn(`Could not read the documents and links attached to ${issue.identifier}: ${(error as Error).message}`)
    return []
  }
}

/** A reviewer gets a fresh session on purpose. A retry does too, because a broken session may be why the last attempt failed. */
export async function sessionToResume(deps: Pick<AppDeps, 'db'>, run: RunRow): Promise<string | undefined> {
  if (run.sessionRef) return run.sessionRef
  if (!run.issueId || run.attempt > 1 || run.phase === 'review' || run.phase === 'plan') return undefined
  const previous = await deps
    .db<RunRow>('runs')
    .where({ issueId: run.issueId, agentId: run.agentId, runtime: run.runtime })
    .whereIn('phase', ['plan', 'implement', 'address_review'])
    .whereNotNull('sessionRef')
    .whereNot({ id: run.id })
    .orderBy('created_at', 'desc')
    .first()
  return previous?.sessionRef ?? undefined
}

export interface SpecInput {
  run: RunRow
  issue: IssueRow | null
  project: ProjectRow | null
  repos: SpecRepo[]
  branch: string
  repoDocs: { path: string; content: string }[]
  ciFailures: string[]
  extraNotes: string[]
  resumeSessionRef?: string
  /** Adds the factorix MCP server, whose preview tools reach the worker through the runner. */
  previewTool?: boolean
  resources?: TrackerResource[]
  scripted?: ScriptedPlan
}

export async function buildRunSpec(deps: Pick<AppDeps, 'db' | 'secrets'>, input: SpecInput): Promise<RunSpec> {
  const { run, issue, project } = input
  const agent = run.agentSnapshot as unknown as AgentSnapshot
  const phase = run.phase as Phase
  const template = PHASES[phase]
  const context = await buildPhaseContext(deps, run, issue, input.repos, input.branch, input.ciFailures)
  if (input.resources?.length) context.resources = input.resources
  const notes = input.extraNotes.length > 0 ? `\n\n${input.extraNotes.join('\n\n')}` : ''
  return {
    runId: run.id,
    attempt: run.attempt,
    phase,
    cwd: workingDirectory(input.repos),
    runtime: run.runtime,
    model: {
      name: agent.model ?? undefined,
      reasoningEffort: agent.reasoningEffort ?? undefined,
      maxTurns: agent.maxTurns ?? undefined,
      maxBudgetUsd: agent.maxBudgetUsd ?? undefined,
    },
    prompt: {
      system: renderSystemPrompt({
        agent: { handle: agent.handle, displayName: agent.displayName, archetype: agent.archetype, systemPrompt: agent.systemPrompt },
        skills: agent.skills ?? [],
        phase,
        repoDocs: input.repoDocs,
        project: project ? { name: project.name, repos: input.repos } : undefined,
      }),
      user: `${template.userPrompt(context)}${notes}`,
    },
    mcpServers: {
      ...(await mcpServersFor(deps, run)),
      ...(input.previewTool ? { factorix: FACTORIX_MCP_SERVER } : {}),
    },
    policy: input.previewTool ? withFactorixTools(resolvePolicy(agent.policy, phase)) : resolvePolicy(agent.policy, phase),
    resume: input.resumeSessionRef ? { sessionRef: input.resumeSessionRef } : undefined,
    outputSchema: template.outputSchema,
    startSeq: run.lastRunnerSeq,
    scripted: run.runtime === 'scripted' ? (input.scripted ?? defaultScript(phase, run.id, input.repos)) : undefined,
  }
}
