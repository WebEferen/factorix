'use client'

import { Ban } from 'lucide-react'
import { useParams } from 'next/navigation'
import { toast } from 'sonner'
import { type ApiError, api } from '@/modules/lib/api'
import { useWorkflowRun } from '@/modules/lib/data'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { Button, ErrorState, ListSkeleton } from '@/modules/ui'
import { RunView } from '@/modules/workflows/run-view'

export default function WorkflowRunPage() {
  const { id, runId } = useParams<{ id: string; runId: string }>()
  const { data, error, mutate } = useWorkflowRun(runId)
  const run = data?.run

  const cancel = async () => {
    try {
      await api.post(`/api/workflow-runs/${runId}/cancel`)
      await mutate()
    } catch (failure) {
      toast.error((failure as ApiError).message)
    }
  }

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Workflows', href: '/workflows' },
          { label: run?.workflowName ?? 'Workflow', href: `/workflows/${id}` },
          { label: 'Runs', href: `/workflows/${id}/runs` },
          { label: run?.issueIdentifier ?? 'Run' },
        ]}
      >
        {run?.status === 'running' ? (
          <Button size="sm" variant="danger" onClick={() => void cancel()}>
            <Ban />
            Cancel
          </Button>
        ) : null}
      </PageHeader>
      {run ? (
        <RunView run={run} />
      ) : (
        <PageBody>{error ? <ErrorState error={error} retry={() => void mutate()} /> : <ListSkeleton rows={4} />}</PageBody>
      )}
    </>
  )
}
