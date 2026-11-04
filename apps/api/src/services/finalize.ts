import type { ScmConnector } from '@factorix/connectors'
import { type AddressOutput, formatScmBody, type ImplementOutput, type ReviewOutput, type TaskOutput } from '@factorix/core'
import type { Db, IssueRow, ProjectRow, RunRow } from '@factorix/db'
import type { RunEventBody, RunOutcome } from '@factorix/runtime'
import type { SandboxProvider, StepResult, Workspace } from '@factorix/sandbox'
import { emit } from '../lib/outbox'
import { type LinkedMergeRequest, mergeRequestsOf } from './repos'
import { syncDiscussions } from './scm-sync'
import type { SpecRepo } from './spec'

const MAX_DIFF_CHARS = 1_000_000

export class StepFailed extends Error {
  constructor(
    readonly op: string,
    readonly result: StepResult,
  ) {
    super(`${op} failed with exit code ${result.exitCode}: ${result.stderr.slice(-2000)}`)
  }
}

export interface WorkRepo extends SpecRepo {
  id: string | null
  scmRepoId: string | null
  url: string
  setupCommands: string[]
  env: Record<string, string>
}

export interface FinalizeContext {
  db: Db
  sandbox: SandboxProvider
  workspace: Workspace
  run: RunRow
  issue: IssueRow | null
  project: ProjectRow | null
  scm: ScmConnector | null
  gitToken?: string
  repos: WorkRepo[]
  branch: string
  agentHandle: string
  outcome: RunOutcome
  structuredOutput: unknown
  log: (body: RunEventBody) => void
  /** Reruns mirror-fetch and checkout for one repository, used when a human pushed to its branch during the run. */
  refresh: (repo: WorkRepo) => Promise<{ conflicts: string[] }>
}

export interface FinalizeResult {
  result: string
  diff?: string
}

async function step(context: FinalizeContext, repo: WorkRepo, op: 'bundle' | 'push' | 'diff', gitToken?: string): Promise<StepResult> {
  return context.sandbox.runStep(context.workspace, { op, env: repo.env, gitToken })
}

async function captureDiff(context: FinalizeContext): Promise<string | undefined> {
  const parts: string[] = []
  for (const repo of context.repos) {
    const diff = await step(context, repo, 'diff')
    if (diff.exitCode === 0) parts.push(diff.stdout)
    else
      context.log({
        type: 'log',
        level: 'warn',
        source: 'finalize',
        message: `Could not capture the diff of ${repo.name}: ${diff.stderr.slice(-500)}`,
      })
  }
  return parts.length > 0 ? parts.join('').slice(0, MAX_DIFF_CHARS) : undefined
}

function mergeRequestBody(context: FinalizeContext, output: Partial<ImplementOutput> | undefined): string {
  const { issue, run, agentHandle } = context
  const sections: string[] = []
  if (output?.summary) sections.push(`## Summary\n\n${output.summary}`)
  if (output?.approach) sections.push(`## Approach\n\n${output.approach}`)
  if (output?.testing) sections.push(`## Testing\n\n${output.testing}`)
  if (output?.notes) sections.push(`## Notes\n\n${output.notes}`)
  if (issue?.trackerUrl) sections.push(`Closes ${issue.trackerUrl}`)
  return formatScmBody(sections.join('\n\n') || `Implements ${issue?.identifier}.`, run.id, agentHandle)
}

interface PushOutcome {
  repo: WorkRepo
  pushed: boolean
  /** The branch has work the base lacks, even if an earlier attempt already pushed it. */
  ahead: boolean
}

async function pushWork(context: FinalizeContext, repo: WorkRepo): Promise<PushOutcome> {
  const bundled = await step(context, repo, 'bundle')
  if (bundled.exitCode !== 0) throw new StepFailed('bundle', bundled)
  const ahead = Number(bundled.values.AHEAD ?? 0) > 0
  if (bundled.values.CHANGED !== '1') return { repo, pushed: false, ahead }

  const pushed = await step(context, repo, 'push', context.gitToken)
  if (pushed.exitCode === 0) return { repo, pushed: true, ahead: true }
  if (pushed.values.PUSH_REJECTED !== '1') throw new StepFailed('push', pushed)

  context.log({
    type: 'log',
    level: 'warn',
    source: 'finalize',
    message: `The branch in ${repo.name} moved during the run. Rebasing and pushing again.`,
  })
  const { conflicts } = await context.refresh(repo)
  if (conflicts.length > 0)
    throw new StepFailed('push', { ...pushed, stderr: 'The branch moved during the run and the agent commits do not rebase cleanly onto it.' })
  const rebundled = await step(context, repo, 'bundle')
  if (rebundled.exitCode !== 0) throw new StepFailed('bundle', rebundled)
  const again = await step(context, repo, 'push', context.gitToken)
  if (again.exitCode !== 0) throw new StepFailed('push', again)
  return { repo, pushed: true, ahead: true }
}

