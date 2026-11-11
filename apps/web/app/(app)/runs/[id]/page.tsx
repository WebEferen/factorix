'use client'

import type { ApprovalDto } from '@factorix/schemas'
import { Ban, Send } from 'lucide-react'
import Link from 'next/link'
import { use, useEffect, useState } from 'react'
import { toast } from 'sonner'
import useSWR, { mutate } from 'swr'
import { ApprovalCard } from '@/modules/issues/approval-card'
import { api, fetcher } from '@/modules/lib/api'
import { useRun } from '@/modules/lib/data'
import { compactNumber, duration, fullDate, money, titleCase } from '@/modules/lib/format'
import { DiffView } from '@/modules/runs/diff-view'
import { RunActivity } from '@/modules/runs/run-activity'
import { ACTIVE_RUN_STATES, RunStateChip } from '@/modules/runs/run-state'
import { useRunStream } from '@/modules/runs/use-run-stream'
import { PageHeader } from '@/modules/shell/page-header'
import { Avatar, Button, buttonStyles, Chip, EmptyState, ErrorState, Input, ListSkeleton, Tabs, Toggle, Tooltip } from '@/modules/ui'
import { Boundary } from '@/modules/ui/boundary'
import { NoResultArt } from '@/modules/ui/empty-art'

type View = 'activity' | 'diff' | 'output'

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const body = (
    <div className="min-w-0">
      <div className="text-xs text-ink-3">{label}</div>
      <div className="truncate text-sm">{value}</div>
    </div>
  )
  return hint ? <Tooltip label={hint}>{body}</Tooltip> : body
}

