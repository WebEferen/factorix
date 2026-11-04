'use client'

import type { AgentDto, RuntimeDto } from '@factorix/schemas'
import { TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { mutate } from 'swr'
import { ApiError, api } from '../lib/api'
import { useArchetypes, useConnections, useRuntimes, useSkills } from '../lib/data'
import { worksAs } from '../lib/format'
import { Button, Field, Input, Select, Textarea, Toggle } from '../ui'

const MODES = [
  { value: 'read_only', label: 'Read only', hint: 'Can read and search, never changes files' },
  { value: 'edit', label: 'Edit', hint: 'Edits files, asks before anything else' },
  { value: 'full', label: 'Full', hint: 'Runs anything inside its sandbox' },
]

const DEFAULT_CHOICE = 'default'
const PROJECT_ACCOUNT = 'project'
const EFFORTS = [DEFAULT_CHOICE, 'low', 'medium', 'high', 'xhigh', 'max']

function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function AgentForm({ agent }: { agent?: AgentDto }) {
  const router = useRouter()
  const { data: runtimes } = useRuntimes()
  const { data: skills } = useSkills()
  const { data: connections } = useConnections()
  const { data: archetypes } = useArchetypes()
  const [form, setForm] = useState({
    handle: agent?.handle ?? '',
    displayName: agent?.displayName ?? '',
    archetypeId: agent?.archetype.id ?? '',
    description: agent?.description ?? '',
    systemPrompt: agent?.systemPrompt ?? '',
    runtime: agent?.runtime ?? 'claude',
    model: agent?.model ?? '',
    reasoningEffort: agent?.reasoningEffort ?? 'default',
    maxBudgetUsd: agent?.maxBudgetUsd?.toString() ?? '10',
    maxTurns: agent?.maxTurns?.toString() ?? '200',
    mode: agent?.policy.mode ?? 'full',
    allow: agent?.policy.allow.join('\n') ?? '',
    deny: agent?.policy.deny.join('\n') ?? '',
    requireApproval: agent?.policy.requireApproval.join('\n') ?? '',
    networkAccess: agent?.policy.networkAccess ?? true,
    skillIds: agent?.skillIds ?? [],
    connectionIds: agent?.connectionIds ?? [],
    status: agent?.status ?? 'active',
  })
  const archetypeOptions = archetypes?.archetypes ?? []
  const archetypeId = form.archetypeId || archetypeOptions.find((item) => item.role === 'engineer')?.id || archetypeOptions[0]?.id || ''
  const archetype = archetypeOptions.find((item) => item.id === archetypeId)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }))

  // biome-ignore lint/correctness/useExhaustiveDependencies: preselect only when skills first load for a new agent
  useEffect(() => {
    if (agent || form.skillIds.length > 0 || !skills) return
    set(
      'skillIds',
      skills.skills.map((skill) => skill.id),
    )
  }, [skills])

  const runtime: RuntimeDto | undefined = useMemo(() => runtimes?.runtimes.find((item) => item.id === form.runtime), [runtimes, form.runtime])
  const capabilities = runtime?.capabilities
  const models = runtime?.models ?? []
  const efforts = (id: string) => models.find((item) => item.id === (id || runtime?.defaultModel))?.efforts
  const defaultLabel = models.find((item) => item.id === runtime?.defaultModel)?.label
  const modelOptions = [
    { value: DEFAULT_CHOICE, label: defaultLabel ? `Default (${defaultLabel})` : 'Default' },
    ...models.map((item) => ({ value: item.id, label: item.label, hint: item.description ?? undefined })),
    ...(form.model && !models.some((item) => item.id === form.model)
      ? [{ value: form.model, label: form.model, hint: 'Not offered by this runtime' }]
      : []),
  ]
  const effortChoices = EFFORTS.filter((value) => value === DEFAULT_CHOICE || (efforts(form.model) ?? EFFORTS).includes(value as never))
  const changeModel = (value: string) => {
    const model = value === DEFAULT_CHOICE ? '' : value
    const allowed = efforts(model)
    setForm((current) => ({
      ...current,
      model,
      reasoningEffort: allowed && !allowed.includes(current.reasoningEffort as never) ? DEFAULT_CHOICE : current.reasoningEffort,
    }))
  }
  const canAsk = capabilities?.toolApproval === 'per_call'
  const attachable =
    connections?.connections.filter((connection) => ['mcp_stdio', 'mcp_http', 'generic', 'anthropic', 'openai'].includes(connection.kind)) ?? []

  const accountsOf = (role: 'scm' | 'tracker') => connections?.connections.filter((connection) => connection.accountRole === role) ?? []
  const accountChoice = (role: 'scm' | 'tracker') =>
    form.connectionIds.find((id) => accountsOf(role).some((connection) => connection.id === id)) ?? PROJECT_ACCOUNT
  const chooseAccount = (role: 'scm' | 'tracker', id: string) =>
    set('connectionIds', [
      ...form.connectionIds.filter((value) => !accountsOf(role).some((connection) => connection.id === value)),
      ...(id === PROJECT_ACCOUNT ? [] : [id]),
    ])
  const accountOptions = (role: 'scm' | 'tracker') => [
    { value: PROJECT_ACCOUNT, label: 'The project’s account' },
    ...accountsOf(role).map((connection) => ({ value: connection.id, label: connection.name })),
  ]

  const toggleIn = (key: 'skillIds' | 'connectionIds', id: string, on: boolean) =>
    set(key, on ? [...form[key], id] : form[key].filter((value) => value !== id))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError(null)
    const body = {
      handle: form.handle,
      displayName: form.displayName,
      archetypeId,
      description: form.description,
      systemPrompt: form.systemPrompt,
      runtime: form.runtime,
      model: form.model || null,
      reasoningEffort: form.reasoningEffort === 'default' ? null : form.reasoningEffort,
      maxBudgetUsd: form.maxBudgetUsd ? Number(form.maxBudgetUsd) : null,
      maxTurns: form.maxTurns ? Number(form.maxTurns) : null,
      policy: {
        mode: form.mode,
        allow: linesOf(form.allow),
        deny: linesOf(form.deny),
        requireApproval: canAsk ? linesOf(form.requireApproval) : [],
        networkAccess: form.networkAccess,
      },
      skillIds: form.skillIds,
      connectionIds: form.connectionIds,
      status: form.status,
    }
    try {
      const saved = agent
        ? await api.put<{ agent: AgentDto }>(`/api/agents/${agent.id}`, body)
        : await api.post<{ agent: AgentDto }>('/api/agents', body)
      void mutate((key) => typeof key === 'string' && key.startsWith('/api/agents'))
      toast.success(agent ? 'Saved' : `${saved.agent.displayName} is on the team`)
      if (!agent) router.push(`/agents/${saved.agent.id}`)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save this agent.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <section className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input required value={form.displayName} onChange={(event) => set('displayName', event.target.value)} placeholder="Engineer Two" />
          </Field>
          <Field label="Handle" hint="Shows up in commit trailers, comments, and the tracker label.">
            <Input
              required
              pattern="[a-z0-9][a-z0-9\-]*"
              value={form.handle}
              onChange={(event) => set('handle', event.target.value)}
              placeholder="engineer-2"
            />
          </Field>
        </div>
        <Field label="Archetype" hint="The job this agent does and the prompt it starts from.">
          <Select
            value={archetypeId}
            onChange={(value) => set('archetypeId', value)}
            placeholder="Choose an archetype"
            options={archetypeOptions.map((item) => ({ value: item.id, label: item.name, hint: worksAs(item.role) }))}
          />
        </Field>
        {archetypes && archetypeOptions.length === 0 ? (
          <p className="text-xs text-ink-2">
            Agents are built from archetypes, and there are none yet.{' '}
            <Link href="/archetypes" className="text-link hover:underline">
              Create one
            </Link>
          </p>
        ) : null}
        {archetype?.systemPrompt ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-ink-2">Prompt from {archetype.name}</span>
              <Link href="/archetypes" className="text-link hover:underline">
                Manage archetypes
              </Link>
            </div>
            <div className="scroll-thin max-h-28 overflow-y-auto rounded-md border border-divider bg-softer p-2.5 font-mono text-xs whitespace-pre-wrap text-ink-2">
              {archetype.systemPrompt}
            </div>
          </div>
        ) : null}
        <Field label="Description">
          <Input value={form.description} onChange={(event) => set('description', event.target.value)} />
        </Field>
        <Field label="Extra instructions" hint="Added after the archetype's prompt, for this agent only.">
          <Textarea className="min-h-20 font-mono text-xs" value={form.systemPrompt} onChange={(event) => set('systemPrompt', event.target.value)} />
        </Field>
      </section>

      <section className="flex flex-col gap-4 border-t border-divider pt-5">
        <h2 className="text-sm font-semibold">Runtime</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Runtime">
            <Select
              value={form.runtime}
              onChange={(value) =>
                setForm((current) => ({ ...current, runtime: value as typeof form.runtime, model: '', reasoningEffort: DEFAULT_CHOICE }))
              }
              options={runtimes?.runtimes.map((item) => ({ value: item.id, label: item.label })) ?? []}
            />
          </Field>
          {models.length > 0 ? (
            <Field label="Model">
              <Select value={form.model || DEFAULT_CHOICE} onChange={changeModel} options={modelOptions} />
            </Field>
          ) : (
            <Field label="Model" hint={runtime?.defaultModel ? `Default is ${runtime.defaultModel}.` : 'Uses the runtime default.'}>
              <Input value={form.model} onChange={(event) => set('model', event.target.value)} placeholder={runtime?.defaultModel ?? 'Default'} />
            </Field>
          )}
          <Field label="Effort">
            <Select
              value={form.reasoningEffort}
              onChange={(value) => set('reasoningEffort', value)}
              options={effortChoices.map((value) => ({ value, label: value === DEFAULT_CHOICE ? 'Default' : value }))}
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Budget per run (USD)"
            hint={capabilities?.budgetLimit === 'emulated' ? 'Enforced by Factorix from reported tokens.' : undefined}
          >
            <Input type="number" min="0" step="0.5" value={form.maxBudgetUsd} onChange={(event) => set('maxBudgetUsd', event.target.value)} />
          </Field>
          <Field label="Turn limit" hint={capabilities?.maxTurns === 'emulated' ? 'Enforced by Factorix between turns.' : undefined}>
            <Input type="number" min="1" value={form.maxTurns} onChange={(event) => set('maxTurns', event.target.value)} />
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-4 border-t border-divider pt-5">
        <h2 className="text-sm font-semibold">Permissions</h2>
        <Field label="Mode">
          <Select value={form.mode} onChange={(value) => set('mode', value as typeof form.mode)} options={MODES} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Always allow" hint="One tool rule per line, like Bash(yarn test*).">
            <Textarea className="font-mono text-xs" value={form.allow} onChange={(event) => set('allow', event.target.value)} />
          </Field>
          <Field label="Never allow" hint="Takes priority. Pushing and changing remotes are always blocked.">
            <Textarea className="font-mono text-xs" value={form.deny} onChange={(event) => set('deny', event.target.value)} />
          </Field>
        </div>
        {canAsk ? (
          <Field label="Ask a person first" hint="The agent pauses on these until someone decides.">
            <Textarea className="font-mono text-xs" value={form.requireApproval} onChange={(event) => set('requireApproval', event.target.value)} />
          </Field>
        ) : capabilities ? (
          <p className="flex items-start gap-2 rounded-md bg-soft p-3 text-sm text-ink-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {runtime?.label} cannot pause for approval on individual tools. Use read-only mode or never-allow rules to limit it.
          </p>
        ) : null}
        <Toggle
          checked={form.networkAccess}
          onChange={(value) => set('networkAccess', value)}
          label="Network access"
          hint="Always limited by the project's egress policy."
        />
      </section>

      {skills && skills.skills.length > 0 ? (
        <section className="flex flex-col gap-3 border-t border-divider pt-5">
          <h2 className="text-sm font-semibold">Skills</h2>
          {skills.skills.map((skill) => (
            <Toggle
              key={skill.id}
              checked={form.skillIds.includes(skill.id)}
              onChange={(on) => toggleIn('skillIds', skill.id, on)}
              label={skill.name}
            />
          ))}
        </section>
      ) : null}

      {attachable.length > 0 ? (
        <section className="flex flex-col gap-3 border-t border-divider pt-5">
          <h2 className="text-sm font-semibold">Connections</h2>
          {attachable.map((connection) => (
            <Toggle
              key={connection.id}
              checked={form.connectionIds.includes(connection.id)}
              onChange={(on) => toggleIn('connectionIds', connection.id, on)}
              label={connection.name}
              hint={connection.agentVisible ? 'Its secrets are visible to the agent.' : connection.kind}
            />
          ))}
        </section>
      ) : null}

      {connections ? (
        <section className="flex flex-col gap-3 border-t border-divider pt-5">
          <div>
            <h2 className="text-sm font-semibold">Accounts</h2>
            <p className="mt-0.5 text-xs text-ink-2">
              Agents share the project’s accounts unless you pick one here. To give this agent its own, add a connection for it under{' '}
              <Link href="/settings/connections" className="text-link hover:underline">
                Settings, Connections
              </Link>
              .
            </p>
          </div>
          <Field
            label="Git account"
            hint="Its commits, merge requests, and reviews. Merges still use the project’s account. The token never enters the agent’s container."
          >
            <Select value={accountChoice('scm')} onChange={(id) => chooseAccount('scm', id)} options={accountOptions('scm')} />
          </Field>
          <Field label="Tracker account" hint="Its comments on tickets. Moving a ticket between statuses still uses the project’s account.">
            <Select value={accountChoice('tracker')} onChange={(id) => chooseAccount('tracker', id)} options={accountOptions('tracker')} />
          </Field>
        </section>
      ) : null}

      {agent ? (
        <section className="border-t border-divider pt-5">
          <Toggle
            checked={form.status === 'active'}
            onChange={(on) => set('status', on ? 'active' : 'disabled')}
            label="Active"
            hint="A disabled agent keeps its history and picks up no new work."
          />
        </section>
      ) : null}

      {error ? <p className="text-sm text-danger-ink">{error}</p> : null}
      <div className="flex justify-end gap-2 border-t border-divider pt-4">
        <Button type="submit" variant="primary" loading={loading}>
          {agent ? 'Save changes' : 'Create agent'}
        </Button>
      </div>
    </form>
  )
}
