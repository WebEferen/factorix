'use client'

import type { RunDto } from '@factorix/schemas'
import { Plus } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'
import { useRuns } from '@/modules/lib/data'
import { cn, duration, money, timeAgo, titleCase } from '@/modules/lib/format'
import { ACTIVE_RUN_STATES, RunStateChip } from '@/modules/runs/run-state'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { useListKeys } from '@/modules/shell/use-list-keys'
import { Avatar, Button, EmptyState, ErrorState, ListSkeleton, Tabs } from '@/modules/ui'
import { RunsArt } from '@/modules/ui/empty-art'

type View = 'all' | 'active' | 'failed'

export default function RunsPage() {
  const router = useRouter()
  const [view, setView] = useState<View>('all')
  const { data, error, mutate } = useRuns(view === 'active' ? { state: ACTIVE_RUN_STATES.join(',') } : view === 'failed' ? { state: 'failed' } : {})
  const open = useCallback((run: RunDto) => router.push(`/runs/${run.id}`), [router])
  const runs = data?.runs ?? []
  const { selected, setSelected } = useListKeys(runs, open)
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Runs' }]}
        below={
          <Tabs
            value={view}
            onChange={setView}
            tabs={[
              { value: 'all', label: 'All' },
              { value: 'active', label: 'Active' },
              { value: 'failed', label: 'Failed' },
            ]}
          />
        }
      >
        <Link href="/runs/new">
          <Button size="sm">
            <Plus />
            Ad-hoc task
          </Button>
        </Link>
      </PageHeader>
      <PageBody>
        {error && !data ? (
          <ErrorState error={error} retry={() => void mutate()} />
        ) : !data ? (
          <ListSkeleton />
        ) : runs.length === 0 ? (
          <EmptyState
            art={<RunsArt />}
            title="No runs here"
            action={
              <Link href="/runs/new">
                <Button variant="primary">Run an ad-hoc task</Button>
              </Link>
            }
          >
            Every agent session shows up here, with its full transcript and cost.
          </EmptyState>
        ) : (
          runs.map((run, index) => (
            <Link
              key={run.id}
              href={`/runs/${run.id}`}
              onMouseEnter={() => setSelected(index)}
              className={cn(
                'flex h-10 items-center gap-2.5 border-b border-divider px-4 text-sm transition-colors duration-75',
                selected === index ? 'bg-soft' : 'hover:bg-softer',
              )}
            >
              <Avatar name={run.agentHandle} agent size={18} />
              <span className="hidden w-28 shrink-0 truncate text-ink-2 md:block">{run.agentHandle}</span>
              <span className="w-24 shrink-0 truncate">{titleCase(run.phase)}</span>
              <span className="min-w-0 flex-1 truncate text-ink-2">
                {run.issueIdentifier ? `${run.issueIdentifier} ${run.issueTitle ?? ''}` : (run.adHocPrompt ?? 'Ad-hoc task')}
              </span>
              <span className="hidden w-16 shrink-0 text-right text-xs text-ink-2 sm:block">{duration(run.startedAt, run.finishedAt)}</span>
              <span className="hidden w-16 shrink-0 text-right text-xs text-ink-2 sm:block">
                {run.costUsd ? `${run.costEstimated ? 'est. ' : ''}${money(run.costUsd)}` : ''}
              </span>
              <span className="flex w-28 shrink-0 justify-end">
                <RunStateChip state={run.state} />
              </span>
              <span className="w-7 shrink-0 text-right text-xs text-ink-3">{timeAgo(run.createdAt)}</span>
            </Link>
          ))
        )}
      </PageBody>
    </>
  )
}