function Nudge({ runId }: { runId: string }) {
  const [text, setText] = useState('')
  const send = async () => {
    if (!text.trim()) return
    try {
      await api.post(`/api/runs/${runId}/messages`, { text })
      setText('')
    } catch (error) {
      toast.error((error as Error).message)
    }
  }
  return (
    <form
      className="flex shrink-0 gap-2 border-t border-divider p-2"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <Input
        className="h-8 text-sm"
        placeholder="Send the agent a note while it works"
        aria-label="Note to the agent"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <Button type="submit" size="icon" className="size-8" aria-label="Send" disabled={!text.trim()}>
        <Send />
      </Button>
    </form>
  )
}

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { data, error, mutate: refresh } = useRun(id)
  const stream = useRunStream(id)
  const [view, setView] = useState<View>('activity')
  const [showLogs, setShowLogs] = useState(false)
  const [, tick] = useState(0)
  const run = data?.run
  const live = run ? ACTIVE_RUN_STATES.includes(run.state) : false
  const { data: diff } = useSWR<{ diff: string | null }>(view === 'diff' && run?.hasDiff ? `/api/runs/${id}/diff` : null, fetcher as never)
  const { data: approvals } = useSWR<{ approvals: ApprovalDto[] }>(
    run?.state === 'waiting_approval' ? '/api/approvals?status=pending' : null,
    fetcher as never,
  )
  const pending = approvals?.approvals.filter((approval) => approval.runId === id) ?? []

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => tick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [live])

  if (error && !data)
    return (
      <>
        <PageHeader crumbs={[{ label: 'Runs', href: '/runs' }]} />
        <ErrorState error={error} retry={() => void refresh()} />
      </>
    )
  if (!run)
    return (
      <>
        <PageHeader crumbs={[{ label: 'Runs', href: '/runs' }]} />
        <ListSkeleton rows={6} />
      </>
    )

  const usage = stream.usage ?? run.usage
  const estimated = run.capabilities?.costReporting === 'tokens' || run.costEstimated
  const cost = stream.usage?.costUsd ?? run.costUsd
  const cancel = async () => {
    try {
      await api.post(`/api/runs/${id}/cancel`, {})
      void mutate(`/api/runs/${id}`)
      toast.success('Asked the agent to stop')
    } catch (caught) {
      toast.error((caught as Error).message)
    }
  }

  return (
    <>
      <PageHeader
        crumbs={[
          run.issueId ? { label: run.issueIdentifier ?? 'Issue', href: `/issues/${run.issueId}` } : { label: 'Runs', href: '/runs' },
          { label: `${titleCase(run.phase)}${run.attempt > 1 ? ` (attempt ${run.attempt})` : ''}` },
        ]}
        below={
          <>
            <Tabs
              value={view}
              onChange={setView}
              tabs={[
                { value: 'activity', label: 'Activity' },
                { value: 'diff', label: 'Diff' },
                { value: 'output', label: 'Result' },
              ]}
            />
            {view === 'activity' ? (
              <div className="ml-auto shrink-0">
                <Toggle checked={showLogs} onChange={setShowLogs} label="Show logs" />
              </div>
            ) : null}
          </>
        }
      >
        <RunStateChip state={run.state} />
        {live ? (
          <Button size="sm" variant="danger" onClick={() => void cancel()}>
            <Ban />
            Cancel
          </Button>
        ) : null}
      </PageHeader>

      <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-2 border-b border-divider px-4 py-2 sm:flex sm:flex-wrap">
        <div className="flex items-center gap-2">
          <Avatar name={run.agentHandle} agent size={24} />
          <Stat label="Agent" value={run.agentHandle} />
        </div>
        <Stat label="Runtime" value={run.runtime === 'scripted' ? 'Scripted' : `${titleCase(run.runtime)}${run.model ? `, ${run.model}` : ''}`} />
        <Stat
          label="Duration"
          value={duration(run.startedAt, run.finishedAt) || 'Not started'}
          hint={run.startedAt ? `Started ${fullDate(run.startedAt)}` : undefined}
        />
        <Stat label="Tokens" value={`${compactNumber(usage.inputTokens)} in, ${compactNumber(usage.outputTokens)} out`} />
        <Stat
          label="Cost"
          value={cost ? `${estimated ? 'est. ' : ''}${money(cost)}` : '$0.00'}
          hint={estimated ? 'This runtime reports tokens, so cost is estimated from the price table.' : undefined}
        />
        {run.issueId ? null : <Stat label="Type" value="Ad-hoc" />}
        {live && !stream.connected ? (
          <Chip tone="warning" className="self-center">
            Reconnecting
          </Chip>
        ) : null}
      </div>

      {run.error ? (
        <div className="shrink-0 border-b border-divider bg-danger-soft px-4 py-2 text-sm text-danger-ink">{run.error.message}</div>
      ) : null}
      {pending.length > 0 ? (
        <div className="flex shrink-0 flex-col gap-2 border-b border-divider p-3">
          {pending.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} compact />
          ))}
        </div>
      ) : null}

      {view === 'activity' ? (
        <>
          <Boundary label="this run's activity" resetKey={stream.items.length}>
            <RunActivity items={stream.items} showLogs={showLogs} live={run.state === 'running'} />
          </Boundary>
          {live && run.capabilities?.midRunMessages ? <Nudge runId={id} /> : null}
        </>
      ) : view === 'diff' ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <Boundary label="the diff" resetKey={diff?.diff}>
            <DiffView diff={diff?.diff} />
          </Boundary>
        </div>
      ) : !run.summary && !run.structuredOutput && !run.adHocPrompt ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <EmptyState
            art={<NoResultArt />}
            title={live ? 'No result yet' : 'No result'}
            action={
              run.issueId ? (
                <Link href={`/issues/${run.issueId}`} className={buttonStyles({ size: 'sm' })}>
                  Back to the issue
                </Link>
              ) : undefined
            }
          >
            {live
              ? 'The agent’s summary shows up here when the run finishes.'
              : run.error
                ? 'This run stopped before the agent wrote a summary.'
                : 'This run finished without a summary.'}
          </EmptyState>
        </div>
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {run.adHocPrompt ? (
              <div>
                <div className="mb-1 text-xs text-ink-2">Task</div>
                <p className="text-sm whitespace-pre-wrap">{run.adHocPrompt}</p>
              </div>
            ) : null}
            {run.summary ? (
              <div>
                <div className="mb-1 text-xs text-ink-2">Summary</div>
                <p className="text-sm whitespace-pre-wrap">{run.summary}</p>
              </div>
            ) : null}
            {run.structuredOutput ? (
              <div>
                <div className="mb-1 text-xs text-ink-2">Structured result</div>
                <pre className="scroll-thin overflow-auto rounded-md bg-soft p-3 font-mono text-xs">
                  {JSON.stringify(run.structuredOutput, null, 2)}
                </pre>
              </div>
            ) : null}
            {run.issueId ? (
              <Link href={`/issues/${run.issueId}`} className="text-sm text-link hover:underline">
                Back to the issue
              </Link>
            ) : null}
          </div>
        </div>
      )}
    </>
  )
}
