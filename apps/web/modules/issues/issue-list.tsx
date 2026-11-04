'use client'

import { ISSUE_GROUP_ORDER, type IssueDto, type IssueGroupDto, type IssueListDto, type IssueSort } from '@factorix/schemas'
import { Bot, GitMerge, GitPullRequest } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useIssues } from '../lib/data'
import { cn, fullDate, timeAgo } from '../lib/format'
import { useListKeys } from '../shell/use-list-keys'
import { Avatar, Button, Chip, Skeleton, Tooltip } from '../ui'
import { Boundary } from '../ui/boundary'
import { AgentPicker } from './agent-picker'
import { FACTORY_STATE_LABEL, FactoryStateIcon, PRIORITY_LABEL, PriorityIcon, TrackerStateIcon } from './icons'

function visibleLabels(issue: IssueDto) {
  return issue.labels.filter((label) => label.name !== issue.assignedAgentHandle)
}

function MergeRequestBadge({ issue }: { issue: IssueDto }) {
  const [first] = issue.mergeRequests
  if (!first) return null
  const several = issue.mergeRequests.length > 1
  const merged = issue.mergeRequests.every((mr) => mr.state === 'merged')
  const label = issue.mergeRequests.map((mr) => `${several ? `${mr.repoPath} ` : 'Merge request '}!${mr.iid}, ${mr.state}`).join('. ')
  return (
    <Tooltip label={label}>
      <span className="hidden items-center gap-1 text-xs text-ink-2 sm:flex">
        {merged ? <GitMerge className="size-3.5" /> : <GitPullRequest className="size-3.5" />}
        {several ? `${issue.mergeRequests.length} MRs` : `!${first.iid}`}
      </span>
    </Tooltip>
  )
}

function IssueTime({ issue, created, className }: { issue: IssueDto; created: boolean; className: string }) {
  const value = created ? issue.createdAt : issue.updatedAt
  return (
    <Tooltip label={`${created ? 'Created' : 'Updated'} ${fullDate(value)}`}>
      <span className={className}>{timeAgo(value)}</span>
    </Tooltip>
  )
}

function IssueRow({
  issue,
  selected,
  showProject,
  showCreated,
  onHover,
  rowRef,
}: {
  issue: IssueDto
  selected: boolean
  showProject?: boolean
  showCreated: boolean
  onHover: () => void
  rowRef?: (element: HTMLAnchorElement | null) => void
}) {
  const agentLabel = issue.assignedAgentHandle ? `Assigned to ${issue.assignedAgentHandle}` : 'Assign an agent'
  return (
    <Link
      ref={rowRef}
      href={`/issues/${issue.id}`}
      onMouseEnter={onHover}
      className={cn(
        'group flex h-10 items-center gap-2.5 border-b border-divider px-4 transition-colors duration-75',
        selected ? 'bg-soft' : 'hover:bg-softer',
      )}
    >
      <Tooltip label={PRIORITY_LABEL[issue.priority] ?? 'No priority'}>
        <span className="flex">
          <PriorityIcon priority={issue.priority} />
        </span>
      </Tooltip>
      <span className="hidden w-16 shrink-0 truncate text-sm text-ink-2 sm:block">{issue.identifier}</span>
      <Tooltip label={issue.trackerStateName ?? 'Tracker state'}>
        <span className="flex">
          <TrackerStateIcon type={issue.trackerStateType} />
        </span>
      </Tooltip>
      <span className="min-w-0 flex-1 truncate text-sm">{issue.title}</span>
      {issue.factoryState === 'waiting_human' ? <Chip tone="warning">Needs you</Chip> : null}
      {issue.factoryState === 'failed' ? <Chip tone="danger">Failed</Chip> : null}
      <span className="hidden items-center gap-1 lg:flex">
        {visibleLabels(issue)
          .slice(0, 2)
          .map((label) => (
            <Chip key={label.id} tone="outline">
              {label.name}
            </Chip>
          ))}
      </span>
      {showProject && issue.projectName ? <span className="hidden max-w-32 truncate text-xs text-ink-3 lg:block">{issue.projectName}</span> : null}
      <MergeRequestBadge issue={issue} />
      <Tooltip label={FACTORY_STATE_LABEL[issue.group]}>
        <span className="flex">
          <FactoryStateIcon state={issue.group} />
        </span>
      </Tooltip>
      <span onClick={(event) => event.preventDefault()} className="flex">
        <AgentPicker
          issue={issue}
          label={agentLabel}
          trigger={
            <button
              type="button"
              aria-label={agentLabel}
              className="flex size-6 items-center justify-center rounded-sm text-ink-3 transition-colors duration-75 hover:bg-soft hover:text-ink"
            >
              {issue.assignedAgentHandle ? <Avatar name={issue.assignedAgentHandle} agent size={18} /> : <Bot className="size-4" />}
            </button>
          }
        />
      </span>
      <IssueTime issue={issue} created={showCreated} className="w-7 shrink-0 text-right text-xs text-ink-3" />
    </Link>
  )
}

