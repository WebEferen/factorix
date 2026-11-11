'use client'

import { type ConnectionDto, type EgressGroup, egressGroups, type ProjectDto, type ProjectRepoDto } from '@factorix/schemas'
import { Check, CheckCircle2, ChevronRight, CircleAlert, Plus, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { api, fetcher } from '../lib/api'
import { useConnections, useNetworkSettings } from '../lib/data'
import { cn } from '../lib/format'
import { Button, CopyField, Field, Input, Select } from '../ui'

interface ScmRepoOption {
  id: string
  path: string
  cloneUrl: string
  defaultBranch: string
}

export interface PickedRepo {
  scmRepoId: string
  scmRepoPath: string
  scmCloneUrl: string
  defaultBranch: string
  setupCommands: string[]
  checkCommands: string[]
}

export function pickedFromProject(repos: ProjectRepoDto[]): PickedRepo[] {
  return repos.map((repo) => ({
    scmRepoId: repo.scmRepoId,
    scmRepoPath: repo.scmRepoPath,
    scmCloneUrl: repo.scmCloneUrl,
    defaultBranch: repo.defaultBranch,
    setupCommands: repo.setupCommands,
    checkCommands: repo.checkCommands,
  }))
}

export function reposForApi(repos: PickedRepo[]) {
  const filled = (commands: string[]) => commands.map((command) => command.trim()).filter(Boolean)
  return repos.map((repo) => ({ ...repo, setupCommands: filled(repo.setupCommands), checkCommands: filled(repo.checkCommands) }))
}

export function RepoPicker({
  connectionId,
  value,
  onChange,
}: {
  connectionId?: string
  value: PickedRepo[]
  onChange: (repos: PickedRepo[]) => void
}) {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250)
    return () => clearTimeout(timer)
  }, [search])
  const { data, error } = useSWR<{ repos: ScmRepoOption[] }>(
    connectionId ? `/api/scm/repos?connectionId=${connectionId}${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}` : null,
    fetcher as never,
    { keepPreviousData: true },
  )
  const toggle = (repo: ScmRepoOption) =>
    onChange(
      value.some((picked) => picked.scmRepoId === repo.id)
        ? value.filter((picked) => picked.scmRepoId !== repo.id)
        : [
            ...value,
            {
              scmRepoId: repo.id,
              scmRepoPath: repo.path,
              scmCloneUrl: repo.cloneUrl,
              defaultBranch: repo.defaultBranch,
              setupCommands: [],
              checkCommands: [],
            },
          ],
    )
  return (
    <div className="flex flex-col gap-3">
      <Field label="Search repositories" hint="Agents cannot change anything you leave out." error={error ? (error as Error).message : undefined}>
        <Input placeholder="group/project" value={search} onChange={(event) => setSearch(event.target.value)} />
      </Field>
      <div
        role="listbox"
        aria-multiselectable="true"
        aria-label="Repositories"
        className="scroll-thin max-h-60 overflow-y-auto rounded-md border border-divider"
      >
        {data?.repos.map((repo) => {
          const picked = value.some((item) => item.scmRepoId === repo.id)
          return (
            <button
              key={repo.id}
              type="button"
              role="option"
              aria-selected={picked}
              onClick={() => toggle(repo)}
              className={cn(
                'flex w-full items-center gap-2.5 border-b border-divider px-3 py-2 text-left text-sm transition-colors duration-75 last:border-b-0',
                picked ? 'bg-selected' : 'hover:bg-softer',
              )}
            >
              <span
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded border',
                  picked ? 'border-action bg-action text-action-ink' : 'border-field',
                )}
                aria-hidden="true"
              >
                {picked ? <Check className="size-3" /> : null}
              </span>
              <span className="min-w-0 flex-1 truncate">{repo.path}</span>
              <span className="text-xs text-ink-3">{repo.defaultBranch}</span>
            </button>
          )
        })}
        {data && data.repos.length === 0 ? <p className="p-3 text-sm text-ink-2">No repositories match.</p> : null}
        {!data && !error ? <p className="p-3 text-sm text-ink-3">Loading</p> : null}
      </div>
      {value.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <h2 className="text-sm font-semibold">
            {value.length === 1 ? 'Agents can change this repository' : `Agents can change these ${value.length} repositories`}
          </h2>
          <ul className="flex flex-wrap gap-1.5">
            {value.map((repo) => (
              <li
                key={repo.scmRepoId}
                className="flex max-w-full min-w-0 items-center gap-0.5 rounded-md border border-divider bg-softer py-0.5 pr-0.5 pl-2 text-sm"
              >
                <span className="min-w-0 truncate">{repo.scmRepoPath}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={`Remove ${repo.scmRepoPath}`}
                  onClick={() => onChange(value.filter((item) => item.scmRepoId !== repo.scmRepoId))}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
          {value.length > 1 ? (
            <p className="text-xs text-ink-2">
              Each ticket changes only the ones it needs, with one merge request per repository. The agent decides the merge order for each ticket.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const AUTONOMY_OPTIONS = [
  {
    value: 'plan_first',
    title: 'Plan first',
    text: 'The agent writes a plan. A person signs it off before any code is written, and a person merges.',
  },
  { value: 'human_merge', title: 'Human merges', text: 'The agent implements and the reviewer reviews. A person merges.' },
  { value: 'full_auto', title: 'Full auto', text: 'Once the reviewer approves and CI is green, the factory merges by itself.' },
] as const

export function AutonomyPicker({ value, onChange }: { value: string; onChange: (value: ProjectDto['autonomy']) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">Autonomy</legend>
      {AUTONOMY_OPTIONS.map((option) => (
        <label
          key={option.value}
          className={cn(
            'cursor-pointer rounded-md border p-3 transition-colors duration-100 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-signal',
            value === option.value ? 'border-signal bg-selected/50' : 'border-divider hover:border-field hover:bg-softer',
          )}
        >
          <input type="radio" name="autonomy" className="sr-only" checked={value === option.value} onChange={() => onChange(option.value)} />
          <span className="block text-sm font-semibold">{option.title}</span>
          <span className="mt-0.5 block text-xs text-ink-2">{option.text}</span>
        </label>
      ))}
    </fieldset>
  )
}

function CommandList({
  title,
  repoPath,
  addLabel,
  placeholder,
  commands,
  onChange,
}: {
  title: string
  repoPath: string
  addLabel: string
  placeholder: string
  commands: string[]
  onChange: (commands: string[]) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-xs text-ink-2">{title}</h4>
      {commands.map((command, index) => (
        <div key={index} className="flex items-center gap-1">
          <Input
            autoFocus={!command}
            aria-label={`${title} ${index + 1} in ${repoPath}`}
            className="font-mono text-xs"
            placeholder={placeholder}
            value={command}
            onChange={(event) => onChange(commands.map((item, position) => (position === index ? event.target.value : item)))}
          />
          <Button
            size="iconMd"
            variant="ghost"
            className="shrink-0"
            aria-label={`Remove ${title.toLowerCase()} ${index + 1} in ${repoPath}`}
            onClick={() => onChange(commands.filter((_, position) => position !== index))}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="-ml-2 self-start"
        aria-label={`${addLabel} in ${repoPath}`}
        onClick={() => onChange([...commands, ''])}
      >
        <Plus />
        {addLabel}
      </Button>
    </div>
  )
}

function commandSummary(repo: PickedRepo): string {
  const setup = repo.setupCommands.filter((command) => command.trim()).length
  const checks = repo.checkCommands.filter((command) => command.trim()).length
  if (setup === 0 && checks === 0) return 'No commands'
  return [setup > 0 ? `${setup} setup` : '', checks > 0 ? `${checks} ${checks === 1 ? 'check' : 'checks'}` : ''].filter(Boolean).join(', ')
}

export function RepoCommands({ value, onChange }: { value: PickedRepo[]; onChange: (repos: PickedRepo[]) => void }) {
  const change = (scmRepoId: string, patch: Partial<PickedRepo>) =>
    onChange(value.map((repo) => (repo.scmRepoId === scmRepoId ? { ...repo, ...patch } : repo)))
  return (
    <div className="flex flex-col gap-2">
      <div>
        <h3 className="text-sm font-semibold">Commands</h3>
        <p className="mt-0.5 text-xs text-ink-2">
          {value.length > 1 ? 'Setup prepares a repository before the agent works in it.' : 'Setup runs after checkout, with no git credentials.'}{' '}
          Checks are what the agent is told to run and fix before it finishes.
        </p>
      </div>
      <div className="divide-y divide-divider rounded-md border border-divider">
        {value.map((repo, index) => (
          <details key={repo.scmRepoId} open={index === 0} className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm transition-colors duration-75 hover:bg-softer [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 shrink-0 text-ink-3 transition-transform duration-100 group-open:rotate-90" />
              <span className="min-w-0 flex-1 truncate">{repo.scmRepoPath}</span>
              <span className="shrink-0 text-xs text-ink-3">{commandSummary(repo)}</span>
            </summary>
            <div className="flex flex-col gap-3 px-3 pt-1 pb-3">
              <CommandList
                title="Setup"
                repoPath={repo.scmRepoPath}
                addLabel="Add setup command"
                placeholder="yarn install --frozen-lockfile"
                commands={repo.setupCommands}
                onChange={(setupCommands) => change(repo.scmRepoId, { setupCommands })}
              />
              <CommandList
                title="Checks"
                repoPath={repo.scmRepoPath}
                addLabel="Add check"
                placeholder="yarn test"
                commands={repo.checkCommands}
                onChange={(checkCommands) => change(repo.scmRepoId, { checkCommands })}
              />
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}

export function HostGroups({ groups, className }: { groups: EgressGroup[]; className?: string }) {
  return (
    <dl className={cn('flex flex-col gap-2 rounded-md border border-field px-3 py-2 text-xs', className)}>
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <dt className="text-ink-2">{group.label}</dt>
          <dd className="break-words font-mono text-ink">{group.hosts.join(', ')}</dd>
        </div>
      ))}
    </dl>
  )
}

function DefaultHosts({ connections }: { connections: ConnectionDto[] }) {
  const { data } = useNetworkSettings()
  const groups = egressGroups(data?.network ?? { mode: 'extend', hosts: [] }, connections)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-ink">Allowed by default</span>
        <Link href="/settings/network" target="_blank" className="text-xs text-ink-2 hover:text-ink">
          Change in Settings
        </Link>
      </div>
      {groups.length > 0 ? (
        <HostGroups groups={groups} />
      ) : (
        <p className="text-xs text-ink-2">Nothing. Your organization uses its own list, and it is empty.</p>
      )}
    </div>
  )
}

export function SandboxFields({
  value,
  onChange,
  connections,
}: {
  value: {
    networkPolicy: string
    networkAllowlist: string
    networkBypass: string
    runTimeoutMinutes: string
    monthlyBudgetUsd: string
  }
  onChange: (
    patch: Partial<{
      networkPolicy: string
      networkAllowlist: string
      networkBypass: string
      runTimeoutMinutes: string
      monthlyBudgetUsd: string
    }>,
  ) => void
  connections: ConnectionDto[]
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Network for agents"
        hint={
          value.networkPolicy === 'restricted'
            ? 'Model APIs and the hosts listed below. Agents hold no git token, so they can read public code but cannot push.'
            : value.networkPolicy === 'open'
              ? 'Any public host. Private addresses stay blocked.'
              : 'Model APIs only.'
        }
      >
        <Select
          value={value.networkPolicy}
          onChange={(networkPolicy) => onChange({ networkPolicy })}
          options={[
            { value: 'restricted', label: 'Restricted' },
            { value: 'open', label: 'Open' },
            { value: 'none', label: 'None' },
          ]}
        />
      </Field>
      {value.networkPolicy === 'restricted' ? <DefaultHosts connections={connections} /> : null}
      {value.networkPolicy === 'restricted' ? (
        <Field
          label="Extra allowed hosts"
          hint="One per line. *.example.com and internal names work too, though never Factorix's own services. Applies from the next run."
        >
          <textarea
            className="min-h-16 w-full rounded-md border border-field bg-surface px-3 py-2 font-mono text-xs"
            value={value.networkAllowlist}
            onChange={(event) => onChange({ networkAllowlist: event.target.value })}
          />
        </Field>
      ) : null}
      <Field
        label="Skip the proxy for"
        hint="One per line. Names that only exist inside a run, like hosts a test suite fakes. Tools connect to them directly, which reaches nothing outside the run."
      >
        <textarea
          className="min-h-16 w-full rounded-md border border-field bg-surface px-3 py-2 font-mono text-xs"
          value={value.networkBypass}
          onChange={(event) => onChange({ networkBypass: event.target.value })}
        />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Time limit per run (minutes)">
          <Input
            type="number"
            min="1"
            max="1440"
            value={value.runTimeoutMinutes}
            onChange={(event) => onChange({ runTimeoutMinutes: event.target.value })}
          />
        </Field>
        <Field label="Monthly budget (USD)" hint="Runs stop when the project reaches it.">
          <Input
            type="number"
            min="1"
            placeholder="No limit"
            value={value.monthlyBudgetUsd}
            onChange={(event) => onChange({ monthlyBudgetUsd: event.target.value })}
          />
        </Field>
      </div>
    </div>
  )
}

interface WebhookResult {
  kind: string
  repoPath?: string
  registered: boolean
  error?: string
  url?: string
}

export function WebhookSetup({ project, onDone }: { project: ProjectDto; onDone?: () => void }) {
  const { data: connections } = useConnections()
  const [results, setResults] = useState<WebhookResult[] | null>(null)
  const [loading, setLoading] = useState(false)
  const register = async () => {
    setLoading(true)
    try {
      setResults((await api.post<{ results: WebhookResult[] }>(`/api/projects/${project.id}/webhooks`)).results)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setLoading(false)
    }
  }
  const relevant =
    connections?.connections.filter((connection) => connection.id === project.trackerConnectionId || connection.id === project.scmConnectionId) ?? []
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-2">
        Webhooks tell Factorix about labels, comments, merges, and CI as they happen. Without them it still catches up by polling every few minutes.
      </p>
      <div className="flex items-center gap-2">
        <Button variant="primary" loading={loading} onClick={() => void register()}>
          Register automatically
        </Button>
        {onDone ? <Button onClick={onDone}>Skip for now</Button> : null}
      </div>
      {results ? (
        <ul className="flex flex-col gap-1.5">
          {results.map((result) => (
            <li key={result.repoPath ?? result.kind} className="flex items-start gap-2 text-sm">
              {result.registered ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning-ink" />
              )}
              <span className="min-w-0 break-words">
                {result.repoPath ?? result.kind}: {result.registered ? 'registered' : (result.error ?? 'not registered')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {results?.some((result) => !result.registered) ? (
        <p className="text-sm text-ink-2">Set up the ones that failed by hand with these values.</p>
      ) : null}
      {relevant.map((connection) =>
        connection.webhookUrl ? (
          <div key={connection.id} className="flex flex-col gap-2 rounded-md border border-divider p-3">
            <div className="text-sm font-semibold">{connection.name}</div>
            <CopyField label="URL" value={connection.webhookUrl} />
            {connection.webhookSecret ? (
              <CopyField label={connection.kind === 'gitlab' ? 'Secret token' : 'Signing secret'} value={connection.webhookSecret} secret />
            ) : null}
          </div>
        ) : null,
      )}
    </div>
  )
}
