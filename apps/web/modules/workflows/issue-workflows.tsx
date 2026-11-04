'use client'

import { Workflow } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'
import { type ApiError, api } from '../lib/api'
import { useIssueWorkflowRuns, useWorkflows } from '../lib/data'
import { timeAgo } from '../lib/format'
import { Button, Dialog, ListSkeleton, SectionTitle } from '../ui'
import { RunStatusChip, triggerSummary } from './blocks'

export function RunWorkflowButton({ issueId, projectId }: { issueId: string; projectId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const { data } = useWorkflows()
  const usable = (data?.workflows ?? []).filter(
    (workflow) => workflow.publishedVersion > 0 && (!workflow.projectId || workflow.projectId === projectId),
  )

  const run = async (workflowId: string) => {
    setRunning(true)
    try {
      const result = await api.post<{ started: string[]; skipped: { reason: string }[] }>(`/api/workflows/${workflowId}/runs`, {
        issueIds: [issueId],
      })
      const [started] = result.started
      if (started) {
        setOpen(false)
        router.push(`/workflows/${workflowId}/runs/${started}`)
      } else {
        toast.error(result.skipped[0]?.reason ?? 'It did not start')
      }
    } catch (error) {
      toast.error((error as ApiError).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Workflow />
        <span className="hidden sm:inline">Run workflow</span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Run a workflow on this ticket"
        description="Runs the last published version of the one you pick."
      >
        {!data ? (
          <ListSkeleton rows={3} />
        ) : usable.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-2">
            No published workflow covers this ticket.{' '}
            <Link href="/workflows" className="text-link hover:underline">
              Open workflows
            </Link>
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-divider">
            {usable.map((workflow) => (
              <button
                key={workflow.id}
                type="button"
                disabled={running}
                onClick={() => void run(workflow.id)}
                className="flex w-full flex-col border-b border-divider px-3 py-2 text-left transition-colors duration-75 last:border-b-0 hover:bg-softer disabled:opacity-50"
              >
                <span className="truncate text-sm">{workflow.name}</span>
                <span className="truncate text-xs text-ink-2">{workflow.description || triggerSummary(workflow.triggers)}</span>
              </button>
            ))}
          </div>
        )}
      </Dialog>
    </>
  )
}

export function IssueWorkflowRuns({ issueId }: { issueId: string }) {
  const { data } = useIssueWorkflowRuns(issueId)
  if (!data || data.runs.length === 0) return null
  return (
    <section>
      <SectionTitle>Workflow runs</SectionTitle>
      <div className="overflow-hidden rounded-md border border-divider">
        {data.runs.map((run) => (
          <Link
            key={run.id}
            href={`/workflows/${run.workflowId}/runs/${run.id}`}
            className="flex h-10 items-center gap-2 border-b border-divider px-3 transition-colors duration-75 last:border-b-0 hover:bg-softer"
          >
            <span className="min-w-0 flex-1 truncate text-sm">{run.workflowName}</span>
            <RunStatusChip status={run.status} />
            <span className="shrink-0 text-xs text-ink-3">{timeAgo(run.createdAt)}</span>
          </Link>
        ))}
      </div>
    </section>
  )
}
