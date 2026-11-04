'use client'

import { CheckCircle2, Circle, FolderKanban, Plus } from 'lucide-react'
import Link from 'next/link'
import { useConnections, useProjects } from '@/modules/lib/data'
import { money, titleCase } from '@/modules/lib/format'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { Button, Card, Chip, ErrorState, ListSkeleton } from '@/modules/ui'
import { ProjectsArt } from '@/modules/ui/empty-art'

const AUTONOMY: Record<string, string> = { plan_first: 'Plan first', human_merge: 'Human merges', full_auto: 'Full auto' }

function Step({ done, children, href, action }: { done: boolean; children: React.ReactNode; href: string; action: string }) {
  return (
    <li className="flex items-center gap-3 border-b border-divider px-4 py-3 last:border-b-0">
      {done ? <CheckCircle2 className="size-5 shrink-0 text-success" /> : <Circle className="size-5 shrink-0 text-ink-3" />}
      <span className={`min-w-0 flex-1 text-sm ${done ? 'text-ink-2' : ''}`}>{children}</span>
      {done ? null : (
        <Link href={href}>
          <Button size="sm">{action}</Button>
        </Link>
      )}
    </li>
  )
}

export default function ProjectsPage() {
  const { data, error, mutate } = useProjects()
  const { data: connections } = useConnections()
  const has = (...kinds: string[]) => connections?.connections.some((connection) => kinds.includes(connection.kind)) ?? false
  return (
    <>
      <PageHeader crumbs={[{ label: 'Projects' }]}>
        <Link href="/projects/new">
          <Button size="sm">
            <Plus />
            New project
          </Button>
        </Link>
      </PageHeader>
      <PageBody>
        {error && !data ? (
          <ErrorState error={error} retry={() => void mutate()} />
        ) : !data ? (
          <ListSkeleton rows={4} />
        ) : data.projects.length === 0 ? (
          <div className="mx-auto max-w-xl p-4 sm:p-10">
            <div className="mb-5 w-full max-w-60">
              <ProjectsArt />
            </div>
            <h1 className="text-xl font-semibold">Set up your first project</h1>
            <p className="mt-1 mb-5 text-sm text-ink-2">
              A project joins a Linear team to a GitLab repository, so agents can pick up issues and open merge requests.
            </p>
            <Card>
              <ol>
                <Step done={has('linear')} href="/settings/connections" action="Connect">
                  Connect Linear
                </Step>
                <Step done={has('gitlab')} href="/settings/connections" action="Connect">
                  Connect GitLab
                </Step>
                <Step done={has('anthropic', 'openai')} href="/settings/connections" action="Add key">
                  Add an Anthropic or OpenAI key
                </Step>
                <Step done={false} href="/projects/new" action="Create">
                  Create the project
                </Step>
              </ol>
            </Card>
          </div>
        ) : (
          data.projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="flex h-14 items-center gap-3 border-b border-divider px-4 transition-colors duration-75 hover:bg-softer"
            >
              <FolderKanban className="size-5 shrink-0 text-ink-2" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{project.name}</div>
                <div className="truncate text-xs text-ink-2">{project.repos.map((repo) => repo.scmRepoPath).join(', ')}</div>
              </div>
              {project.activeIssueCount ? <Chip tone="info">{project.activeIssueCount} active</Chip> : null}
              {project.syncState === 'syncing' ? <Chip tone="info">Importing</Chip> : null}
              {project.syncState === 'failed' ? <Chip tone="danger">Import failed</Chip> : null}
              <span className="hidden text-xs text-ink-2 sm:block">{project.issueCount ?? 0} issues</span>
              <Chip tone="outline" className="hidden sm:inline-flex">
                {AUTONOMY[project.autonomy] ?? titleCase(project.autonomy)}
              </Chip>
              {project.spendThisMonthUsd ? (
                <span className="hidden w-16 text-right text-xs text-ink-2 md:block">{money(project.spendThisMonthUsd)}</span>
              ) : null}
            </Link>
          ))
        )}
      </PageBody>
    </>
  )
}
