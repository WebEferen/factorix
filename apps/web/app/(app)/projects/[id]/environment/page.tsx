'use client'

import {
  type ConnectionDto,
  ENVIRONMENT_EXAMPLE,
  type EnvironmentDefinition,
  type EnvironmentDto,
  type EnvironmentFile,
  type EnvironmentTestDto,
  importSecretSets,
  matchConnections,
  parseEnvironment,
  readEnvironmentFile,
  type SecretSetDto,
  type SecretSetInput,
} from '@factorix/schemas'
import { CircleAlert, CircleCheck, Download, FlaskConical, KeyRound, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import Link from 'next/link'
import { use, useDeferredValue, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ApiError, api } from '@/modules/lib/api'
import { useConnections, useEnvironment, useMe, useProject, useSecretSourceConfigs, useSecretSourceProjects } from '@/modules/lib/data'
import { timeAgo } from '@/modules/lib/format'
import { YamlEditor } from '@/modules/projects/yaml-editor'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import {
  Button,
  buttonStyles,
  Card,
  Chip,
  Dialog,
  DialogFooter,
  ErrorState,
  Field,
  Input,
  ListSkeleton,
  SectionTitle,
  Select,
  Toggle,
} from '@/modules/ui'

type SetDraft = SecretSetInput

const SOURCE_KINDS = new Set(['doppler', 'generic'])
const LEAVE_OUT = 'leave-out'
const sourceLabel = (kind: string) => (kind === 'doppler' ? 'Doppler' : kind === 'generic' ? 'Environment secret' : kind)
const toDraft = ({ connectionName: _name, connectionKind: _kind, ...set }: SecretSetDto): SetDraft => set
const savedWhen = (at: string) => (timeAgo(at) === 'now' ? 'just now' : `${timeAgo(at)} ago`)
const keyCount = (count: number) => `${count} ${count === 1 ? 'key' : 'keys'}`
const keyList = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((key) => key.trim())
    .filter(Boolean)

function OptionPicker({
  label,
  options,
  value,
  onChange,
  loading,
  placeholder,
}: {
  label: string
  options: { id: string; name: string; detail: string | null }[] | null | undefined
  value: string | null
  onChange: (value: string | null) => void
  loading: boolean
  placeholder: string
}) {
  if (options) {
    return (
      <Field label={label}>
        <Select
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          options={options.map((option) => ({ value: option.id, label: option.name, hint: option.detail ?? undefined }))}
        />
      </Field>
    )
  }
  return (
    <Field label={label} hint={loading ? 'Loading…' : options === null ? 'This token reaches one place. Leave blank to use it.' : undefined}>
      <Input value={value ?? ''} placeholder={placeholder} onChange={(event) => onChange(event.target.value.trim() || null)} />
    </Field>
  )
}

function SecretSetDialog({
  set,
  taken,
  connections,
  open,
  onOpenChange,
  onSave,
}: {
  set: SetDraft | null
  taken: string[]
  connections: ConnectionDto[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (set: SetDraft) => void
}) {
  const sources = connections.filter((connection) => SOURCE_KINDS.has(connection.kind))
  const [name, setName] = useState(set?.name ?? '')
  const [connectionId, setConnectionId] = useState<string | null>(set?.connectionId ?? sources[0]?.id ?? null)
  const [project, setProject] = useState<string | null>(set?.project ?? null)
  const [config, setConfig] = useState<string | null>(set?.config ?? null)
  const [only, setOnly] = useState(set?.only.join(', ') ?? '')
  const [except, setExcept] = useState(set?.except.join(', ') ?? '')
  const [agents, setAgents] = useState(set?.agents ?? false)
  const connection = sources.find((candidate) => candidate.id === connectionId)
  const scoped = connection?.kind === 'doppler'
  const projects = useSecretSourceProjects(scoped ? (connectionId ?? null) : null)
  const configs = useSecretSourceConfigs(scoped ? (connectionId ?? null) : null, project)
  const nameError = !/^[a-z][a-z0-9-]{0,30}$/.test(name)
    ? 'Use lowercase letters, digits, and dashes, starting with a letter'
    : taken.includes(name)
      ? 'Another set has this name'
      : undefined

  const submit = () => {
    if (!connectionId || nameError) return
    onSave({
      name,
      connectionId,
      project: scoped ? project : null,
      config: scoped ? config : null,
      only: keyList(only),
      except: keyList(except),
      agents,
    })
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={set ? `Secret set ${set.name}` : 'Add a secret set'}
      description="Values a service reads by naming this set."
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" error={name ? nameError : undefined} hint="Services list it under secrets.">
          <Input value={name} placeholder="backend" onChange={(event) => setName(event.target.value.trim())} />
        </Field>
        {sources.length === 0 ? (
          <p className="text-sm text-ink-2">
            Add a Doppler or Environment secret connection in{' '}
            <Link className="text-link hover:underline" href="/settings/connections">
              Connections
            </Link>{' '}
            first.
          </p>
        ) : (
          <Field label="Source">
            <Select
              value={connectionId}
              onChange={(value) => {
                setConnectionId(value)
                setProject(null)
                setConfig(null)
              }}
              options={sources.map((source) => ({
                value: source.id,
                label: source.name,
                hint: source.kind === 'doppler' ? 'Doppler' : 'Environment secret',
              }))}
            />
          </Field>
        )}
        {scoped ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <OptionPicker
              label="Project"
              options={projects.data?.projects}
              loading={projects.isLoading}
              value={project}
              onChange={(value) => {
                setProject(value)
                setConfig(null)
              }}
              placeholder="backend"
            />
            <OptionPicker
              label="Config"
              options={project ? configs.data?.configs : projects.data?.projects === null ? null : undefined}
              loading={Boolean(project) && configs.isLoading}
              value={config}
              onChange={setConfig}
              placeholder="dev"
            />
          </div>
        ) : null}
        {projects.error ? <p className="text-xs text-danger-ink">{(projects.error as Error).message}</p> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Only these keys" hint="Blank keeps every key.">
            <Input value={only} placeholder="API_KEY, NPM_TOKEN" onChange={(event) => setOnly(event.target.value)} />
          </Field>
          <Field label="Leave out" hint="Removed after Only.">
            <Input value={except} placeholder="STRIPE_SECRET" onChange={(event) => setExcept(event.target.value)} />
          </Field>
        </div>
        <Toggle
          checked={agents}
          onChange={setAgents}
          label="Agents can read these values"
          hint="Agent runs get them as environment variables when agents.secrets names this set. Code in the run can read and could leak them, so use a config made for development."
        />
      </div>
      <DialogFooter>
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" disabled={!connectionId || Boolean(nameError)} onClick={submit}>
          {set ? 'Done' : 'Add set'}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

/** Picks one of this Factorix's connections for each set in an imported file, then hands everything to the editor unsaved. */
function ImportDialog({
  file,
  connections,
  onClose,
  onLoad,
}: {
  file: EnvironmentFile
  connections: ConnectionDto[]
  onClose: () => void
  onLoad: (source: string, sets: SetDraft[]) => void
}) {
  const sources = connections.filter((connection) => SOURCE_KINDS.has(connection.kind))
  const [chosen, setChosen] = useState(() => matchConnections(file.secretSets, sources))
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Import an environment"
      description={`${file.project ? `From ${file.project}. ` : ''}It replaces the definition and secret sets in the editor. Nothing changes until you save.`}
    >
      <div className="flex flex-col gap-4">
        {file.secretSets.length === 0 ? <p className="text-sm text-ink-2">It has no secret sets.</p> : null}
        {file.secretSets.map((set) => {
          const options = sources.filter((connection) => connection.kind === set.source)
          const reads = [
            sourceLabel(set.source),
            set.project ? `${set.project} / ${set.config ?? 'any config'}` : null,
            set.agents ? 'agents can read it' : null,
          ]
          return (
            <Field key={set.name} label={`Secret set ${set.name}`} hint={reads.filter(Boolean).join(', ')}>
              {options.length === 0 ? (
                <p className="text-sm text-ink-2">
                  There is no {sourceLabel(set.source)} connection here, so this set stays out. Add one in{' '}
                  <Link className="text-link hover:underline" href="/settings/connections">
                    Connections
                  </Link>{' '}
                  and import again.
                </p>
              ) : (
                <Select
                  value={chosen[set.name] ?? LEAVE_OUT}
                  onChange={(value) => setChosen({ ...chosen, [set.name]: value === LEAVE_OUT ? null : value })}
                  options={[
                    ...options.map((connection) => ({ value: connection.id, label: connection.name, hint: sourceLabel(connection.kind) })),
                    { value: LEAVE_OUT, label: 'Leave it out' },
                  ]}
                />
              )}
            </Field>
          )
        })}
      </div>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          onClick={() => {
            onLoad(file.definition, importSecretSets(file.secretSets, chosen))
            onClose()
          }}
        >
          Load into the editor
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

function SecretSets({
  sets,
  saved,
  connections,
  admin,
  test,
  onChange,
}: {
  sets: SetDraft[]
  saved: SecretSetDto[]
  connections: ConnectionDto[]
  admin: boolean
  test: EnvironmentTestDto | null
  onChange: (sets: SetDraft[]) => void
}) {
  const [editing, setEditing] = useState<{ index: number | null } | null>(null)
  const connectionOf = (id: string) => connections.find((connection) => connection.id === id) ?? saved.find((set) => set.connectionId === id)
  const editingSet = editing?.index === null || editing === null ? null : (sets[editing.index] ?? null)
  return (
    <Card className="p-4">
      <SectionTitle
        action={
          admin ? (
            <Button size="sm" variant="ghost" onClick={() => setEditing({ index: null })}>
              <Plus />
              Add
            </Button>
          ) : null
        }
      >
        Secret sets
      </SectionTitle>
      {sets.length === 0 ? (
        <p className="text-sm text-ink-2">
          None yet. A set pulls values from Doppler or an Environment secret connection, and services name it under secrets.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-divider">
          {sets.map((set, index) => {
            const connection = connectionOf(set.connectionId)
            const result = test?.sets.find((candidate) => candidate.name === set.name)
            const connectionName = connection && 'name' in connection ? connection.name : (connection as SecretSetDto | undefined)?.connectionName
            return (
              <li key={set.name} className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <KeyRound className="size-3.5 shrink-0 text-ink-3" />
                  <span className="min-w-0 truncate font-mono text-sm">{set.name}</span>
                  {set.agents ? <Chip tone="warning">Agents read</Chip> : null}
                  <span className="flex-1" />
                  {admin ? (
                    <>
                      <Button size="icon" variant="ghost" aria-label={`Edit ${set.name}`} onClick={() => setEditing({ index })}>
                        <Pencil />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove ${set.name}`}
                        onClick={() => onChange(sets.filter((_, at) => at !== index))}
                      >
                        <Trash2 />
                      </Button>
                    </>
                  ) : null}
                </div>
                <p className="text-xs text-ink-2">
                  {connectionName ?? 'Missing connection'}
                  {set.project || set.config ? ` · ${[set.project, set.config].filter(Boolean).join(' / ')}` : ''}
                  {set.only.length ? ` · only ${keyCount(set.only.length)}` : ''}
                  {set.except.length ? ` · without ${set.except.join(', ')}` : ''}
                </p>
                {result ? (
                  result.ok ? (
                    <div className="flex flex-wrap items-center gap-1">
                      <Chip tone="success">
                        <CircleCheck />
                        {keyCount(result.keys.length)}
                      </Chip>
                      {result.keys.slice(0, 12).map((key) => (
                        <Chip key={key} tone="outline" className="font-mono">
                          {key}
                        </Chip>
                      ))}
                      {result.keys.length > 12 ? <span className="text-xs text-ink-2">and {result.keys.length - 12} more</span> : null}
                    </div>
                  ) : (
                    <p className="flex items-start gap-1.5 text-xs text-danger-ink">
                      <CircleAlert className="mt-px size-3.5 shrink-0" />
                      {result.message}
                    </p>
                  )
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {editing ? (
        <SecretSetDialog
          key={editing.index ?? 'new'}
          set={editingSet}
          taken={sets.filter((_, at) => at !== editing.index).map((set) => set.name)}
          connections={connections}
          open
          onOpenChange={(open) => (open ? null : setEditing(null))}
          onSave={(next) => onChange(editing.index === null ? [...sets, next] : sets.map((set, at) => (at === editing.index ? next : set)))}
        />
      ) : null}
    </Card>
  )
}

function Outline({ definition }: { definition: EnvironmentDefinition }) {
  const exposed = definition.expose
  return (
    <Card className="p-4">
      <SectionTitle>Services</SectionTitle>
      <ul className="flex flex-col gap-2">
        {Object.entries(definition.services).map(([name, service]) => (
          <li key={name} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-sm">{name}</span>
              {service.port ? <Chip tone="outline">:{service.port}</Chip> : null}
              {exposed?.service === name ? <Chip tone="info">Opens</Chip> : null}
              {definition.agents.services.includes(name) ? <Chip>Agent runs</Chip> : null}
            </div>
            <p className="truncate text-xs text-ink-2">
              {service.repo ? `${service.repo}${service.workdir ? `/${service.workdir}` : ''}` : service.image}
              {service.repo && service.image ? ` on ${service.image}` : ''}
              {service.dependsOn.length ? ` · after ${service.dependsOn.join(', ')}` : ''}
            </p>
          </li>
        ))}
      </ul>
      {exposed && exposed.paths.length > 0 ? (
        <div className="mt-3 border-t border-divider pt-3">
          <p className="mb-1 text-xs text-ink-2">Paths</p>
          {exposed.paths.map((rule) => (
            <p key={rule.prefix} className="font-mono text-xs">
              {rule.prefix} → {rule.service}
            </p>
          ))}
        </div>
      ) : null}
      {!exposed ? <p className="mt-3 text-xs text-ink-2">Nothing is exposed, so previews have no page to open. Add expose to choose one.</p> : null}
    </Card>
  )
}

function EnvironmentForm({ environment, onSaved }: { environment: EnvironmentDto; onSaved: (environment: EnvironmentDto) => void }) {
  const { data: me } = useMe()
  const { data: project } = useProject(environment.projectId)
  const { data: connections } = useConnections()
  const admin = me?.account.role === 'admin'
  const [source, setSource] = useState(environment.source)
  const [sets, setSets] = useState<SetDraft[]>(() => environment.secretSets.map(toDraft))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<EnvironmentTestDto | null>(null)
  const [importing, setImporting] = useState<EnvironmentFile | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const deferred = useDeferredValue(source)
  // Validation only needs names, and joined names stay equal across renders where fresh arrays would not.
  const repoNames = project?.project.repos.map((repo) => repo.name).join('\n')
  const setNames = sets.map((set) => set.name).join('\n')
  const agentSetNames = sets
    .filter((set) => set.agents)
    .map((set) => set.name)
    .join('\n')
  const parsed = useMemo(
    () =>
      parseEnvironment(deferred, {
        repos: repoNames === undefined ? undefined : repoNames.split('\n').filter(Boolean),
        secretSets: setNames.split('\n').filter(Boolean),
        agentSecretSets: agentSetNames.split('\n').filter(Boolean),
      }),
    [deferred, repoNames, setNames, agentSetNames],
  )
  const changed = source !== environment.source || JSON.stringify(sets) !== JSON.stringify(environment.secretSets.map(toDraft))

  const save = async () => {
    setSaving(true)
    try {
      const saved = await api.put<{ environment: EnvironmentDto }>(`/api/projects/${environment.projectId}/environment`, { source, secretSets: sets })
      onSaved(saved.environment)
      toast.success(`Environment saved as version ${saved.environment.version}`)
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : (error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const chooseFile = async (chosen: File | undefined) => {
    if (fileInput.current) fileInput.current.value = ''
    if (!chosen) return
    const { file, error } = readEnvironmentFile(await chosen.text())
    if (error) toast.error(error)
    else if (file) setImporting(file)
  }

  const runTest = async () => {
    setTesting(true)
    try {
      setTest(await api.post<EnvironmentTestDto>(`/api/projects/${environment.projectId}/environment/test`, { source, secretSets: sets }))
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Projects', href: '/projects' },
          { label: project?.project.name ?? 'Project', href: `/projects/${environment.projectId}` },
          { label: 'Environment' },
        ]}
      >
        {environment.version > 0 ? (
          <a
            href={`/api/projects/${environment.projectId}/environment/export`}
            download
            title="Downloads the saved version, with no secret values"
            className={buttonStyles({ size: 'sm', variant: 'ghost' })}
          >
            <Download />
            Export
          </a>
        ) : null}
        {admin ? (
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".yaml,.yml,application/yaml,text/yaml"
              className="hidden"
              onChange={(event) => void chooseFile(event.target.files?.[0])}
            />
            <Button size="sm" variant="ghost" onClick={() => fileInput.current?.click()}>
              <Upload />
              Import
            </Button>
            <Button size="sm" variant="ghost" loading={testing} onClick={() => void runTest()} disabled={sets.length === 0 && !source.trim()}>
              <FlaskConical />
              Test
            </Button>
            <Button size="sm" variant="primary" loading={saving} disabled={!changed || parsed.issues.length > 0} onClick={() => void save()}>
              Save
            </Button>
          </>
        ) : null}
      </PageHeader>
      <PageBody>
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-3">
            <div>
              <p className="text-sm text-ink-2">
                How this project runs for previews and for agent runs. Each service is a container, and services reach each other by name. Containers
                reach the hosts this project allows, so keep production values out of the secret sets.
              </p>
              <p className="mt-1 text-xs text-ink-3">
                {environment.version > 0
                  ? `Version ${environment.version}${environment.updatedBy ? `, saved by ${environment.updatedBy.name}` : ''}${environment.updatedAt ? ` ${savedWhen(environment.updatedAt)}` : ''}.`
                  : 'Not saved yet.'}
                {admin ? '' : ' Only admins can change it.'}
              </p>
            </div>
            {admin && !source.trim() ? (
              <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
                <span className="text-sm text-ink-2">No services yet. Start from an example with a database, a cache, an API, and a web app.</span>
                <Button size="sm" onClick={() => setSource(ENVIRONMENT_EXAMPLE)}>
                  Start from example
                </Button>
              </Card>
            ) : null}
            <YamlEditor
              className="h-[62vh] min-h-96"
              value={source}
              onChange={setSource}
              issues={parsed.issues}
              readOnly={!admin}
              placeholder={'services:\n  db:\n    image: postgres:17'}
            />
            {parsed.issues.length > 0 ? (
              <ul className="flex flex-col gap-1 rounded-md border border-danger/30 bg-danger-soft px-3 py-2">
                {parsed.issues.slice(0, 8).map((issue) => (
                  <li key={`${issue.line}:${issue.message}`} className="text-xs text-danger-ink">
                    {issue.line ? <span className="font-mono">Line {issue.line}: </span> : null}
                    {issue.message}
                  </li>
                ))}
                {parsed.issues.length > 8 ? <li className="text-xs text-danger-ink">and {parsed.issues.length - 8} more</li> : null}
              </ul>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <SecretSets
              sets={sets}
              saved={environment.secretSets}
              connections={connections?.connections ?? []}
              admin={admin}
              test={test}
              onChange={(next) => {
                setSets(next)
                setTest(null)
              }}
            />
            {parsed.definition ? <Outline definition={parsed.definition} /> : null}
            {parsed.definition?.notes ? (
              <Card className="p-4">
                <SectionTitle>Notes for reviewers</SectionTitle>
                <p className="text-sm whitespace-pre-wrap text-ink-2">{parsed.definition.notes}</p>
              </Card>
            ) : null}
          </div>
        </div>
      </PageBody>
      {importing ? (
        <ImportDialog
          file={importing}
          connections={connections?.connections ?? []}
          onClose={() => setImporting(null)}
          onLoad={(nextSource, nextSets) => {
            setSource(nextSource)
            setSets(nextSets)
            setTest(null)
            toast.success('Loaded into the editor. Test it, then save.')
          }}
        />
      ) : null}
    </>
  )
}

function EnvironmentView({ id }: { id: string }) {
  const { data, error, mutate } = useEnvironment(id)
  if (error && !data)
    return (
      <>
        <PageHeader crumbs={[{ label: 'Projects', href: '/projects' }, { label: 'Environment' }]} />
        <ErrorState error={error} retry={() => void mutate()} />
      </>
    )
  if (!data)
    return (
      <>
        <PageHeader crumbs={[{ label: 'Projects', href: '/projects' }, { label: 'Environment' }]} />
        <ListSkeleton rows={6} />
      </>
    )
  return (
    <EnvironmentForm
      key={data.environment.version}
      environment={data.environment}
      onSaved={(environment) => void mutate({ environment }, { revalidate: false })}
    />
  )
}

export default function EnvironmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <EnvironmentView id={id} />
}