export function IssueList({
  issues,
  grouped = true,
  showProject,
  counts,
  sort,
}: {
  issues: IssueDto[]
  grouped?: boolean
  showProject?: boolean
  counts?: IssueListDto['counts']
  sort?: IssueSort
}) {
  const router = useRouter()
  const ordered = grouped ? ISSUE_GROUP_ORDER.flatMap((state) => issues.filter((issue) => issue.group === state)) : issues
  const open = useCallback((issue: IssueDto) => router.push(`/issues/${issue.id}`), [router])
  const { selected, setSelected } = useListKeys(ordered, open)
  const rows = useRef<(HTMLAnchorElement | null)[]>([])
  useEffect(() => {
    rows.current[selected]?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  let index = -1
  const row = (issue: IssueDto) => {
    index += 1
    const position = index
    return (
      <IssueRow
        key={issue.id}
        issue={issue}
        showProject={showProject}
        showCreated={sort === 'created'}
        selected={selected === position}
        onHover={() => setSelected(position)}
        rowRef={(element) => {
          rows.current[position] = element
        }}
      />
    )
  }

  if (!grouped) return <div>{ordered.map(row)}</div>
  return (
    <div>
      {ISSUE_GROUP_ORDER.map((state) => {
        const group = issues.filter((issue) => issue.group === state)
        if (group.length === 0) return null
        return (
          <section key={state}>
            <h3 className="sticky top-0 z-10 flex h-8 items-center gap-2 border-b border-divider bg-softer px-4 text-sm">
              <FactoryStateIcon state={state} />
              {FACTORY_STATE_LABEL[state]}
              <span className="text-xs text-ink-3 tabular-nums">{counts?.[state] ?? group.length}</span>
            </h3>
            {group.map(row)}
          </section>
        )
      })}
    </div>
  )
}

const BOARD_COLUMNS: { title: string; states: IssueGroupDto[]; icon: IssueGroupDto }[] = [
  { title: 'Not started', states: ['untracked'], icon: 'untracked' },
  { title: 'In progress', states: ['queued', 'active'], icon: 'active' },
  { title: 'Needs you', states: ['waiting_human', 'failed'], icon: 'waiting_human' },
  { title: 'Awaiting merge', states: ['awaiting_merge'], icon: 'awaiting_merge' },
  { title: 'Done', states: ['done', 'cancelled', 'closed'], icon: 'done' },
]

const BOARD_PAGE = 30

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-divider bg-surface p-2.5">
      <Skeleton className="h-3 w-12" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  )
}

function BoardColumn({
  column,
  query,
  loading,
}: {
  column: (typeof BOARD_COLUMNS)[number]
  query: Record<string, string | string[] | undefined>
  loading?: boolean
}) {
  const [limit, setLimit] = useState(BOARD_PAGE)
  const picked = [query.factoryState ?? []].flat()
  const states = picked.length > 0 ? column.states.filter((state) => picked.includes(state)) : column.states
  // The API caps a page at 200, which is plenty for one column on a board.
  const { data } = useIssues(states.length > 0 ? { ...query, factoryState: states, limit: String(Math.min(limit, 200)) } : null)
  const cards = data?.issues ?? []
  return (
    <section className="flex h-full w-72 flex-col rounded-lg bg-softer">
      <h3 className="flex h-9 shrink-0 items-center gap-2 px-3 text-sm">
        <FactoryStateIcon state={column.icon} />
        {column.title}
        <span className="text-xs text-ink-3 tabular-nums">{states.length > 0 ? (data?.total ?? '') : 0}</span>
      </h3>
      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-1.5">
        {cards.map((issue) => (
          <Link
            key={issue.id}
            href={`/issues/${issue.id}`}
            className="flex flex-col gap-2 rounded-md border border-divider bg-surface p-2.5 shadow-control transition-colors duration-100 hover:border-field"
          >
            <span className="flex items-center gap-2 text-xs text-ink-2">
              {issue.identifier}
              <span className="ml-auto">
                {issue.assignedAgentHandle ? (
                  <Tooltip label={issue.assignedAgentHandle}>
                    <span className="flex">
                      <Avatar name={issue.assignedAgentHandle} agent size={18} />
                    </span>
                  </Tooltip>
                ) : null}
              </span>
            </span>
            <span className="line-clamp-2 text-sm">{issue.title}</span>
            <span className="flex flex-wrap items-center gap-1.5">
              <PriorityIcon priority={issue.priority} />
              {issue.factoryState === 'failed' ? <Chip tone="danger">Failed</Chip> : null}
              {issue.factoryState === 'waiting_human' ? <Chip tone="warning">Needs you</Chip> : null}
              {issue.factoryState === 'cancelled' ? <Chip>Cancelled</Chip> : null}
              <MergeRequestBadge issue={issue} />
              <IssueTime issue={issue} created={query.sort === 'created'} className="ml-auto text-xs text-ink-3" />
            </span>
          </Link>
        ))}
        {!data && states.length > 0 ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : null}
        {loading && column.states.includes('untracked') && cards.length < limit ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : null}
        {data && data.total > cards.length && limit < 200 ? (
          <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setLimit(limit + BOARD_PAGE)}>
            Show more
          </Button>
        ) : null}
      </div>
    </section>
  )
}

export function IssueBoard({ query, loading }: { query: Record<string, string | string[] | undefined>; loading?: boolean }) {
  return (
    <div className="flex h-full min-w-max gap-3 p-3">
      {BOARD_COLUMNS.map((column) => (
        <Boundary key={column.title} label={`the ${column.title} column`}>
          <BoardColumn column={column} query={query} loading={loading} />
        </Boundary>
      ))}
    </div>
  )
}
