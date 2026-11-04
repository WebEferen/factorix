'use client'

import type { ProjectDto } from '@factorix/schemas'
import { Check } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import useSWR, { mutate } from 'swr'
import { ApiError, api, fetcher } from '@/modules/lib/api'
import { useConnections } from '@/modules/lib/data'
import { cn } from '@/modules/lib/format'
import { AutonomyPicker, type PickedRepo, RepoCommands, RepoPicker, reposForApi, SandboxFields, WebhookSetup } from '@/modules/projects/forms'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { Button, Field, Input, Select, Toggle } from '@/modules/ui'

interface Team {
  id: string
  key: string
  name: string
}
interface TrackerProject {
  id: string
  name: string
}
interface TrackerState {
  id: string
  name: string
  type: string
  position: number
}
const WHOLE_TEAM = 'all'

const STATE_KEYS = [
  { key: 'in_progress', label: 'While an agent works', guess: (state: TrackerState) => state.type === 'started' && /progress/i.test(state.name) },
  { key: 'in_review', label: 'When a merge request is up', guess: (state: TrackerState) => state.type === 'started' && /review/i.test(state.name) },
  { key: 'done', label: 'When it merges', guess: (state: TrackerState) => state.type === 'completed' },
  { key: 'blocked', label: 'When it fails', guess: (state: TrackerState) => /block/i.test(state.name) },
  { key: 'waiting_human', label: 'When it needs a person', guess: () => false },
]

const STEPS = ['Tracker', 'Repositories', 'Workflow', 'Autonomy', 'Webhooks']

