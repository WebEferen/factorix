'use client'

import type { WorkflowDefinition, WorkflowDto } from '@factorix/schemas'
import { Plus } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { type ApiError, api } from '@/modules/lib/api'
import { useMe, useWorkflows } from '@/modules/lib/data'
import { cn, timeAgo } from '@/modules/lib/format'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { useListKeys } from '@/modules/shell/use-list-keys'
import { Button, Chip, EmptyState, ErrorState, ListSkeleton } from '@/modules/ui'
import { WorkflowsArt } from '@/modules/ui/empty-art'
import { RunStatusChip, triggerSummary } from '@/modules/workflows/blocks'

const STARTER: WorkflowDefinition = {
  nodes: [{ id: 'manual-1', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {} }],
  edges: [],
}

function StateChip({ workflow }: { workflow: WorkflowDto }) {
  if (workflow.publishedVersion === 0) return <Chip>Draft</Chip>
  const automatic = workflow.triggers.some((type) => type !== 'trigger.manual')
  if (!automatic) return <Chip tone="outline">By hand</Chip>
  return workflow.enabled ? <Chip tone="success">On</Chip> : <Chip tone="outline">Off</Chip>
}

export default function WorkflowsPage() {
  const router = useRouter()
  const { data, error, mutate } = useWorkflows()
  const { data: me } = useMe()
  const [creating, setCreating] = useState(false)
  const workflows = data?.workflows ?? []
  const canEdit = me?.account.role === 'admin'
  const open = useCallback((workflow: WorkflowDto) => router.push(`/workflows/${workflow.id}`), [router])
  const { selected, setSelected } = useListKeys(workflows, open)

  const create = async () => {
    setCreating(true)
    try {
      const { workflow } = await api.post<{ workflow: WorkflowDto }>('/api/workflows', { name: 'Untitled workflow', definition: STARTER })
      router.push(`/workflows/${workflow.id}`)
    } catch (failure) {
      toast.error((failure as ApiError).message)
      setCreating(false)
    }
  }

  const newButton = canEdit ? (
    <Button size="sm" variant="primary" disabled={creating} onClick={() => void create()}>
      <Plus />
      New workflow
    </Button>
  ) : null

  return (
    <>
      <PageHeader crumbs={[{ label: 'Workflows' }]}>{newButton}</PageHeader>
      <PageBody>
        {error && !data ? (
          <ErrorState error={error} retry={() => void mutate()} />
        ) : !data ? (
          <ListSkeleton rows={4} />
        ) : workflows.length === 0 ? (
          <EmptyState art={<WorkflowsArt />} title="No workflows yet" action={newButton}>
            Build flows from blocks that react to tickets: create follow-ups, hand work to agents, and post to Slack.
          </EmptyState>
        ) : (
          workflows.map((workflow, index) => (
            <Link
              key={workflow.id}
              href={`/workflows/${workflow.id}`}
              onMouseEnter={() => setSelected(index)}
              className={cn(
                'flex h-13 items-center gap-3 border-b border-divider px-4 transition-colors duration-75',
                selected === index ? 'bg-soft' : 'hover:bg-softer',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{workflow.name}</div>
                <div className="truncate text-xs text-ink-2">{workflow.description || triggerSummary(workflow.triggers)}</div>
              </div>
              {workflow.hasUnpublishedChanges && workflow.publishedVersion > 0 ? (
                <Chip tone="warning" className="hidden sm:inline-flex">
                  Unpublished changes
                </Chip>
              ) : null}
              <StateChip workflow={workflow} />
              <span className="hidden w-32 truncate text-right text-xs text-ink-2 md:block">{workflow.projectName ?? 'All projects'}</span>
              <span className="hidden w-44 items-center justify-end gap-2 text-xs text-ink-2 lg:flex">
                {workflow.lastRunStatus ? <RunStatusChip status={workflow.lastRunStatus} /> : null}
                {workflow.lastRunAt ? timeAgo(workflow.lastRunAt) : 'Never run'}
              </span>
            </Link>
          ))
        )}
      </PageBody>
    </>
  )
}
