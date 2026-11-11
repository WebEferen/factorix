import type { JsonSchema, PermissionPolicy, Phase } from '@factorix/runtime'
import { ADDRESS_SCHEMA, IMPLEMENT_SCHEMA, PLAN_SCHEMA, REVIEW_SCHEMA, TASK_SCHEMA } from './schemas'

export * from './schemas'

export interface OpenThread {
  discussionId: string
  /** The folder of the repository, when there are several. */
  repo?: string | null
  path?: string | null
  line?: number | null
  author: string
  body: string
}

export interface PhaseRepo {
  /** The folder it sits in, under the working directory when there are several. */
  name: string
  path: string
  defaultBranch: string
  setupCommands?: string[]
  checkCommands?: string[]
  mrUrl?: string | null
}

export interface PhaseResource {
  kind: 'document' | 'link'
  title: string
  url: string
  subtitle?: string | null
  content?: string | null
}

export interface PhaseContext {
  issue?: { identifier: string; title: string; description: string | null; url: string | null }
  /** Documents and links attached to the issue in the tracker, which the agent has no way to open itself. */
  resources?: PhaseResource[]
  /** Everything the project allows. A ticket usually needs only some of these. */
  repos: PhaseRepo[]
  branch: string
  approvedPlan?: unknown
  planNotes?: string | null
  instructions?: string[]
  openThreads?: OpenThread[]
  ciFailures?: string[]
  adHocPrompt?: string
  previousSummary?: string | null
}

export interface PhaseTemplate {
  id: Phase
  policyMode: PermissionPolicy['mode']
  readOnlyRepo: boolean
  writes: boolean
  outputSchema?: JsonSchema
  instructions: string
  userPrompt(context: PhaseContext): string
}

const untrusted = (label: string, text: string) => `<${label}>\n${text}\n</${label}>`

const MAX_DOCUMENT_CHARS = 20_000
const MAX_RESOURCE_CHARS = 60_000

function resourcesBlock(resources: PhaseResource[]): string {
  let room = MAX_RESOURCE_CHARS
  const entries = resources.map((resource) => {
    const heading = `${resource.kind === 'document' ? 'Document' : 'Link'}: ${resource.title}${resource.subtitle ? ` (${resource.subtitle})` : ''}\n${resource.url}`
    if (resource.kind !== 'document') return heading
    const text = resource.content?.trim() || '(empty)'
    const fits = Math.max(0, Math.min(MAX_DOCUMENT_CHARS, room))
    room -= Math.min(text.length, fits)
    return `${heading}\n\n${text.length > fits ? `${text.slice(0, fits)}\n[${text.length - fits} more characters not shown]` : text}`
  })
  return `Attached to the issue:\n${untrusted('issue_resources', entries.join('\n\n'))}`
}

function issueBlock(context: PhaseContext): string {
  const issue = context.issue
  if (!issue) return ''
  const parts = [`Issue ${issue.identifier}: ${issue.title}`]
  if (issue.url) parts.push(`Tracker link: ${issue.url}`)
  parts.push(untrusted('issue_description', issue.description?.trim() || '(no description)'))
  if (context.resources?.length) parts.push(resourcesBlock(context.resources))
  return parts.join('\n')
}

function instructionsBlock(context: PhaseContext): string {
  if (!context.instructions?.length) return ''
  return `\n\nNew instructions from people on the issue, oldest first:\n${untrusted('human_comments', context.instructions.join('\n---\n'))}`
}

function threadsBlock(context: PhaseContext): string {
  if (!context.openThreads?.length) return 'There are no open review threads.'
  return context.openThreads
    .map((thread) => {
      const file = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ''}` : 'general'
      const where = thread.repo ? `${thread.repo}: ${file}` : file
      return `- discussionId=${thread.discussionId} (${where}) from ${thread.author}\n${untrusted('review_comment', thread.body)}`
    })
    .join('\n')
}

function commandList(commands: string[]): string {
  return commands.map((command) => `\`${command}\``).join(', ')
}

function checksBlock(context: PhaseContext): string {
  const only = context.repos.length === 1 ? context.repos[0] : undefined
  if (!only?.checkCommands?.length) return ''
  return `\n\nBefore you finish, run these checks and fix what they report:\n${only.checkCommands.map((command) => `- ${command}`).join('\n')}`
}

function reposBlock(context: PhaseContext, options: { writes?: boolean } = {}): string {
  if (context.repos.length <= 1) return ''
  const lines = context.repos.map((repo) => {
    const details = [`${repo.name}/ is ${repo.path}, based on origin/${repo.defaultBranch}`]
    if (options.writes && repo.setupCommands?.length) details.push(`setup: ${commandList(repo.setupCommands)}`)
    if (repo.checkCommands?.length) details.push(`checks: ${commandList(repo.checkCommands)}`)
    if (repo.mrUrl) details.push(`merge request: ${repo.mrUrl}`)
    return `- ${details.join('; ')}`
  })
  const scope = options.writes
    ? 'You may change any of them and nothing else, and most issues need only some of them. Leave the rest untouched. Run the setup of a repository, in order, before you work in it. Before you finish, run the checks of every repository you changed and fix what they report.'
    : 'Most issues need only some of them.'
  return `\n\nThis project allows work in several repositories. Your working directory holds one folder per repository, each on branch ${context.branch}:\n${lines.join('\n')}\nRun git and tests inside the folder they belong to. ${scope}`
}

