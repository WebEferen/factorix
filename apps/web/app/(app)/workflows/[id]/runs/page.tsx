'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useWorkflow, useWorkflowRuns } from '@/modules/lib/data'
import { timeAgo } from '@/modules/lib/format'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { EmptyState, ErrorState, ListSkeleton } from '@/modules/ui'
import { HistoryArt } from '@/modules/ui/empty-art'
import { RunStatusChip } from '@/modules/workflows/blocks'

export default function WorkflowRunsPage() {
  const { id } = useParams<{ id: string }>()
  const { data: workflow } = useWorkflow(id)
  const { data, error, mutate } = useWorkflowRuns(id)
  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Workflows', href: '/workflows' },
          { label: workflow?.workflow.name ?? 'Workflow', href: `/workflows/${id}` },
          { label: 'Runs' },
        ]}
      />
      <PageBody>
        {error && !data ? (
          <ErrorState error={error} retry={() => void mutate()} />
        ) : !data ? (
          <ListSkeleton rows={4} />
        ) : data.runs.length === 0 ? (
          <EmptyState art={<HistoryArt />} title="No runs yet">
            Publish the workflow, then run it on a ticket or turn it on.
          </EmptyState>
        ) : (
          data.runs.map((run) => (
            <Link
              key={run.id}
              href={`/workflows/${id}/runs/${run.id}`}
              className="flex h-11 items-center gap-3 border-b border-divider px-4 transition-colors duration-75 hover:bg-softer"
            >
              <span className="shrink-0 text-xs text-ink-2">{run.issueIdentifier}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{run.issueTitle}</span>
              <span className="hidden shrink-0 text-xs text-ink-3 sm:block">Version {run.workflowVersion}</span>
              <RunStatusChip status={run.status} />
              <span className="w-20 shrink-0 text-right text-xs text-ink-3">{timeAgo(run.createdAt)}</span>
            </Link>
          ))
        )}
      </PageBody>
    </>
  )
}
