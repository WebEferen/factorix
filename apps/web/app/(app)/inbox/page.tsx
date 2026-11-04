'use client'

import type { IssueDto } from '@factorix/schemas'
import { RotateCcw } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { refreshIssueData } from '@/modules/issues/agent-picker'
import { ApprovalCard } from '@/modules/issues/approval-card'
import { FactoryStateIcon } from '@/modules/issues/icons'
import { api } from '@/modules/lib/api'
import { useInbox } from '@/modules/lib/data'
import { timeAgo } from '@/modules/lib/format'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { Button, Card, EmptyState, ErrorState, ListSkeleton, SectionTitle } from '@/modules/ui'
import { InboxArt } from '@/modules/ui/empty-art'

function FailedRow({ issue }: { issue: IssueDto }) {
  const retry = async () => {
    try {
      await api.post(`/api/issues/${issue.id}/retry`)
      refreshIssueData()
      toast.success(`${issue.identifier} is back in the factory`)
    } catch (error) {
      toast.error((error as Error).message)
    }
  }
  return (
    <div className="flex items-center gap-3 border-b border-divider px-4 py-2.5 last:border-b-0">
      <FactoryStateIcon state="failed" />
      <Link href={`/issues/${issue.id}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
        <span className="text-ink-2">{issue.identifier}</span> {issue.title}
      </Link>
      <span className="text-xs text-ink-3">{timeAgo(issue.updatedAt)}</span>
      <Button size="sm" onClick={() => void retry()}>
        <RotateCcw />
        Retry
      </Button>
    </div>
  )
}

export default function InboxPage() {
  const { data, error, mutate } = useInbox()
  const empty = data && data.approvals.length === 0 && data.failedIssues.length === 0
  return (
    <>
      <PageHeader crumbs={[{ label: 'Inbox' }]} />
      <PageBody>
        {error && !data ? (
          <ErrorState error={error} retry={() => void mutate()} />
        ) : !data ? (
          <ListSkeleton rows={4} />
        ) : empty ? (
          <EmptyState art={<InboxArt />} title="You are all caught up">
            Plans to sign off, merges to approve, and failed work land here.
          </EmptyState>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-6">
            {data.approvals.length > 0 ? (
              <section>
                <SectionTitle>Waiting on you</SectionTitle>
                <div className="flex flex-col gap-3">
                  {data.approvals.map((approval) => (
                    <div key={approval.id}>
                      {approval.issueId ? (
                        <Link href={`/issues/${approval.issueId}`} className="mb-1.5 block truncate text-sm text-ink-2 hover:text-ink">
                          {approval.issueIdentifier} {approval.issueTitle}
                        </Link>
                      ) : null}
                      <ApprovalCard approval={approval} />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            {data.failedIssues.length > 0 ? (
              <section>
                <SectionTitle>Failed</SectionTitle>
                <Card>
                  {data.failedIssues.map((issue) => (
                    <FailedRow key={issue.id} issue={issue} />
                  ))}
                </Card>
              </section>
            ) : null}
          </div>
        )}
      </PageBody>
    </>
  )
}
