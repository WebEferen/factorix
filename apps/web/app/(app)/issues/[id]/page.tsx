'use client'

import type { AuditEntryDto, DiscussionDto, IssueDetailDto, MergeRequestDto, RunDto } from '@factorix/schemas'
import { Ban, Bot, ExternalLink, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, MessageSquare, RotateCcw, Send } from 'lucide-react'
import Link from 'next/link'
import { use, useState } from 'react'
import { toast } from 'sonner'
import { AgentPicker, refreshIssueData } from '@/modules/issues/agent-picker'
import { ApprovalCard } from '@/modules/issues/approval-card'
import { FACTORY_STATE_LABEL, FactoryStateIcon, PRIORITY_LABEL, PriorityIcon, TrackerStateIcon } from '@/modules/issues/icons'
import { api } from '@/modules/lib/api'
import { useIssue } from '@/modules/lib/data'
import { fullDate, money, stepLabel, timeAgo, titleCase } from '@/modules/lib/format'
import { RunStateChip } from '@/modules/runs/run-state'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { Avatar, Button, Chip, CopyButton, ErrorState, ListSkeleton, SectionTitle, Textarea, Tooltip } from '@/modules/ui'
import { Boundary } from '@/modules/ui/boundary'
import { Markdown } from '@/modules/ui/markdown'
import { IssueWorkflowRuns, RunWorkflowButton } from '@/modules/workflows/issue-workflows'

function Property({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-2 text-sm">
      <span className="w-20 shrink-0 text-ink-2">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  )
}

function RunRow({ run }: { run: RunDto }) {
  return (
    <Link
      href={`/runs/${run.id}`}
      className="flex h-10 items-center gap-2.5 border-b border-divider px-3 text-sm transition-colors duration-75 last:border-b-0 hover:bg-softer"
    >
      <Avatar name={run.agentHandle} agent size={18} />
      <span className="min-w-0 flex-1 truncate">
        {titleCase(run.phase)}
        {run.attempt > 1 ? <span className="text-ink-3"> attempt {run.attempt}</span> : null}
        <span className="text-ink-2"> by {run.agentHandle}</span>
      </span>
      <span className="hidden w-16 shrink-0 text-right text-xs text-ink-2 sm:block">
        {run.costUsd ? `${run.costEstimated ? 'est. ' : ''}${money(run.costUsd)}` : ''}
      </span>
      <span className="flex w-28 shrink-0 justify-end">
        <RunStateChip state={run.state} />
      </span>
      <span className="w-7 text-right text-xs text-ink-3">{timeAgo(run.createdAt)}</span>
    </Link>
  )
}

