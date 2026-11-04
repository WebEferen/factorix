'use client'

import { Plus } from 'lucide-react'
import { Suspense, useState } from 'react'
import { ISSUE_PAGE_SIZE, IssuePager, IssueToolbar, useIssueQuery } from '@/modules/issues/issue-filters'
import { IssueList } from '@/modules/issues/issue-list'
import { useIssues, useMe } from '@/modules/lib/data'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { useShell } from '@/modules/shell/state'
import { Button, EmptyState, ErrorState, ListSkeleton, Tabs } from '@/modules/ui'
import { Boundary } from '@/modules/ui/boundary'
import { IssuesArt, NoMatchArt } from '@/modules/ui/empty-art'

type View = 'active' | 'mine' | 'all'

const IN_THE_FACTORY = ['queued', 'active', 'waiting_human', 'awaiting_merge', 'failed']

function IssuesView() {
  const [view, setView] = useState<View>('active')
  const { openNewIssue } = useShell()
  const { data: me } = useMe()
  const { query, page, scope, sort, direction, setScope, setSort, update, clear, setPage, active } = useIssueQuery()
  const tab: Record<string, string[]> =
    view === 'active' && !query.factoryState ? { factoryState: IN_THE_FACTORY } : view === 'mine' && me ? { assignee: [me.account.displayName] } : {}
  const { data, error, mutate } = useIssues(
    view === 'mine' && !me ? null : { ...query, ...tab, scope, sort, direction, group: 'state', page: String(page), limit: String(ISSUE_PAGE_SIZE) },
  )
  const issues = data?.issues
  const changeView = (next: View) => {
    setView(next)
    if (page > 1) setPage(1)
  }
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Issues' }]}
        below={
          <Tabs
            value={view}
            onChange={changeView}
            tabs={[
              { value: 'active', label: 'In the factory' },
              { value: 'mine', label: 'Assigned to me' },
              { value: 'all', label: 'All' },
            ]}
          />
        }
      >
        <Button size="sm" onClick={() => openNewIssue()}>
          <Plus />
          New issue
        </Button>
      </PageHeader>
      <Boundary label="the filters">
        <IssueToolbar
          scope={scope}
          onScope={setScope}
          sort={sort}
          direction={direction}
          onSort={setSort}
          query={query}
          update={update}
          clear={clear}
          active={active}
          placeholder="Search all issues"
        />
      </Boundary>
      <PageBody>
        {error && !issues ? (
          <ErrorState error={error} retry={() => void mutate()} />
        ) : !issues ? (
          <ListSkeleton />
        ) : issues.length === 0 && active ? (
          <EmptyState art={<NoMatchArt />} title="No issues match" action={<Button onClick={clear}>Clear filters</Button>}>
            Try a different search, or remove a filter.
          </EmptyState>
        ) : issues.length === 0 ? (
          <EmptyState
            art={<IssuesArt />}
            title={view === 'active' ? 'Nothing is in the factory' : 'No issues here'}
            action={
              <Button variant="primary" onClick={() => openNewIssue()}>
                New issue
              </Button>
            }
          >
            {view === 'active'
              ? 'Assign an agent to an issue, or add its label in your tracker, and the work shows up here.'
              : 'Issues from your projects show up here.'}
          </EmptyState>
        ) : (
          <Boundary label="this list" resetKey={issues}>
            <IssueList issues={issues} showProject counts={data?.counts} sort={sort} />
          </Boundary>
        )}
      </PageBody>
      {data ? <IssuePager list={data} onPage={setPage} /> : null}
    </>
  )
}

export default function IssuesPage() {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <IssuesView />
    </Suspense>
  )
}