/** Runs after every push succeeds, so a failed push never leaves a merge request for half a change, and a retry opens what is missing. */
async function openMissingMergeRequests(context: FinalizeContext, outcomes: PushOutcome[]): Promise<number> {
  const { issue, scm, run, db } = context
  if (!issue || !scm) return 0
  const existing = await mergeRequestsOf(db, issue.id)
  let opened = 0
  for (const { repo, pushed, ahead } of outcomes) {
    if (!repo.id || !repo.scmRepoId) continue
    const current = existing.find((mr) => mr.repoId === repo.id)
    // A squash merge never makes the branch an ancestor of the base, so a finished merge request only reopens for new commits.
    if (current ? !pushed || current.mrState === 'opened' : !pushed && !ahead) continue
    const mr =
      (await scm.findOpenMergeRequest(repo.scmRepoId, context.branch)) ??
      (await scm.openMergeRequest({
        repoId: repo.scmRepoId,
        sourceBranch: context.branch,
        targetBranch: repo.baseBranch,
        title: `${issue.identifier}: ${issue.title}`,
        description: mergeRequestBody(context, context.structuredOutput as Partial<ImplementOutput> | undefined),
      }))
    await db.transaction(async (trx) => {
      await trx('issue_merge_requests')
        .insert({
          orgId: run.orgId,
          issueId: issue.id,
          repoId: repo.id,
          repoPath: repo.path,
          mrId: mr.id,
          mrIid: mr.iid,
          mrUrl: mr.url,
          mrState: mr.state,
        })
        .onConflict(['issue_id', 'repo_id'])
        .merge({ mrId: mr.id, mrIid: mr.iid, mrUrl: mr.url, mrState: mr.state, updatedAt: trx.fn.now() })
      await trx('issues').where({ id: issue.id }).update({ updatedAt: trx.fn.now() })
      await emit(trx, run.orgId, { type: 'workflow.event', issueId: issue.id, event: { kind: 'merge_request', event: 'opened', url: mr.url } })
      await emit(trx, run.orgId, {
        type: 'tracker.comment',
        issueId: issue.id,
        template: 'mr_opened',
        runId: run.id,
        agentHandle: context.agentHandle,
        body: mr.url,
      })
    })
    opened += 1
    context.log({ type: 'log', level: 'info', source: 'finalize', message: `Opened merge request !${mr.iid} in ${repo.path}: ${mr.url}` })
  }
  return opened
}

/** The ticket decides what merges first. Agent output is untrusted, so a name only counts if it matches a merge request of this issue. */
async function applyMergeOrder(context: FinalizeContext, order: unknown): Promise<boolean> {
  const { issue, db } = context
  if (!issue || !Array.isArray(order) || order.length === 0) return false
  let changed = false
  for (const mr of await mergeRequestsOf(db, issue.id)) {
    const index = order.indexOf(mr.repo.name)
    const mergePosition = index === -1 ? null : index
    if (mergePosition === mr.mergePosition) continue
    await db('issue_merge_requests').where({ id: mr.id }).update({ mergePosition, updatedAt: db.fn.now() })
    changed = true
  }
  return changed
}

async function settleMergeRequests(context: FinalizeContext, outcomes: PushOutcome[]): Promise<void> {
  const opened = await openMissingMergeRequests(context, outcomes)
  const reordered = await applyMergeOrder(context, (context.structuredOutput as { mergeOrder?: unknown } | undefined)?.mergeOrder)
  if (opened > 0 || reordered) await linkSiblings(context)
}

