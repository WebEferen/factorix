'use client'

import type { ProjectDto } from '@factorix/schemas'
import { AlertTriangle, Container, Loader2, Plus, RefreshCw, Settings2 } from 'lucide-react'
import Link from 'next/link'
import { Suspense, use, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useSWRConfig } from 'swr'
import { ISSUE_PAGE_SIZE, IssuePager, IssueToolbar, useIssueQuery } from '@/modules/issues/issue-filters'
import { IssueBoard, IssueList } from '@/modules/issues/issue-list'
import { api } from '@/modules/lib/api'
import { useAgents, useConnections, useIssues, useProject } from '@/modules/lib/data'
import { AutonomyPicker, pickedFromProject, RepoCommands, RepoPicker, reposForApi, SandboxFields, WebhookSetup } from '@/modules/projects/forms'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { useShell } from '@/modules/shell/state'
import {
  Button,
  buttonStyles,
  Dialog,
  DialogColumns,
  DialogFooter,
  EmptyState,
  ErrorState,
  Field,
  Input,
  ListSkeleton,
  Select,
  Tabs,
  Tooltip,
} from '@/modules/ui'
import { Boundary } from '@/modules/ui/boundary'
import { IssuesArt, NoMatchArt } from '@/modules/ui/empty-art'

type View = 'list' | 'board'
const VIEW_KEY = 'fx-project-view'
const DEFAULT_AGENT = 'first'