export default function NewProjectPage() {
  const router = useRouter()
  const { data: connections } = useConnections()
  const trackers = connections?.connections.filter((connection) => connection.kind === 'linear') ?? []
  const scms = connections?.connections.filter((connection) => connection.kind === 'gitlab') ?? []
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [trackerConnectionId, setTrackerConnectionId] = useState<string>()
  const [trackerTeamId, setTrackerTeamId] = useState<string>()
  const [trackerProjectId, setTrackerProjectId] = useState(WHOLE_TEAM)
  const [scmConnectionId, setScmConnectionId] = useState<string>()
  const [repos, setRepos] = useState<PickedRepo[]>([])
  const [stateMap, setStateMap] = useState<Record<string, string>>({})
  const [triggers, setTriggers] = useState<string[]>([])
  const [autonomy, setAutonomy] = useState<ProjectDto['autonomy']>('human_merge')
  const [sandbox, setSandbox] = useState({
    networkPolicy: 'restricted',
    networkAllowlist: '',
    runTimeoutMinutes: '90',
    monthlyBudgetUsd: '',
  })
  const [loading, setLoading] = useState(false)
  const [created, setCreated] = useState<ProjectDto | null>(null)

  useEffect(() => {
    if (!trackerConnectionId && trackers.length === 1) setTrackerConnectionId(trackers[0]?.id)
    if (!scmConnectionId && scms.length === 1) setScmConnectionId(scms[0]?.id)
  }, [trackers, scms, trackerConnectionId, scmConnectionId])

  const { data: teams, error: teamsError } = useSWR<{ teams: Team[] }>(
    trackerConnectionId ? `/api/tracker/teams?connectionId=${trackerConnectionId}` : null,
    fetcher as never,
  )
  const { data: projects } = useSWR<{ projects: TrackerProject[] }>(
    trackerConnectionId && trackerTeamId ? `/api/tracker/projects?connectionId=${trackerConnectionId}&teamId=${trackerTeamId}` : null,
    fetcher as never,
  )
  const { data: states } = useSWR<{ states: TrackerState[] }>(
    trackerConnectionId && trackerTeamId ? `/api/tracker/states?connectionId=${trackerConnectionId}&teamId=${trackerTeamId}` : null,
    fetcher as never,
  )
  useEffect(() => {
    if (!states) return
    const map: Record<string, string> = {}
    for (const { key, guess } of STATE_KEYS) {
      const match = states.states.find(guess)
      if (match) map[key] = match.id
    }
    setStateMap(map)
    setTriggers(states.states.filter((state) => state.type === 'unstarted').map((state) => state.name))
  }, [states])

  const team = teams?.teams.find((item) => item.id === trackerTeamId)
  // biome-ignore lint/correctness/useExhaustiveDependencies: suggest a name only when the team changes, never over what someone typed
  useEffect(() => {
    if (team && !name) setName(team.name)
  }, [team])

  const canContinue = [
    Boolean(trackerConnectionId && trackerTeamId && name.trim()),
    Boolean(scmConnectionId && repos.length > 0),
    Boolean(stateMap.in_progress && stateMap.in_review && stateMap.done && triggers.length > 0),
    true,
    true,
  ][step]

  const create = async () => {
    setLoading(true)
    try {
      const { project } = await api.post<{ project: ProjectDto }>('/api/projects', {
        name,
        trackerConnectionId,
        trackerTeamId,
        trackerProjectId: trackerProjectId === WHOLE_TEAM ? null : trackerProjectId,
        scmConnectionId,
        repos: reposForApi(repos),
        autonomy,
        stateMap,
        trigger: { states: triggers },
        networkPolicy: sandbox.networkPolicy,
        networkAllowlist: sandbox.networkAllowlist
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        runTimeoutMinutes: Number(sandbox.runTimeoutMinutes),
        monthlyBudgetUsd: sandbox.monthlyBudgetUsd ? Number(sandbox.monthlyBudgetUsd) : null,
      })
      void mutate('/api/projects')
      setCreated(project)
      setStep(4)
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not create the project.')
    } finally {
      setLoading(false)
    }
  }

  const missing = connections && (trackers.length === 0 || scms.length === 0)

  return (
    <>
      <PageHeader crumbs={[{ label: 'Projects', href: '/projects' }, { label: 'New project' }]} />
      <PageBody>
        <div className="mx-auto max-w-2xl p-4 sm:p-6">
          <ol className="mb-8 flex items-center gap-2 overflow-x-auto" aria-label="Progress">
            {STEPS.map((label, index) => (
              <li key={label} className="flex shrink-0 items-center gap-2 text-sm" aria-current={index === step ? 'step' : undefined}>
                <span
                  className={cn(
                    'flex size-5 items-center justify-center rounded-full text-xs tabular-nums',
                    index < step
                      ? 'bg-action text-action-ink'
                      : index === step
                        ? 'border-2 border-signal text-ink'
                        : 'border border-field text-ink-3',
                  )}
                >
                  {index < step ? <Check className="size-3" /> : index + 1}
                </span>
                <span className={index === step ? 'text-ink' : 'text-ink-2'}>{label}</span>
                {index < STEPS.length - 1 ? <span className="mx-1 h-px w-5 bg-divider" /> : null}
              </li>
            ))}
          </ol>

          {missing ? (
            <div className="rounded-md border border-divider p-4">
              <p className="text-sm">A project needs a Linear connection and a GitLab connection first.</p>
              <Link href="/settings/connections" className="mt-3 inline-block">
                <Button variant="primary">Go to connections</Button>
              </Link>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {step === 0 ? (
                <>
                  <h1 className="text-xl font-semibold">Which issues should this project follow?</h1>
                  <Field label="Linear connection">
                    <Select
                      value={trackerConnectionId}
                      onChange={setTrackerConnectionId}
                      options={trackers.map((item) => ({ value: item.id, label: item.name }))}
                    />
                  </Field>
                  <Field label="Team" error={teamsError ? (teamsError as Error).message : undefined}>
                    <Select
                      value={trackerTeamId}
                      onChange={setTrackerTeamId}
                      placeholder={teams ? 'Choose a team' : 'Loading teams'}
                      disabled={!teams}
                      options={teams?.teams.map((item) => ({ value: item.id, label: `${item.key} ${item.name}` })) ?? []}
                    />
                  </Field>
                  <Field label="Linear project" hint="Follow one Linear project, or everything in the team.">
                    <Select
                      value={trackerProjectId}
                      onChange={setTrackerProjectId}
                      disabled={!projects}
                      options={[
                        { value: WHOLE_TEAM, label: 'The whole team' },
                        ...(projects?.projects.map((item) => ({ value: item.id, label: item.name })) ?? []),
                      ]}
                    />
                  </Field>
                  <Field label="Project name">
                    <Input required value={name} onChange={(event) => setName(event.target.value)} />
                  </Field>
                </>
              ) : null}

              {step === 1 ? (
                <>
                  <h1 className="text-xl font-semibold">Which repositories can agents change?</h1>
                  <Field label="GitLab connection">
                    <Select
                      value={scmConnectionId}
                      onChange={(value) => {
                        setScmConnectionId(value)
                        setRepos([])
                      }}
                      options={scms.map((item) => ({ value: item.id, label: item.name }))}
                    />
                  </Field>
                  <RepoPicker connectionId={scmConnectionId} value={repos} onChange={setRepos} />
                </>
              ) : null}

              {step === 2 ? (
                <>
                  <h1 className="text-xl font-semibold">How does the work move in Linear?</h1>
                  <p className="text-sm text-ink-2">
                    Factorix moves an issue through these states. If someone moves it by hand, Factorix leaves it alone and logs that.
                  </p>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {STATE_KEYS.map(({ key, label }) => (
                      <Field key={key} label={label}>
                        <Select
                          value={stateMap[key]}
                          onChange={(value) => setStateMap({ ...stateMap, [key]: value })}
                          placeholder={key === 'blocked' || key === 'waiting_human' ? 'Leave as is' : 'Choose a state'}
                          options={states?.states.map((state) => ({ value: state.id, label: state.name })) ?? []}
                        />
                      </Field>
                    ))}
                  </div>
                  <div className="flex flex-col gap-2 border-t border-divider pt-4">
                    <h2 className="text-sm font-semibold">Start work when an agent label lands on an issue in</h2>
                    {states?.states
                      .filter((state) => state.type !== 'completed' && state.type !== 'canceled')
                      .map((state) => (
                        <Toggle
                          key={state.id}
                          checked={triggers.includes(state.name)}
                          label={state.name}
                          onChange={(on) => setTriggers(on ? [...triggers, state.name] : triggers.filter((value) => value !== state.name))}
                        />
                      ))}
                  </div>
                </>
              ) : null}

              {step === 3 ? (
                <>
                  <h1 className="text-xl font-semibold">How much can agents do alone?</h1>
                  <AutonomyPicker value={autonomy} onChange={setAutonomy} />
                  <div className="border-t border-divider pt-4">
                    <RepoCommands value={repos} onChange={setRepos} />
                  </div>
                  <div className="border-t border-divider pt-4">
                    <SandboxFields
                      value={sandbox}
                      onChange={(patch) => setSandbox({ ...sandbox, ...patch })}
                      connections={connections?.connections.filter(({ id }) => id === trackerConnectionId || id === scmConnectionId) ?? []}
                    />
                  </div>
                </>
              ) : null}

              {step === 4 && created ? (
                <>
                  <div>
                    <h1 className="text-xl font-semibold">{created.name} is ready</h1>
                    <p className="mt-1 text-sm text-ink-2">Its issues are importing in the background, so you can open it right away.</p>
                  </div>
                  <WebhookSetup project={created} onDone={() => router.push(`/projects/${created.id}`)} />
                  <div className="flex justify-end border-t border-divider pt-4">
                    <Button variant="primary" onClick={() => router.push(`/projects/${created.id}`)}>
                      Open project
                    </Button>
                  </div>
                </>
              ) : null}

              {step < 4 ? (
                <div className="mt-2 flex justify-between border-t border-divider pt-4">
                  <Button disabled={step === 0} onClick={() => setStep(step - 1)}>
                    Back
                  </Button>
                  {step < 3 ? (
                    <Button variant="primary" disabled={!canContinue} onClick={() => setStep(step + 1)}>
                      Continue
                    </Button>
                  ) : (
                    <Button variant="primary" loading={loading} onClick={() => void create()}>
                      Create project
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </PageBody>
    </>
  )
}
