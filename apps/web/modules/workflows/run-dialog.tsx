'use client'

import type { WorkflowDto } from '@factorix/schemas'
import { Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { ApiError } from '../lib/api'
import { api } from '../lib/api'
import { useIssues } from '../lib/data'
import { Button, Dialog, DialogFooter, ErrorState, Input, ListSkeleton } from '../ui'

const MAX_TICKETS = 50

function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}

interface RunResult {
  started: string[]
  skipped: { issueId: string; reason: string }[]
}

export function RunWorkflowDialog({ workflow, open, onOpenChange }: { workflow: WorkflowDto; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const query = useDebounced(search, 200)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [skipped, setSkipped] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const { data, error, mutate } = useIssues(
    open ? { q: query || undefined, projectId: workflow.projectId ?? undefined, scope: 'open', limit: '30' } : null,
  )

  useEffect(() => {
    if (open) {
      setPicked(new Set())
      setSkipped([])
      setSearch('')
    }
  }, [open])

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else if (next.size < MAX_TICKETS) next.add(id)
      return next
    })

  const run = async () => {
    setRunning(true)
    try {
      const result = await api.post<RunResult>(`/api/workflows/${workflow.id}/runs`, { issueIds: [...picked] })
      const [only] = result.started
      if (only && result.started.length === 1 && result.skipped.length === 0) {
        onOpenChange(false)
        router.push(`/workflows/${workflow.id}/runs/${only}`)
        return
      }
      if (result.started.length > 0) toast.success(`Started on ${result.started.length} ${result.started.length === 1 ? 'ticket' : 'tickets'}`)
      if (result.skipped.length === 0) {
        onOpenChange(false)
        router.push(`/workflows/${workflow.id}/runs`)
        return
      }
      setSkipped(result.skipped.map((item) => item.reason))
      setPicked(new Set(result.skipped.map((item) => item.issueId)))
    } catch (failure) {
      toast.error((failure as ApiError).message)
    } finally {
      setRunning(false)
    }
  }

  const note = workflow.hasUnpublishedChanges
    ? `Runs version ${workflow.publishedVersion}, the last one published. Your newer changes are not included.`
    : `Runs version ${workflow.publishedVersion}. It can change tickets and post messages right away.`

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Run ${workflow.name}`} description={note}>
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-3" />
          <Input
            aria-label="Search tickets"
            className="pl-8"
            placeholder="Search open tickets"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="scroll-thin max-h-72 min-h-40 overflow-y-auto rounded-md border border-divider">
          {error && !data ? (
            <ErrorState error={error} retry={() => void mutate()} />
          ) : !data ? (
            <ListSkeleton rows={4} />
          ) : data.issues.length === 0 ? (
            <p className="p-4 text-center text-sm text-ink-2">No open tickets match.</p>
          ) : (
            data.issues.map((issue) => (
              <label
                key={issue.id}
                className="flex cursor-pointer items-center gap-2.5 border-b border-divider px-3 py-2 transition-colors duration-75 last:border-b-0 hover:bg-softer"
              >
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-[var(--action)]"
                  checked={picked.has(issue.id)}
                  onChange={() => toggle(issue.id)}
                />
                <span className="shrink-0 text-xs text-ink-2">{issue.identifier}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{issue.title}</span>
                <span className="hidden shrink-0 text-xs text-ink-3 sm:block">{issue.trackerStateName}</span>
              </label>
            ))
          )}
        </div>
        {skipped.length > 0 ? (
          <ul data-testid="skipped" className="flex flex-col gap-1 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-ink">
            {skipped.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <DialogFooter>
        <Button size="sm" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={picked.size === 0 || running} onClick={() => void run()}>
          {picked.size === 0 ? 'Pick tickets' : `Run on ${picked.size} ${picked.size === 1 ? 'ticket' : 'tickets'}`}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