function ProjectSettings({
  project,
  open,
  onOpenChange,
  onSaved,
}: {
  project: ProjectDto
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const { data: agents } = useAgents()
  const { data: connections } = useConnections()
  const [name, setName] = useState(project.name)
  const [autonomy, setAutonomy] = useState(project.autonomy)
  const [engineer, setEngineer] = useState(project.defaultEngineerAgentId ?? DEFAULT_AGENT)
  const [reviewer, setReviewer] = useState(project.defaultReviewerAgentId ?? DEFAULT_AGENT)
  const [repos, setRepos] = useState(() => pickedFromProject(project.repos))
  const [sandbox, setSandbox] = useState({
    networkPolicy: project.networkPolicy as string,
    networkAllowlist: project.networkAllowlist.join('\n'),
    networkBypass: project.networkBypass.join('\n'),
    runTimeoutMinutes: String(project.runTimeoutMinutes),
    monthlyBudgetUsd: project.monthlyBudgetUsd?.toString() ?? '',
  })
  const [loading, setLoading] = useState(false)
  const options = (role: string) => [
    { value: DEFAULT_AGENT, label: 'First available' },
    ...(agents?.agents.filter((agent) => agent.archetype.role === role).map((agent) => ({ value: agent.id, label: agent.displayName })) ?? []),
  ]
  const save = async () => {
    setLoading(true)
    try {
      await api.put(`/api/projects/${project.id}`, {
        name,
        autonomy,
        defaultEngineerAgentId: engineer === DEFAULT_AGENT ? null : engineer,
        defaultReviewerAgentId: reviewer === DEFAULT_AGENT ? null : reviewer,
        repos: reposForApi(repos),
        networkPolicy: sandbox.networkPolicy,
        networkAllowlist: sandbox.networkAllowlist
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        networkBypass: sandbox.networkBypass
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        runTimeoutMinutes: Number(sandbox.runTimeoutMinutes),
        monthlyBudgetUsd: sandbox.monthlyBudgetUsd ? Number(sandbox.monthlyBudgetUsd) : null,
      })
      onSaved()
      onOpenChange(false)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Project settings"
      description={project.repos.length === 1 ? project.repos[0]?.scmRepoPath : `${project.repos.length} repositories`}
      wide
    >
      <DialogColumns
        start={
          <>
            <Field label="Name">
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Autonomy</h3>
              <AutonomyPicker value={autonomy} onChange={setAutonomy} />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Default engineer">
                <Select value={engineer} onChange={setEngineer} options={options('engineer')} />
              </Field>
              <Field label="Default reviewer">
                <Select value={reviewer} onChange={setReviewer} options={options('reviewer')} />
              </Field>
            </div>
            <SandboxFields
              value={sandbox}
              onChange={(patch) => setSandbox({ ...sandbox, ...patch })}
              connections={connections?.connections.filter(({ id }) => id === project.trackerConnectionId || id === project.scmConnectionId) ?? []}
            />
          </>
        }
        end={
          <>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Repositories agents can change</h3>
              <RepoPicker connectionId={project.scmConnectionId} value={repos} onChange={setRepos} />
            </div>
            <RepoCommands value={repos} onChange={setRepos} />
            <details className="border-t border-divider pt-4">
              <summary className="cursor-pointer text-sm font-semibold">Webhooks</summary>
              <div className="mt-3">
                <WebhookSetup project={project} />
              </div>
            </details>
          </>
        }
      />
      <DialogFooter>
        <Button variant="primary" loading={loading} disabled={repos.length === 0} onClick={() => void save()}>
          Save changes
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

function ImportStatus({ project, onRetry }: { project: ProjectDto; onRetry: () => void }) {
  if (project.syncState === 'syncing')
    return (
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-divider bg-softer px-4 text-xs text-ink-2" role="status">
        <Loader2 className="size-3.5 animate-spin text-signal" />
        Importing issues from your tracker
        {project.syncedIssueCount > 0 ? <span>{project.syncedIssueCount} so far</span> : null}
      </div>
    )
  if (project.syncState === 'failed')
    return (
      <div className="flex min-h-8 shrink-0 items-center gap-2 border-b border-divider bg-softer px-4 py-1.5 text-xs text-ink-2" role="alert">
        <AlertTriangle className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">{project.syncError ?? 'The import did not finish.'}</span>
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Try again
        </Button>
      </div>
    )
  return null
}

function ProjectView({ id }: { id: string }) {
  const { openNewIssue } = useShell()
  const { data: project, error, mutate } = useProject(id)
  const { query, page, scope, sort, direction, setScope, setSort, update, clear, setPage, active } = useIssueQuery()
  const { mutate: refreshProjects } = useSWRConfig()
  const [view, setView] = useState<View>('list')
  const scoped = { ...query, projectId: id, scope, sort, direction }
  const {
    data: issues,
    error: issuesError,
    mutate: refreshIssues,
  } = useIssues(view === 'list' ? { ...scoped, group: 'state', page: String(page), limit: String(ISSUE_PAGE_SIZE) } : null)
  const [settings, setSettings] = useState(false)
  const importing = project?.project.syncState === 'syncing'

  useEffect(() => {
    try {
      const stored = localStorage.getItem(VIEW_KEY)
      if (stored === 'board' || stored === 'list') setView(stored)
    } catch {}
  }, [])
  const newIssues = project?.project.newIssueCount ?? 0
  useEffect(() => {
    if (newIssues === 0) return
    void api
      .post(`/api/projects/${id}/seen`)
      .then(() => refreshProjects((key) => typeof key === 'string' && key.startsWith('/api/projects')))
      .catch(() => undefined)
  }, [id, newIssues, refreshProjects])
  const changeView = (next: View) => {
    setView(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {}
  }
  const sync = async () => {
    try {
      await api.post(`/api/projects/${id}/sync`)
      void mutate()
    } catch (caught) {
      toast.error((caught as Error).message)
    }
  }

  if (error && !project)
    return (
      <>
        <PageHeader crumbs={[{ label: 'Projects', href: '/projects' }]} />
        <ErrorState error={error} retry={() => void mutate()} />
      </>
    )

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Projects', href: '/projects' }, { label: project?.project.name ?? 'Project' }]}
        below={
          <Tabs
            value={view}
            onChange={changeView}
            tabs={[
              { value: 'list', label: 'List' },
              { value: 'board', label: 'Board' },
            ]}
          />
        }
      >
        <Tooltip label="Sync with the tracker now">
          <Button size="icon" variant="ghost" aria-label="Sync with the tracker" loading={importing} onClick={() => void sync()}>
            {importing ? null : <RefreshCw />}
          </Button>
        </Tooltip>
        <Tooltip label="Environment for previews and agent runs">
          <Link href={`/projects/${id}/environment`} aria-label="Environment" className={buttonStyles({ size: 'icon', variant: 'ghost' })}>
            <Container />
          </Link>
        </Tooltip>
        <Tooltip label="Project settings">
          <Button size="icon" variant="ghost" aria-label="Project settings" onClick={() => setSettings(true)}>
            <Settings2 />
          </Button>
        </Tooltip>
        <Button size="sm" onClick={() => openNewIssue(id)}>
          <Plus />
          New issue
        </Button>
      </PageHeader>
      {project ? <ImportStatus project={project.project} onRetry={() => void sync()} /> : null}
      <Boundary label="the filters" resetKey={id}>
        <IssueToolbar
          projectId={id}
          scope={scope}
          onScope={setScope}
          sort={sort}
          direction={direction}
          onSort={setSort}
          query={query}
          update={update}
          clear={clear}
          active={active}
          placeholder="Search this project"
        />
      </Boundary>
      {view === 'board' ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-x-auto">
          <IssueBoard query={scoped} loading={importing} />
        </div>
      ) : issuesError && !issues ? (
        <ErrorState error={issuesError} retry={() => void refreshIssues()} />
      ) : !issues ? (
        <ListSkeleton />
      ) : issues.issues.length === 0 && importing ? (
        <ListSkeleton rows={12} />
      ) : issues.issues.length === 0 && active ? (
        <EmptyState art={<NoMatchArt />} title="No issues match" action={<Button onClick={clear}>Clear filters</Button>}>
          Try a different search, or remove a filter.
        </EmptyState>
      ) : issues.issues.length === 0 ? (
        <EmptyState
          art={<IssuesArt />}
          title={scope === 'open' ? 'No open issues' : scope === 'closed' ? 'No closed issues' : 'No issues yet'}
          action={
            <Button variant="primary" onClick={() => openNewIssue(id)}>
              New issue
            </Button>
          }
        >
          Issues from your tracker show up here. Create one, or sync if you just connected.
        </EmptyState>
      ) : (
        <>
          <PageBody>
            <Boundary label="this list" resetKey={issues}>
              <IssueList issues={issues.issues} counts={issues.counts} sort={sort} />
            </Boundary>
            {importing && issues.issues.length < issues.limit ? <ListSkeleton rows={5} /> : null}
          </PageBody>
          <IssuePager list={issues} onPage={setPage} />
        </>
      )}
      {project ? (
        <ProjectSettings
          key={project.project.updatedAt}
          project={project.project}
          open={settings}
          onOpenChange={setSettings}
          onSaved={() => void mutate()}
        />
      ) : null}
    </>
  )
}

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return (
    <Suspense fallback={<ListSkeleton />}>
      <ProjectView id={id} />
    </Suspense>
  )
}