const GIT_RULES = `Git rules for this environment:
- You are on branch the factory prepared. Commit your work to it with clear messages.
- Never push and never change remotes. You have no git credentials here; the factory pushes after you finish.
- Do not rewrite commits that already exist on the remote branch.
- When a project has several repositories, commit only in the ones this issue needs. Each one with commits gets its own merge request. Set mergeOrder to the folders you changed, in the order they must merge: what the others depend on goes first, and an earlier one must not need a later one to work. Leave mergeOrder empty when you changed one repository or none.`

export const PHASES: Record<Phase, PhaseTemplate> = {
  plan: {
    id: 'plan',
    policyMode: 'read_only',
    readOnlyRepo: true,
    writes: false,
    outputSchema: PLAN_SCHEMA,
    instructions: `You are in the planning phase. The repository is mounted read-only, so explore it and do not try to change anything.
Produce an implementation plan a teammate could review in a minute. Name the files you expect to touch, the risks, and any question a person must answer before you start.`,
    userPrompt: (context) =>
      `${issueBlock(context)}${instructionsBlock(context)}${reposBlock(context)}\n\nWrite the plan for this issue.${context.repos.length > 1 ? ' Plan only the repositories this issue needs, and start each entry in filesTouched with its folder.' : ''}`,
  },
  implement: {
    id: 'implement',
    policyMode: 'full',
    readOnlyRepo: false,
    writes: true,
    outputSchema: IMPLEMENT_SCHEMA,
    instructions: `You are in the implementation phase. Make the smallest change that fully solves the issue, follow the conventions of the repository, and add or update tests where the repository has them.
Run the project's checks before you finish and report what you ran and the result.

${GIT_RULES}`,
    userPrompt: (context) => {
      const plan = context.approvedPlan ? `\n\nA person approved this plan:\n${JSON.stringify(context.approvedPlan, null, 2)}` : ''
      const notes = context.planNotes ? `\n\nNotes from the approver:\n${untrusted('approver_notes', context.planNotes)}` : ''
      const only = context.repos.length === 1 ? context.repos[0] : undefined
      const where = only
        ? `You are on branch ${context.branch}, based on ${only.defaultBranch}.`
        : `You are on branch ${context.branch} in every repository.`
      return `${issueBlock(context)}${plan}${notes}${instructionsBlock(context)}${checksBlock(context)}${reposBlock(context, { writes: true })}\n\n${where} Implement the issue and commit your work.`
    },
  },
  review: {
    id: 'review',
    policyMode: 'read_only',
    readOnlyRepo: true,
    writes: false,
    outputSchema: REVIEW_SCHEMA,
    instructions: `You are the reviewer. The repository is mounted read-only with the merge request branch checked out.
Inspect the change with: git diff origin/<default-branch>...HEAD
Report only real problems: correctness, security, data loss, missing tests for risky behaviour. Skip style preferences the repository does not enforce.
Approve when nothing blocks merging. Every comment must point at a line that exists in the diff, using its line number in the new file (side "new") or the old file (side "old"). Set repo to the repository folder when the project has several, and leave it empty otherwise.`,
    userPrompt: (context) => {
      const failures = context.ciFailures?.length ? `\n\nFailing CI jobs:\n${context.ciFailures.join('\n')}` : ''
      const previous = context.previousSummary
        ? `\n\nThe author's summary of the change:\n${untrusted('author_summary', context.previousSummary)}`
        : ''
      const only = context.repos.length === 1 ? context.repos[0] : undefined
      const target = only
        ? `Merge request: ${only.mrUrl ?? 'not recorded'}\nCompare HEAD against origin/${only.defaultBranch} and give your verdict.`
        : 'The folders with a merge request listed above are the ones this issue changed. In each of them, compare HEAD against its base branch, and give one verdict for the whole change. Set repo on every comment to the folder it belongs to.'
      return `${issueBlock(context)}${previous}${failures}${reposBlock(context)}\n\n${target}`
    },
  },
  address_review: {
    id: 'address_review',
    policyMode: 'full',
    readOnlyRepo: false,
    writes: true,
    outputSchema: ADDRESS_SCHEMA,
    instructions: `You are addressing review feedback on your merge request. Go through every open thread.
Change code where a change is requested. Where nothing needs changing, say why in the reply. Mark a thread resolved only when you handled it.

${GIT_RULES}`,
    userPrompt: (context) => {
      const failures = context.ciFailures?.length ? `\n\nFailing CI jobs to fix:\n${context.ciFailures.join('\n')}` : ''
      return `${issueBlock(context)}${instructionsBlock(context)}\n\nOpen review threads:\n${threadsBlock(context)}${failures}${checksBlock(context)}${reposBlock(context, { writes: true })}\n\nAddress them on branch ${context.branch} and commit your work.`
    },
  },
  ad_hoc: {
    id: 'ad_hoc',
    policyMode: 'full',
    readOnlyRepo: false,
    writes: false,
    instructions: `You are running an ad-hoc task in a throwaway clone. Complete the request and summarize what you did. Nothing you do here is pushed.`,
    userPrompt: (context) => context.adHocPrompt ?? '',
  },
  task: {
    id: 'task',
    policyMode: 'full',
    readOnlyRepo: true,
    writes: false,
    outputSchema: TASK_SCHEMA,
    instructions: `You are working on this ticket in your own specialty, as your archetype describes. You are not here to implement it: the repositories are mounted read-only, and no branch or merge request comes out of this.
Investigate, run what helps, and use the network where it is allowed.
Your report is posted on the ticket as a comment, so it has to stand on its own: what you found, the evidence, and what you recommend.`,
    userPrompt: (context) =>
      `${issueBlock(context)}${instructionsBlock(context)}${reposBlock(context)}\n\nDo the work this ticket needs from you, then write your report.`,
  },
}
