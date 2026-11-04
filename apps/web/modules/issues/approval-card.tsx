'use client'

import type { ApprovalDto, MergeRequestDto } from '@factorix/schemas'
import { Check, ExternalLink, GitMerge, ShieldQuestion, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { mutate } from 'swr'
import { api } from '../lib/api'
import { Button, Card, Textarea } from '../ui'

interface Plan {
  summary?: string
  steps?: string[]
  filesTouched?: string[]
  risks?: string[]
  questions?: string[]
}

function MergeBody({ mergeRequests }: { mergeRequests: MergeRequestDto[] }) {
  const link = (mr: MergeRequestDto, text: string) => (
    <a href={mr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-link hover:underline">
      {text} <ExternalLink className="size-3" />
    </a>
  )
  const [first] = mergeRequests
  if (mergeRequests.length < 2)
    return (
      <p className="text-sm text-ink-2">
        Approving merges the request when CI allows it. You can also merge it yourself. {first ? link(first, 'Open the merge request') : null}
      </p>
    )
  return (
    <div className="text-sm text-ink-2">
      <p>Approving merges them in this order, once CI is green on all of them. You can also merge them yourself.</p>
      <ol className="mt-2 flex list-decimal flex-col gap-0.5 pl-5">
        {mergeRequests.map((mr) => (
          <li key={mr.url}>
            {link(mr, `${mr.repoPath} !${mr.iid}`)} <span className="text-ink-3">{mr.state}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function PlanBody({ plan }: { plan: Plan }) {
  const list = (title: string, items?: string[]) =>
    items && items.length > 0 ? (
      <div>
        <div className="mb-1 text-xs text-ink-2">{title}</div>
        <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    ) : null
  return (
    <div className="flex flex-col gap-3">
      {plan.summary ? <p className="text-sm">{plan.summary}</p> : null}
      {list('Steps', plan.steps)}
      {list('Files', plan.filesTouched)}
      {list('Risks', plan.risks)}
      {list('Questions for you', plan.questions)}
    </div>
  )
}

export function approvalTitle(approval: ApprovalDto): string {
  switch (approval.kind) {
    case 'plan':
      return 'Plan ready for sign-off'
    case 'merge':
      return 'Ready to merge'
    case 'question':
      return 'The agent has a question'
    case 'tool':
      return `Approve ${String(approval.payload.tool ?? 'a tool call')}`
  }
}

export function ApprovalCard({ approval, compact }: { approval: ApprovalDto; compact?: boolean }) {
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState<'approved' | 'rejected' | null>(null)
  const decide = async (decision: 'approved' | 'rejected') => {
    setLoading(decision)
    try {
      await api.post(`/api/approvals/${approval.id}/decide`, { decision, message: message || undefined })
      void mutate(
        (key) =>
          typeof key === 'string' &&
          (key.startsWith('/api/approvals') || key.startsWith('/api/inbox') || key.startsWith('/api/issues') || key.startsWith('/api/runs')),
      )
      toast.success(decision === 'approved' ? 'Approved' : 'Rejected')
    } catch (error) {
      toast.error((error as Error).message)
      setLoading(null)
    }
  }
  const mergeRequests = (approval.payload.mergeRequests ?? []) as MergeRequestDto[]
  const summary = approval.payload.summary as string | undefined
  const input = approval.payload.input
  const Icon = approval.kind === 'merge' ? GitMerge : ShieldQuestion
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4 text-warning-ink" />
        {approvalTitle(approval)}
        {approval.agentHandle ? <span className="font-normal text-ink-2">from {approval.agentHandle}</span> : null}
      </div>
      {approval.kind === 'plan' && approval.payload.plan ? <PlanBody plan={approval.payload.plan as Plan} /> : null}
      {approval.kind === 'merge' ? <MergeBody mergeRequests={mergeRequests} /> : null}
      {summary ? <p className="text-sm">{summary}</p> : null}
      {input !== undefined && approval.kind === 'tool' ? (
        <pre className="scroll-thin mt-2 max-h-48 overflow-auto rounded-md bg-soft p-2 font-mono text-xs">{JSON.stringify(input, null, 2)}</pre>
      ) : null}
      {approval.kind !== 'merge' && !compact ? (
        <Textarea
          className="mt-3 min-h-14"
          placeholder="Add notes for the agent (optional)"
          aria-label="Notes for the agent"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button
          variant="primary"
          size="sm"
          className="h-8 px-3"
          loading={loading === 'approved'}
          disabled={loading !== null}
          onClick={() => void decide('approved')}
        >
          <Check />
          {approval.kind === 'merge' ? 'Merge' : 'Approve'}
        </Button>
        <Button size="sm" className="h-8 px-3" loading={loading === 'rejected'} disabled={loading !== null} onClick={() => void decide('rejected')}>
          <X />
          Reject
        </Button>
      </div>
    </Card>
  )
}