/** A reviewer in one repository has to know the change continues in another, and which merges first. */
async function linkSiblings(context: FinalizeContext): Promise<void> {
  const { issue, scm, db, run, agentHandle } = context
  if (!issue || !scm) return
  const all = await mergeRequestsOf(db, issue.id)
  if (all.length < 2) return
  const list = all.map((mr, index) => `${index + 1}. ${mr.mrUrl}`).join('\n')
  for (const mr of all) {
    await scm
      .postNote(
        mr.repo.scmRepoId,
        mr.mrIid,
        formatScmBody(`${issue.identifier} spans ${all.length} repositories. Merge in this order:\n\n${list}`, run.id, agentHandle),
      )
      .catch((error: Error) =>
        context.log({
          type: 'log',
          level: 'warn',
          source: 'finalize',
          message: `Could not link the merge requests on ${mr.mrUrl}: ${error.message}`,
        }),
      )
  }
}

async function finalizeWrites(context: FinalizeContext): Promise<FinalizeResult> {
  const { issue, project, scm, run, db } = context
  if (!issue || !project || !scm) throw new Error('A writing phase needs an issue, a project, and an SCM connection')
  const outcomes: PushOutcome[] = []
  for (const repo of context.repos) outcomes.push(await pushWork(context, repo))
  const diff = await captureDiff(context)

  if (run.phase === 'address_review') {
    await applyThreadReplies(context, context.structuredOutput as AddressOutput | undefined)
    await db('issue_instructions').where({ issueId: issue.id }).whereNull('consumedByRunId').update({ consumedByRunId: run.id })
    await settleMergeRequests(context, outcomes)
    return { result: outcomes.some((outcome) => outcome.pushed) ? 'completed' : 'no_changes', diff }
  }

  const hasWork = outcomes.some((outcome) => outcome.pushed || outcome.ahead) || (await mergeRequestsOf(db, issue.id)).length > 0
  if (!hasWork) return { result: 'no_changes', diff }
  await db('issue_instructions').where({ issueId: issue.id }).whereNull('consumedByRunId').update({ consumedByRunId: run.id })
  await settleMergeRequests(context, outcomes)
  return { result: 'completed', diff }
}

async function applyThreadReplies(context: FinalizeContext, output: AddressOutput | undefined): Promise<void> {
  const { issue, scm, run, agentHandle, db } = context
  if (!issue || !scm) return
  const mergeRequests = await mergeRequestsOf(db, issue.id)
  if (mergeRequests.length === 0) return
  const owners = new Map(
    (
      (await db('mr_discussions').where({ issueId: issue.id }).distinct('discussion_id', 'repo_id')) as {
        discussionId: string
        repoId: string | null
      }[]
    ).map((row) => [row.discussionId, row.repoId]),
  )
  for (const thread of output?.threads ?? []) {
    const mr = mergeRequests.find((candidate) => candidate.repoId === owners.get(thread.discussionId)) ?? mergeRequests[0]
    if (!mr) continue
    try {
      if (thread.reply) await scm.replyDiscussion(mr.repo.scmRepoId, mr.mrIid, thread.discussionId, formatScmBody(thread.reply, run.id, agentHandle))
      if (thread.resolved) await scm.resolveDiscussion(mr.repo.scmRepoId, mr.mrIid, thread.discussionId, true)
    } catch (error) {
      context.log({
        type: 'log',
        level: 'warn',
        source: 'finalize',
        message: `Could not update thread ${thread.discussionId}: ${(error as Error).message}`,
      })
    }
  }
  for (const mr of mergeRequests) await syncDiscussions(db, scm, issue, mr).catch(() => undefined)
}

