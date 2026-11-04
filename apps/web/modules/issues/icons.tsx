import type { IssueGroupDto } from '@factorix/schemas'
import { cn } from '../lib/format'

export const FACTORY_STATE_LABEL: Record<IssueGroupDto, string> = {
  closed: 'Closed',
  untracked: 'Not started',
  queued: 'Queued',
  active: 'In progress',
  waiting_human: 'Needs you',
  awaiting_merge: 'Awaiting merge',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function Ring({ className, fill, dashed, children }: { className?: string; fill?: number; dashed?: boolean; children?: React.ReactNode }) {
  const radius = 3.5
  const circumference = 2 * Math.PI * radius
  return (
    <svg viewBox="0 0 16 16" className={cn('size-4 shrink-0', className)} aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={dashed ? '2.2 2.2' : undefined} />
      {fill ? (
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={radius * 2}
          strokeDasharray={`${circumference * fill} ${circumference}`}
          transform="rotate(-90 8 8)"
        />
      ) : null}
      {children}
    </svg>
  )
}

function Solid({ className, path }: { className?: string; path: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn('size-4 shrink-0', className)} aria-hidden="true">
      <circle cx="8" cy="8" r="7.25" fill="currentColor" />
      <path d={path} fill="none" stroke="var(--surface)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function FactoryStateIcon({ state, className }: { state: IssueGroupDto; className?: string }) {
  switch (state) {
    case 'closed':
      return <Solid className={cn('text-ink-3', className)} path="M4.8 8.3l2.2 2.2 4.2-4.6" />
    case 'untracked':
      return <Ring dashed className={cn('text-ink-3', className)} />
    case 'queued':
      return <Ring className={cn('text-ink-2', className)} />
    case 'active':
      return <Ring fill={0.5} className={cn('text-signal', className)} />
    case 'waiting_human':
      return <Solid className={cn('text-warning', className)} path="M8 4.6v4M8 11.2v.1" />
    case 'awaiting_merge':
      return <Ring fill={0.75} className={cn('text-signal', className)} />
    case 'done':
      return <Solid className={cn('text-success', className)} path="M4.8 8.3l2.2 2.2 4.2-4.6" />
    case 'failed':
      return <Solid className={cn('text-danger', className)} path="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" />
    case 'cancelled':
      return <Solid className={cn('text-ink-3', className)} path="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" />
  }
}

export function TrackerStateIcon({ type, className }: { type: string | null; className?: string }) {
  switch (type) {
    case 'backlog':
    case 'triage':
      return <Ring dashed className={cn('text-ink-3', className)} />
    case 'started':
      return <Ring fill={0.5} className={cn('text-warning', className)} />
    case 'completed':
      return <Solid className={cn('text-action', className)} path="M4.8 8.3l2.2 2.2 4.2-4.6" />
    case 'canceled':
      return <Solid className={cn('text-ink-3', className)} path="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" />
    default:
      return <Ring className={cn('text-ink-2', className)} />
  }
}

export const PRIORITY_LABEL = ['No priority', 'Urgent', 'High', 'Medium', 'Low']

export function PriorityIcon({ priority, className }: { priority: number; className?: string }) {
  if (priority === 1) {
    return (
      <svg viewBox="0 0 16 16" className={cn('size-4 shrink-0 text-danger', className)} aria-label="Urgent">
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor" />
        <path d="M8 4.5v4.4M8 11.3v.1" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  }
  if (priority === 0) {
    return (
      <svg viewBox="0 0 16 16" className={cn('size-4 shrink-0 text-ink-3', className)} aria-label="No priority">
        <path d="M3 8h2.2M6.9 8h2.2M10.8 8H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  }
  const level = 5 - priority
  return (
    <svg viewBox="0 0 16 16" className={cn('size-4 shrink-0 text-ink-2', className)} aria-label={PRIORITY_LABEL[priority]}>
      {[0, 1, 2].map((bar) => (
        <rect
          key={bar}
          x={2.5 + bar * 4}
          y={10 - bar * 3}
          width="2.8"
          height={4 + bar * 3}
          rx="0.8"
          fill="currentColor"
          opacity={bar < level - 1 ? 1 : 0.28}
        />
      ))}
    </svg>
  )
}
