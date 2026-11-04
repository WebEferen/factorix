'use client'

import type { ApprovalDto, MergeRequestDto } from '@factorix/schemas'
import { Check, ExternalLink, GitMerge, RotateCcw, ShieldQuestion, Undo2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { mutate } from 'swr'
import { api } from '../lib/api'
import { Button, Card, Dialog, DialogFooter, Textarea } from '../ui'

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
        {first?.error ? <span className="block text-danger-ink">Stopped because {first.error}.</span> : null}
      </p>
    )
  return (
    <div className="text-sm text-ink-2">
      <p>Approving merges them in this order, once CI is green on all of them. You can also merge them yourself.</p>
      <ol className="mt-2 flex list-decimal flex-col gap-0.5 pl-5">
        {mergeRequests.map((mr) => (
          <li key={mr.url}>
            {link(mr, `${mr.repoPath} !${mr.iid}`)} <span className="text-ink-3">{mr.state}</span>
            {mr.error ? <div className="text-danger-ink">Stopped because {mr.error}.</div> : null}
          </li>
        ))}
      </ol>
    </div>
  )
}

type RecoveryChoice = 'retry' | 'revert' | 'keep'

function ChainStatus({ mergeRequests }: { mergeRequests: MergeRequestDto[] }) {
  const link = (url: string, text: string) => (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-link hover:underline">
      {text} <ExternalLink className="size-3" />
    </a>
  )
  return (
    <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
      {mergeRequests.map((mr) => (
        <li key={mr.url}>
          {link(mr.url, `${mr.repoPath} !${mr.iid}`)} <span className="text-ink-3">{mr.state}</span>
          {mr.error ? <div className="text-danger-ink">{mr.error}</div> : null}
          {mr.revert ? (
            <div className="text-ink-2">
              {mr.revert.url ? link(mr.revert.url, 'Revert') : 'Revert'} <span className="text-ink-3">{mr.revert.state}</span>
              {mr.revert.error ? <span className="text-danger-ink"> {mr.revert.error}</span> : null}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

function RecoveryBody({ kind, mergeRequests }: { kind: ApprovalDto['kind']; mergeRequests: MergeRequestDto[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink-2">
        {kind === 'partial_merge'
          ? 'Merges in different repositories cannot land together, and this one stopped partway. Choose what happens to the ones that landed.'
          : 'Factorix keeps trying the reverts that are open, newest first. You can merge them yourself, or try again once the cause is fixed.'}
      </p>
      <ChainStatus mergeRequests={mergeRequests} />
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
    case 'partial_merge':
      return 'Only part of this change merged'
    case 'revert_blocked':
      return 'The revert needs a person'
    case 'question':
      return 'The agent has a question'
    case 'tool':
      return `Approve ${String(approval.payload.tool ?? 'a tool call')}`
  }
}

export function ApprovalCard({ approval, compact }: { approval: ApprovalDto; compact?: boolean }) {
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState<'approved' | 'rejected' | RecoveryChoice | null>(null)
  const [confirmRevert, setConfirmRevert] = useState(false)
  const decide = async (decision: 'approved' | 'rejected', choice?: RecoveryChoice) => {
    setLoading(choice ?? decision)
    try {
      await api.post(`/api/approvals/${approval.id}/decide`, { decision, choice, message: message || undefined })
      void mutate(
        (key) =>
          typeof key === 'string' &&
          (key.startsWith('/api/approvals') || key.startsWith('/api/inbox') || key.startsWith('/api/issues') || key.startsWith('/api/runs')),
      )
      if (choice) toast.success(choice === 'revert' ? 'Reverting' : choice === 'retry' ? 'Trying again' : 'Done')
      else toast.success(decision === 'approved' ? 'Approved' : 'Rejected')
    } catch (error) {
      toast.error((error as Error).message)
      setLoading(null)
    }
  }
  const mergeRequests = (approval.payload.mergeRequests ?? []) as MergeRequestDto[]
  const summary = approval.payload.summary as string | undefined
  const input = approval.payload.input
  const recovery = approval.kind === 'partial_merge' || approval.kind === 'revert_blocked'
  const Icon = approval.kind === 'merge' || recovery ? GitMerge : ShieldQuestion
  const openElsewhere = mergeRequests.filter((mr) => mr.state === 'opened')
  const landed = mergeRequests.filter((mr) => mr.state === 'merged')
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4 text-warning-ink" />
        {approvalTitle(approval)}
        {approval.agentHandle ? <span className="font-normal text-ink-2">from {approval.agentHandle}</span> : null}
      </div>
      {approval.kind === 'plan' && approval.payload.plan ? <PlanBody plan={approval.payload.plan as Plan} /> : null}
      {approval.kind === 'merge' ? <MergeBody mergeRequests={mergeRequests} /> : null}
      {recovery ? <RecoveryBody kind={approval.kind} mergeRequests={mergeRequests} /> : null}
      {summary ? <p className="text-sm">{summary}</p> : null}
      {input !== undefined && approval.kind === 'tool' ? (
        <pre className="scroll-thin mt-2 max-h-48 overflow-auto rounded-md bg-soft p-2 font-mono text-xs">{JSON.stringify(input, null, 2)}</pre>
      ) : null}
      {approval.kind !== 'merge' && !recovery && !compact ? (
        <Textarea
          className="mt-3 min-h-14"
          placeholder="Add notes for the agent (optional)"
          aria-label="Notes for the agent"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
      ) : null}
      {recovery ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            className="h-8 px-3"
            loading={loading === 'retry'}
            disabled={loading !== null}
            onClick={() => void decide('approved', 'retry')}
          >
            <RotateCcw />
            {approval.kind === 'partial_merge' ? 'Retry the rest' : 'Try again'}
          </Button>
          {approval.kind === 'partial_merge' ? (
            <Button size="sm" className="h-8 px-3" disabled={loading !== null} onClick={() => setConfirmRevert(true)}>
              <Undo2 />
              Revert what merged
            </Button>
          ) : null}
          <Button
            size="sm"
            className="h-8 px-3"
            loading={loading === 'keep'}
            disabled={loading !== null}
            onClick={() => void decide('approved', 'keep')}
          >
            <Check />
            {approval.kind === 'partial_merge' ? 'Keep what merged' : 'Leave it'}
          </Button>
          <Dialog open={confirmRevert} onOpenChange={setConfirmRevert} title="Revert what merged?">
            <div className="flex flex-col gap-2 text-sm">
              <p>
                Factorix opens a revert merge request for each one below and merges it, newest first. Any that cannot merge right away wait here for
                you.
              </p>
              <ul className="list-disc pl-5">
                {[...landed].reverse().map((mr) => (
                  <li key={mr.url}>
                    {mr.repoPath} !{mr.iid}
                  </li>
                ))}
              </ul>
              {openElsewhere.length > 0 ? (
                <p>
                  It also closes {openElsewhere.map((mr) => `${mr.repoPath} !${mr.iid}`).join(', ')}, so {openElsewhere.length === 1 ? 'it' : 'they'}{' '}
                  cannot land later.
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button onClick={() => setConfirmRevert(false)}>Cancel</Button>
              <Button
                variant="primary"
                loading={loading === 'revert'}
                disabled={loading !== null}
                onClick={() => {
                  setConfirmRevert(false)
                  void decide('approved', 'revert')
                }}
              >
                Revert
              </Button>
            </DialogFooter>
          </Dialog>
        </div>
      ) : (
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
      )}
    </Card>
  )
}