async function finalizeReview(context: FinalizeContext): Promise<FinalizeResult> {
  const { issue, scm, run, agentHandle, db } = context
  const output = context.structuredOutput as ReviewOutput | undefined
  if (!issue || !scm) throw new Error('A review needs an open merge request')
  const mergeRequests = await mergeRequestsOf(db, issue.id)
  const first = mergeRequests[0]
  if (!first) throw new Error('A review needs an open merge request')
  if (!output?.verdict) throw new Error('The reviewer finished without a structured verdict')

  const details = new Map<string, Awaited<ReturnType<ScmConnector['getMergeRequest']>>>()
  for (const comment of output.comments ?? []) {
    const target: LinkedMergeRequest = mergeRequests.find((mr) => mr.repo.name === comment.repo) ?? first
    const body = formatScmBody(`**${comment.severity}:** ${comment.body}`, run.id, agentHandle)
    try {
      if (comment.repo && target.repo.name !== comment.repo && mergeRequests.length > 1) throw new Error(`no merge request in ${comment.repo}`)
      const mr = details.get(target.id) ?? (await scm.getMergeRequest(target.repo.scmRepoId, target.mrIid))
      details.set(target.id, mr)
      if (!mr.diffRefs) throw new Error('merge request has no diff refs yet')
      await scm.postDiffDiscussion(target.repo.scmRepoId, target.mrIid, {
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body,
        diffRefs: mr.diffRefs,
      })
    } catch (error) {
      context.log({
        type: 'log',
        level: 'warn',
        source: 'finalize',
        message: `Inline comment on ${comment.path}:${comment.line} was refused, posting it as a note: ${(error as Error).message}`,
      })
      await scm.postNote(
        target.repo.scmRepoId,
        target.mrIid,
        formatScmBody(`\`${comment.path}:${comment.line}\`\n\n${comment.body}`, run.id, agentHandle),
      )
    }
  }
  for (const mr of mergeRequests) {
    await scm.postNote(
      mr.repo.scmRepoId,
      mr.mrIid,
      formatScmBody(
        `**Review verdict: ${output.verdict === 'approve' ? 'approve' : 'changes requested'}**\n\n${output.summary}`,
        run.id,
        agentHandle,
      ),
    )
    if (output.verdict === 'approve') {
      const approved = await scm.approve(mr.repo.scmRepoId, mr.mrIid)
      if (!approved)
        context.log({
          type: 'log',
          level: 'info',
          source: 'finalize',
          message: 'GitLab refused the approval, which is expected when the same bot authored the merge request. The verdict still counts.',
        })
    }
    await syncDiscussions(db, scm, issue, mr).catch((error: Error) =>
      context.log({ type: 'log', level: 'warn', source: 'finalize', message: `Could not mirror discussions: ${error.message}` }),
    )
  }
  await emit(db, run.orgId, {
    type: 'tracker.comment',
    issueId: issue.id,
    template: 'review_verdict',
    runId: run.id,
    agentHandle,
    body: `${output.verdict === 'approve' ? 'Approved' : 'Changes requested'}: ${output.summary}`,
  })
  return { result: `verdict:${output.verdict}` }
}

async function finalizeTask({ db, run, issue, agentHandle, structuredOutput }: FinalizeContext): Promise<FinalizeResult> {
  const report = (structuredOutput as TaskOutput | undefined)?.summary
  if (!issue) throw new Error('A task needs a ticket')
  if (!report) throw new Error('The agent finished without a report')
  await emit(db, run.orgId, { type: 'tracker.comment', issueId: issue.id, template: 'task_report', runId: run.id, agentHandle, body: report })
  return { result: 'completed' }
}

export async function finalizePhase(context: FinalizeContext): Promise<FinalizeResult> {
  const { run, outcome } = context
  const stoppedEarly = outcome !== 'completed'

  if (run.phase === 'ad_hoc') {
    for (const repo of context.repos) {
      const bundled = await step(context, repo, 'bundle')
      if (bundled.exitCode !== 0) throw new StepFailed('bundle', bundled)
    }
    return { result: stoppedEarly ? 'failed' : 'completed', diff: await captureDiff(context) }
  }

  if (run.phase === 'implement' || run.phase === 'address_review') {
    if (stoppedEarly) {
      // Partial work stays reachable on the branch, unless a person asked to throw it away.
      if (!run.discardOnCancel)
        for (const repo of context.repos)
          await pushWork(context, repo).catch((error: Error) =>
            context.log({
              type: 'log',
              level: 'warn',
              source: 'finalize',
              message: `Could not push unfinished work in ${repo.name}: ${error.message}`,
            }),
          )
      return { result: 'failed', diff: await captureDiff(context).catch(() => undefined) }
    }
    return finalizeWrites(context)
  }

  if (stoppedEarly) return { result: 'failed' }
  if (run.phase === 'review') return finalizeReview(context)
  if (run.phase === 'task') return finalizeTask(context)
  return { result: 'completed' }
}