function Discussion({ notes, showRepo }: { notes: DiscussionDto[]; showRepo: boolean }) {
  const first = notes[0] as DiscussionDto
  const repoPath = showRepo ? first.repoPath : null
  return (
    <div className="rounded-md border border-divider">
      {first.path || repoPath ? (
        <div className="flex items-center gap-2 border-b border-divider px-3 py-1.5 font-mono text-xs text-ink-2">
          <span className="min-w-0 truncate">
            {repoPath ? `${repoPath} ` : ''}
            {first.path}
            {first.line ? `:${first.line}` : ''}
          </span>
          {first.resolved ? (
            <Chip tone="success" className="ml-auto font-sans">
              Resolved
            </Chip>
          ) : null}
        </div>
      ) : null}
      <div className="divide-y divide-divider">
        {notes.map((note) => (
          <div key={note.id} className="flex gap-2.5 p-3">
            <Avatar name={note.author} agent={note.origin === 'factory'} size={20} />
            <div className="min-w-0 flex-1">
              <div className="mb-0.5 flex items-center gap-1.5 text-xs text-ink-2">
                <span className="text-ink">{note.author}</span>
                {note.origin === 'factory' ? <Chip>Factory</Chip> : null}
                <Tooltip label={fullDate(note.createdAt)}>
                  <span>{timeAgo(note.createdAt)}</span>
                </Tooltip>
              </div>
              <Markdown text={note.body} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function timelineText(entry: AuditEntryDto): string {
  const meta = entry.metadata as Record<string, string | undefined>
  switch (entry.action) {
    case 'pipeline.advanced':
      return meta.step ? `moved to ${stepLabel(meta.step)}` : 'advanced'
    case 'issue.assigned_to_agent':
      return `assigned ${meta.agent ?? 'an agent'}`
    case 'issue.created':
      return 'created this issue'
    case 'issue.retried':
      return 'retried this issue'
    case 'issue.cancelled':
      return 'cancelled this issue'
    case 'sync.conflict':
      return `left the tracker state alone because someone else changed it (wanted ${meta.wanted ?? 'a change'})`
    default:
      return titleCase(entry.action)
  }
}

function Instructions({ issueId }: { issueId: string }) {
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(false)
  const send = async () => {
    if (!body.trim()) return
    setLoading(true)
    try {
      await api.post(`/api/issues/${issueId}/instructions`, { body })
      setBody('')
      refreshIssueData()
      toast.success('The next run will read this')
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="rounded-md border border-divider bg-surface focus-within:border-signal">
      <Textarea
        className="min-h-16 border-0 shadow-none focus-visible:ring-0"
        placeholder="Add instructions for the next agent run"
        aria-label="Instructions for the next run"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void send()
        }}
      />
      <div className="flex justify-end p-1.5">
        <Button size="sm" loading={loading} disabled={!body.trim()} onClick={() => void send()}>
          <Send />
          Send
        </Button>
      </div>
    </div>
  )
}

function Activity({ timeline }: { timeline: AuditEntryDto[] }) {
  return (
    <ol className="flex flex-col gap-2.5">
      {timeline.map((entry, index, all) => {
        const previous = all[index - 1]
        if (previous && timelineText(previous) === timelineText(entry)) return null
        return (
          <li key={entry.id} className="flex items-center gap-2 text-sm text-ink-2">
            <Avatar name={entry.actorName ?? 'Factorix'} agent={entry.actorKind !== 'human'} size={18} />
            <span className="min-w-0 flex-1">
              <span className="text-ink">{entry.actorName ?? 'Factorix'}</span> {timelineText(entry)}
            </span>
            <Tooltip label={fullDate(entry.ts)}>
              <span className="shrink-0 text-xs text-ink-3">{timeAgo(entry.ts)}</span>
            </Tooltip>
          </li>
        )
      })}
    </ol>
  )
}

function MergeRequests({ items }: { items: MergeRequestDto[] }) {
  const [only] = items
  if (!only) return null
  if (items.length === 1)
    return (
      <Property label="MR">
        <GitPullRequest className="size-4 shrink-0 text-ink-2" />
        <a href={only.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 text-link hover:underline">
          !{only.iid}
          <span className="truncate text-ink-2">{only.state}</span>
          <ExternalLink className="size-3 shrink-0" />
        </a>
      </Property>
    )
  return (
    <div className="py-1 text-sm">
      <div className="mb-1 text-ink-2">Merge requests</div>
      <ul className="flex flex-col gap-1">
        {items.map((mr) => {
          const Icon = mr.state === 'merged' ? GitMerge : mr.state === 'closed' ? GitPullRequestClosed : GitPullRequest
          return (
            <li key={mr.url}>
              <a
                href={mr.url}
                target="_blank"
                rel="noreferrer"
                title={`${mr.repoPath}, ${mr.state}`}
                className="flex min-h-6 min-w-0 items-center gap-1.5 text-link hover:underline"
              >
                <Icon className="size-4 shrink-0 text-ink-2" />
                <span className="sr-only">{mr.state}:</span>
                <span className="min-w-0 truncate">{mr.repoPath.split('/').pop()}</span>
                <span className="shrink-0 text-ink-2">!{mr.iid}</span>
                <ExternalLink className="size-3 shrink-0" />
              </a>
              {mr.revert ? (
                <div className="pl-5.5 text-xs text-ink-2">
                  {mr.revert.url ? (
                    <a href={mr.revert.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
                      Revert
                    </a>
                  ) : (
                    'Revert'
                  )}{' '}
                  {mr.revert.state}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function IssueDetails({ issue, assigned, inFlight }: { issue: IssueDetailDto; assigned: string | null | undefined; inFlight: boolean }) {
  return (
    <>
      <Property label="Factory">
        <FactoryStateIcon state={issue.group} />
        <span className="truncate">{FACTORY_STATE_LABEL[issue.group]}</span>
        {issue.pipelineStep && inFlight && stepLabel(issue.pipelineStep) !== FACTORY_STATE_LABEL[issue.group] ? (
          <span className="truncate text-xs text-ink-3">{stepLabel(issue.pipelineStep)}</span>
        ) : null}
      </Property>
      {issue.waitingFor ? (
        <Property label="Waiting on">
          <Chip tone="info">{issue.waitingFor === 'ci' ? 'CI' : issue.waitingFor}</Chip>
        </Property>
      ) : null}
      <Property label="Tracker">
        <TrackerStateIcon type={issue.trackerStateType} />
        <span className="truncate">{issue.trackerStateName ?? 'Unknown'}</span>
      </Property>
      <Property label="Priority">
        <PriorityIcon priority={issue.priority} />
        {PRIORITY_LABEL[issue.priority]}
      </Property>
      <Property label="Agent">
        <AgentPicker
          issue={issue}
          trigger={
            <Button variant="ghost" size="sm" className="-ml-2 max-w-full justify-start text-ink">
              {assigned ? <Avatar name={assigned} agent size={18} /> : <Bot />}
              <span className="truncate">{assigned ?? 'Assign an agent'}</span>
            </Button>
          }
        />
      </Property>
      {issue.assigneeName ? (
        <Property label="Assignee">
          <Avatar name={issue.assigneeName} size={18} />
          <span className="truncate">{issue.assigneeName}</span>
        </Property>
      ) : null}
      {issue.labels.length > 0 ? (
        <Property label="Labels">
          <span className="flex flex-wrap gap-1 py-1">
            {issue.labels.map((label) => (
              <Chip key={label.id} tone="outline">
                {label.name}
              </Chip>
            ))}
          </span>
        </Property>
      ) : null}
      <div className="my-3 h-px bg-divider" />
      {issue.branchName ? (
        <Property label="Branch">
          <GitBranch className="size-4 shrink-0 text-ink-2" />
          <span className="min-w-0 truncate font-mono text-xs">{issue.branchName}</span>
          <CopyButton value={issue.branchName} />
        </Property>
      ) : null}
      <MergeRequests items={issue.mergeRequests} />
      {issue.trackerUrl ? (
        <Property label="Linear">
          <a href={issue.trackerUrl} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 text-link hover:underline">
            {issue.identifier}
            <ExternalLink className="size-3 shrink-0" />
          </a>
        </Property>
      ) : null}
    </>
  )
}

export default function IssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { data, error, mutate } = useIssue(id)
  const issue = data?.issue
  const action = async (path: string, message: string) => {
    try {
      await api.post(`/api/issues/${id}/${path}`)
      refreshIssueData()
      toast.success(message)
    } catch (caught) {
      toast.error((caught as Error).message)
    }
  }

  if (error && !issue)
    return (
      <>
        <PageHeader crumbs={[{ label: 'Issues', href: '/issues' }]} />
        <ErrorState error={error} retry={() => void mutate()} />
      </>
    )
  if (!issue)
    return (
      <>
        <PageHeader crumbs={[{ label: 'Issues', href: '/issues' }]} />
        <ListSkeleton rows={6} />
      </>
    )

  const pending = issue.approvals.filter((approval) => approval.status === 'pending')
  const threads = [...new Set(issue.discussions.filter((note) => note.origin !== 'system').map((note) => note.discussionId))].map((discussionId) =>
    issue.discussions.filter((note) => note.discussionId === discussionId),
  )
  const inFlight = ['queued', 'active', 'waiting_human', 'awaiting_merge'].includes(issue.factoryState)
  const canRetry = !issue.closed && (issue.factoryState === 'failed' || issue.factoryState === 'cancelled')
  const failure = issue.factoryState === 'failed' ? issue.runs.find((run) => run.state === 'failed') : undefined
  const assigned = issue.assignedAgentHandle

  return (
    <>
      <PageHeader crumbs={[{ label: issue.project.name, href: `/projects/${issue.projectId}` }, { label: issue.identifier }]}>
        <RunWorkflowButton issueId={issue.id} projectId={issue.projectId} />
        {canRetry ? (
          <Button size="sm" onClick={() => void action('retry', 'Back in the factory')}>
            <RotateCcw />
            Retry
          </Button>
        ) : null}
        {inFlight ? (
          <Button size="sm" variant="danger" onClick={() => void action('cancel', 'Cancelled')}>
            <Ban />
            Cancel
          </Button>
        ) : null}
      </PageHeader>
      <div className="flex min-h-0 flex-1 flex-col-reverse lg:flex-row">
        <PageBody className="lg:border-r lg:border-divider">
          <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-6">
            <div>
              <h1 className="text-xl font-semibold">{issue.title}</h1>
              {issue.description ? (
                <Markdown text={issue.description} className="mt-3" />
              ) : (
                <p className="mt-3 text-sm text-ink-3">No description.</p>
              )}
            </div>
            {pending.length > 0 ? (
              <Boundary label="what needs your decision" resetKey={issue.updatedAt}>
                <div className="flex flex-col gap-3">
                  {pending.map((approval) => (
                    <ApprovalCard key={approval.id} approval={approval} />
                  ))}
                </div>
              </Boundary>
            ) : null}
            {failure?.error ? (
              <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm">
                <p className="font-semibold text-danger-ink">{titleCase(failure.phase)} failed</p>
                <p className="mt-1 break-words">{failure.error.message}</p>
                <Link href={`/runs/${failure.id}`} className="mt-1.5 inline-block text-xs text-link hover:underline">
                  See what the agent did
                </Link>
              </div>
            ) : null}
            {issue.runs.length > 0 ? (
              <section>
                <SectionTitle>Runs</SectionTitle>
                <div className="overflow-hidden rounded-md border border-divider">
                  {issue.runs.map((run) => (
                    <RunRow key={run.id} run={run} />
                  ))}
                </div>
              </section>
            ) : null}
            <IssueWorkflowRuns issueId={issue.id} />
            {threads.length > 0 ? (
              <section>
                <SectionTitle>Merge request discussion</SectionTitle>
                <Boundary label="the discussion" resetKey={issue.updatedAt}>
                  <div className="flex flex-col gap-3">
                    {threads.map((notes) => (
                      <Discussion key={notes[0]?.discussionId} notes={notes} showRepo={issue.mergeRequests.length > 1} />
                    ))}
                  </div>
                </Boundary>
              </section>
            ) : null}
            <section>
              <SectionTitle>Instructions</SectionTitle>
              {issue.instructions.length > 0 ? (
                <ul className="mb-3 flex flex-col gap-2">
                  {issue.instructions.map((instruction) => (
                    <li key={instruction.id} className="flex gap-2.5 text-sm">
                      <MessageSquare className="mt-0.5 size-4 shrink-0 text-ink-3" />
                      <div className="min-w-0">
                        <span className="text-ink-2">{instruction.author ?? 'Someone'}</span>
                        {instruction.consumed ? <span className="text-xs text-ink-3"> read by an agent</span> : null}
                        <Markdown text={instruction.body} />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
              <Instructions issueId={id} />
            </section>
            <section>
              <SectionTitle>Activity</SectionTitle>
              <Boundary label="the activity" resetKey={issue.updatedAt}>
                <Activity timeline={issue.timeline} />
              </Boundary>
            </section>
          </div>
        </PageBody>
        <aside className="shrink-0 border-b border-divider p-4 lg:w-72 lg:border-b-0">
          <Boundary label="the details" resetKey={issue.updatedAt}>
            <IssueDetails issue={issue} assigned={assigned} inFlight={inFlight} />
          </Boundary>
        </aside>
      </div>
    </>
  )
}
