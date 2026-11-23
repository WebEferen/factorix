'use client'

import type { ConnectionDto } from '@factorix/schemas'
import { Bot, CheckCircle2, CircleAlert, GitBranch, GitPullRequest, Hash, KeyRound, Plug, Plus, Puzzle, SquareKanban, Vault } from 'lucide-react'
import { type FormEvent, Fragment, type ReactNode, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/modules/lib/api'
import { useConnections, useConnectionUses, useMe, usePlugins } from '@/modules/lib/data'
import { timeAgo } from '@/modules/lib/format'
import { PluginFields } from '@/modules/plugins/fields'
import { Button, Card, Chip, CopyField, Dialog, DialogFooter, ErrorState, Field, Input, ListSkeleton, Select, Textarea } from '@/modules/ui'

const KINDS: Record<ConnectionDto['kind'], { label: string; hint: string; icon: React.ReactNode; secret: string; placeholder?: string }> = {
  linear: {
    label: 'Linear',
    hint: 'Tracker: projects, issues, comments, webhooks',
    icon: <SquareKanban />,
    secret: 'Personal API key',
    placeholder: 'lin_api_...',
  },
  jira: {
    label: 'Jira',
    hint: 'Tracker: projects, issues, comments, webhooks',
    icon: <SquareKanban />,
    secret: 'API token. On Data Center, a personal access token with the email left empty',
  },
  plugin: {
    label: 'Plugin',
    hint: 'A tracker served by a plugin that is turned on under Integrations, Plugins',
    icon: <Puzzle />,
    secret: '',
  },
  trello: {
    label: 'Trello',
    hint: 'Tracker: boards as teams, lists as statuses, cards as issues',
    icon: <SquareKanban />,
    secret: 'Token, made for the API key',
  },
  gitlab: {
    label: 'GitLab',
    hint: 'Source: repositories, merge requests, CI',
    icon: <GitBranch />,
    secret: 'Personal access token with api and write_repository',
    placeholder: 'glpat-...',
  },
  github: {
    label: 'GitHub',
    hint: 'Source: repositories, pull requests, checks',
    icon: <GitPullRequest />,
    secret:
      'Personal access token: classic with repo, or fine-grained with write on contents, pull requests, and webhooks, and read on checks, statuses, and actions',
    placeholder: 'ghp_... or github_pat_...',
  },
  anthropic: { label: 'Anthropic', hint: 'API key for Claude agents', icon: <Bot />, secret: 'API key', placeholder: 'sk-ant-...' },
  openai: { label: 'OpenAI', hint: 'API key for Codex agents', icon: <Bot />, secret: 'API key', placeholder: 'sk-...' },
  mcp_http: {
    label: 'MCP server (HTTP)',
    hint: 'A tool server agents reach over HTTP. The egress proxy adds its headers, so agents never see them',
    icon: <Plug />,
    secret: 'Headers as JSON',
  },
  slack: {
    label: 'Slack',
    hint: 'Workflows post to its channels and can start from its messages. The bot token needs chat:write, chat:write.public, channels:read, groups:read, and users:read',
    icon: <Hash />,
    secret: 'Bot token',
    placeholder: 'xoxb-',
  },
  mcp_stdio: {
    label: 'MCP server (command)',
    hint: 'A tool server the sandbox starts. It gets no secret values, so use an HTTP server for one that needs a key',
    icon: <Plug />,
    secret: 'Environment as JSON',
  },
  generic: {
    label: 'Environment secret',
    hint: 'Values for a secret set in a project environment. Agents never get them',
    icon: <KeyRound />,
    secret: 'Environment as JSON',
  },
  factorix: {
    label: 'Factorix tickets',
    hint: 'Built-in tracker: tickets written and kept in Factorix, for a team with no tracker to connect',
    icon: <SquareKanban />,
    secret: '',
  },
  doppler: {
    label: 'Doppler',
    hint: 'Secret source: configs for previews. The token stays in Factorix',
    icon: <Vault />,
    secret: 'Service token, or a service account token to pick from several configs',
    placeholder: 'dp.st...',
  },
}

const TRACKER_PLUGIN = (plugin: { enabled: boolean; provides: string[] }) => plugin.enabled && plugin.provides.includes('tracker')
const usesJsonSecret = (kind: string) => kind === 'mcp_http' || kind === 'generic'
const SCM_HOSTS: Partial<Record<ConnectionDto['kind'], string>> = { gitlab: 'https://gitlab.com', github: 'https://github.com' }

function ConnectionDialog({
  connection,
  kinds,
  noun,
  open,
  onOpenChange,
  onSaved,
  onDelete,
}: {
  connection: ConnectionDto | null
  /** What a new one can be, the first picked to start with. */
  kinds: ConnectionDto['kind'][]
  noun: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (saved: ConnectionDto) => void
  onDelete: (connection: ConnectionDto) => void
}) {
  const [kind, setKind] = useState<ConnectionDto['kind']>('linear')
  const [name, setName] = useState('')
  const [secret, setSecret] = useState('')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [host, setHost] = useState('https://gitlab.com')
  const [email, setEmail] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [botName, setBotName] = useState('')
  const [botEmail, setBotEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [pluginId, setPluginId] = useState('')
  const [pluginValues, setPluginValues] = useState<Record<string, string>>({})
  const plugins = (usePlugins().data?.plugins ?? []).filter(TRACKER_PLUGIN)
  const plugin = plugins.find((candidate) => candidate.id === pluginId) ?? (connection ? undefined : plugins[0])
  useEffect(() => {
    if (!open) return
    setPluginId(String(connection?.config.pluginId ?? ''))
    setPluginValues(
      Object.fromEntries(Object.entries(connection?.config ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    )
    const initial = connection?.kind ?? kinds[0] ?? 'linear'
    setKind(initial)
    setName(connection?.name ?? '')
    setSecret('')
    setUrl(String(connection?.config.url ?? ''))
    setCommand(String(connection?.config.command ?? ''))
    setArgs(((connection?.config.args as string[] | undefined) ?? []).join(' '))
    setHost(String(connection?.config.host ?? SCM_HOSTS[initial] ?? (initial === 'jira' ? '' : 'https://gitlab.com')))
    setEmail(String(connection?.config.email ?? ''))
    setApiKey(String(connection?.config.apiKey ?? ''))
    setApiSecret('')
    setBotName(String(connection?.config.botName ?? ''))
    setBotEmail(String(connection?.config.botEmail ?? ''))
  }, [open, connection, kinds])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try {
      const config: Record<string, unknown> = SCM_HOSTS[kind]
        ? { host, ...(botName.trim() ? { botName: botName.trim() } : {}), ...(botEmail.trim() ? { botEmail: botEmail.trim() } : {}) }
        : kind === 'jira'
          ? { host, ...(email.trim() ? { email: email.trim() } : {}) }
          : kind === 'trello'
            ? { apiKey: apiKey.trim(), ...(apiSecret.trim() ? { webhookSecret: apiSecret.trim() } : {}) }
            : kind === 'slack' && apiSecret.trim()
              ? { webhookSecret: apiSecret.trim() }
              : kind === 'mcp_http'
                ? { url }
                : kind === 'mcp_stdio'
                  ? { command, args: args.split(/\s+/).filter(Boolean) }
                  : {}
      let secretValue: unknown
      if (secret) secretValue = usesJsonSecret(kind) ? JSON.parse(secret) : secret
      if (kind === 'plugin') {
        if (!plugin) throw new Error('Turn a plugin on under Integrations, Plugins first')
        // The API sorts these into open and secret fields by the plugin's manifest.
        const typed = Object.fromEntries(
          plugin.connectionFields.flatMap((field) => (pluginValues[field.key] ? [[field.key, pluginValues[field.key]]] : [])),
        )
        Object.assign(config, { pluginId: plugin.id })
        secretValue = typed
      }
      const body = { name: name || (kind === 'plugin' ? plugin?.name : undefined) || KINDS[kind].label, config, secret: secretValue }
      const { connection: saved } = connection
        ? await api.put<{ connection: ConnectionDto }>(`/api/connections/${connection.id}`, body)
        : await api.post<{ connection: ConnectionDto }>('/api/connections', { ...body, kind })
      onSaved(saved)
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof SyntaxError ? 'That secret is not valid JSON.' : (error as Error).message)
    } finally {
      setLoading(false)
    }
  }
  const meta = KINDS[kind]
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={connection ? connection.name : `Add ${article(noun)} ${noun}`} description={meta.hint}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        {connection || kinds.length < 2 ? null : (
          <Field label="Kind">
            <Select
              value={kind}
              onChange={(value) => {
                setKind(value as ConnectionDto['kind'])
                const defaultHost = SCM_HOSTS[value as ConnectionDto['kind']]
                if (defaultHost) setHost(defaultHost)
                else if (value === 'jira') setHost('')
              }}
              options={kinds.map((value) => ({ value, label: KINDS[value].label, hint: KINDS[value].hint }))}
            />
          </Field>
        )}
        <Field label="Name">
          <Input value={name} placeholder={meta.label} onChange={(event) => setName(event.target.value)} />
        </Field>
        {SCM_HOSTS[kind] ? (
          <Field label="Host">
            <Input required value={host} onChange={(event) => setHost(event.target.value)} />
          </Field>
        ) : null}
        {kind === 'plugin' ? (
          plugins.length === 0 ? (
            <p className="text-sm text-ink-2">No plugin with a tracker is turned on. Turn one on under Integrations, Plugins.</p>
          ) : (
            <>
              {connection ? null : (
                <Field label="Plugin">
                  <Select
                    value={plugin?.id ?? ''}
                    onChange={setPluginId}
                    options={plugins.map((item) => ({ value: item.id, label: item.name, hint: item.description ?? undefined }))}
                  />
                </Field>
              )}
              {plugin ? (
                <PluginFields
                  fields={plugin.connectionFields}
                  values={pluginValues}
                  stored={connection?.hasSecret ? plugin.connectionFields.filter((field) => field.type === 'secret').map((field) => field.key) : []}
                  onChange={setPluginValues}
                />
              ) : null}
            </>
          )
        ) : null}
        {kind === 'trello' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="API key">
              <Input required value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
            </Field>
            <Field label="API secret" hint="Trello signs webhooks with it. Leave it blank to rely on polling, or to keep the one stored.">
              <Input type="password" autoComplete="off" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} />
            </Field>
          </div>
        ) : null}
        {kind === 'slack' ? (
          <Field
            label="Signing secret"
            hint="From Basic Information in your Slack app. Workflows can start from Slack messages once it is saved. Leave it blank to only post, or to keep the one stored."
          >
            <Input type="password" autoComplete="off" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} />
          </Field>
        ) : null}
        {kind === 'jira' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Site">
              <Input required type="url" value={host} placeholder="https://acme.atlassian.net" onChange={(event) => setHost(event.target.value)} />
            </Field>
            <Field label="Account email">
              <Input type="email" value={email} placeholder="you@acme.com" onChange={(event) => setEmail(event.target.value)} />
            </Field>
          </div>
        ) : null}
        {SCM_HOSTS[kind] ? (
          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Bot name">
                <Input value={botName} placeholder="Factorix Bot" onChange={(event) => setBotName(event.target.value)} />
              </Field>
              <Field label="Bot email">
                <Input
                  type="email"
                  value={botEmail}
                  placeholder="factorix-bot@noreply.factorix.dev"
                  onChange={(event) => setBotEmail(event.target.value)}
                />
              </Field>
            </div>
            <p className="text-xs text-ink-2">Who commits from this connection. Merge requests and comments still show the owner of the token.</p>
          </div>
        ) : null}
        {kind === 'mcp_http' ? (
          <Field label="URL">
            <Input required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://mcp.example.com/mcp" />
          </Field>
        ) : null}
        {kind === 'mcp_stdio' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Command">
              <Input required value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" />
            </Field>
            <Field label="Arguments">
              <Input value={args} onChange={(event) => setArgs(event.target.value)} />
            </Field>
          </div>
        ) : null}
        {kind !== 'mcp_stdio' && kind !== 'factorix' && kind !== 'plugin' ? (
          <Field
            label={meta.secret}
            hint={connection?.hasSecret ? 'A secret is stored. Leave this blank to keep it.' : 'Encrypted at rest and never shown again.'}
          >
            {usesJsonSecret(kind) ? (
              <Textarea
                className="font-mono text-xs"
                placeholder='{"API_KEY": "..."}'
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            ) : (
              <Input
                type="password"
                autoComplete="off"
                placeholder={meta.placeholder}
                required={!connection?.hasSecret}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            )}
          </Field>
        ) : null}
        <div className="flex justify-end">
          {connection && connection.kind !== 'factorix' ? (
            <div className="mr-auto">
              <Button type="button" variant="ghost" onClick={() => onDelete(connection)}>
                Delete
              </Button>
            </div>
          ) : null}
          <Button type="submit" variant="primary" loading={loading}>
            {connection ? 'Save changes' : `Add ${noun}`}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function TestResult({ connectionId }: { connectionId: string }) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const test = async () => {
    setLoading(true)
    try {
      setResult(await api.post<{ ok: boolean; message: string }>(`/api/connections/${connectionId}/test`))
    } catch (error) {
      setResult({ ok: false, message: (error as Error).message })
    } finally {
      setLoading(false)
    }
  }
  return (
    <>
      {result ? (
        <span
          title={result.message}
          className={`mr-auto flex min-w-0 items-center gap-1 truncate text-xs ${result.ok ? 'text-success' : 'text-danger-ink'}`}
        >
          {result.ok ? <CheckCircle2 className="size-3.5 shrink-0" /> : <CircleAlert className="size-3.5 shrink-0" />}
          <span className="truncate">{result.message}</span>
        </span>
      ) : null}
      <Button
        size="sm"
        loading={loading}
        onClick={(event) => {
          event.stopPropagation()
          void test()
        }}
      >
        Test
      </Button>
    </>
  )
}

type Kind = ConnectionDto['kind']

interface ConnectionGroup {
  title: string
  description: string
  icon: ReactNode
  kinds: Kind[]
}

const TABS: Record<'connections' | 'services', { title: string; description: string; noun: string; pitch: string; groups: ConnectionGroup[] }> = {
  connections: {
    title: 'Connections',
    description: 'Accounts the factory works through: where tickets come from, where code goes, and the models agents run on.',
    noun: 'connection',
    pitch: 'Connect the tracker your team plans in, the code host agents push to, and the model keys they run on.',
    groups: [
      {
        title: 'Trackers',
        description: 'Where issues come from and where agents report back',
        icon: <SquareKanban />,
        kinds: ['linear', 'jira', 'trello', 'factorix', 'plugin'],
      },
      {
        title: 'Sources',
        description: 'Repositories agents clone, push to, and open merge requests on',
        icon: <GitBranch />,
        kinds: ['gitlab', 'github'],
      },
      { title: 'Models', description: 'API keys agents run on', icon: <Bot />, kinds: ['anthropic', 'openai'] },
    ],
  },
  services: {
    title: 'Integrations',
    description: 'Everything else the factory talks to: tools for agents, chat for workflows, and secrets for previews.',
    noun: 'integration',
    pitch: 'Give agents tools through MCP servers, let workflows post and listen in Slack, and bring secrets into previews.',
    groups: [
      { title: 'Messaging', description: 'Where workflows post, and what can start them', icon: <Hash />, kinds: ['slack'] },
      { title: 'Tools', description: 'MCP servers agents can call', icon: <Plug />, kinds: ['mcp_http', 'mcp_stdio'] },
      { title: 'Secrets', description: 'Values for project environments. Agents never get them', icon: <Vault />, kinds: ['doppler', 'generic'] },
    ],
  },
}

const article = (noun: string) => (/^[aeiou]/i.test(noun) ? 'an' : 'a')
const bare = (value: unknown) =>
  String(value ?? '')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
const listOf = (items: string[]) => (items.length < 3 ? items.join(' or ') : `${items.slice(0, -1).join(', ')}, or ${items.at(-1)}`)

function factsOf(connection: ConnectionDto, pluginName: string | undefined): [string, string][] {
  const { config, kind } = connection
  const facts: [string, string][] = []
  if (SCM_HOSTS[kind]) facts.push(['Host', bare(config.host)])
  if (kind === 'jira') facts.push(['Site', bare(config.host)])
  if (config.email) facts.push(['Account', String(config.email)])
  if (config.botName || config.botEmail)
    facts.push(['Commits as', [config.botName, config.botEmail && `<${config.botEmail}>`].filter(Boolean).join(' ')])
  if (kind === 'mcp_http') facts.push(['URL', bare(config.url)])
  if (kind === 'mcp_stdio') facts.push(['Command', [config.command, ...((config.args as string[] | undefined) ?? [])].join(' ')])
  if (kind === 'plugin') facts.push(['Plugin', pluginName ?? String(config.pluginId ?? '')])
  if (connection.egressHosts.length > 0) facts.push(['Agents reach', connection.egressHosts.join(', ')])
  if (connection.webhookUrl) facts.push(['Webhook', 'Available'])
  facts.push(['Updated', `${timeAgo(connection.updatedAt)} ago`])
  return facts
}

function ConnectionCard({
  connection,
  pluginName,
  admin,
  onEdit,
  onWebhook,
}: {
  connection: ConnectionDto
  pluginName: string | undefined
  admin: boolean
  onEdit: () => void
  onWebhook: () => void
}) {
  const meta = KINDS[connection.kind]
  const noSecret = !connection.hasSecret && connection.kind !== 'mcp_stdio' && connection.kind !== 'factorix'
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-soft text-ink-2 [&_svg]:size-[18px]">{meta.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{connection.name}</div>
          <div className="truncate text-xs text-ink-2">{meta.label}</div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {connection.accountRole ? <Chip tone="info">Agent account</Chip> : null}
          {connection.kind === 'factorix' ? <Chip>Built in</Chip> : null}
          {noSecret ? <Chip tone="warning">No secret</Chip> : null}
        </div>
      </div>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
        {factsOf(connection, pluginName).map(([term, value]) => (
          <Fragment key={term}>
            <dt className="text-ink-3">{term}</dt>
            <dd className="truncate text-ink-2" title={value}>
              {value}
            </dd>
          </Fragment>
        ))}
      </dl>
      <div className="mt-auto flex min-h-8 items-center justify-end gap-1.5 border-t border-divider pt-3">
        <TestResult connectionId={connection.id} />
        {connection.webhookUrl && admin ? (
          <Button size="sm" variant="ghost" onClick={onWebhook}>
            Webhook
          </Button>
        ) : null}
        {admin ? (
          <Button size="sm" variant="ghost" onClick={onEdit}>
            Edit
          </Button>
        ) : null}
      </div>
    </Card>
  )
}

/** One kind per distinct icon, so kinds that share one are drawn once. */
function distinctIcons(kinds: Kind[]): Kind[] {
  const seen = new Set<unknown>()
  return kinds.filter((kind) => {
    const { type } = KINDS[kind].icon as { type: unknown }
    if (seen.has(type)) return false
    seen.add(type)
    return true
  })
}

function Orbit({ kinds }: { kinds: Kind[] }) {
  const points = kinds.map((kind, index) => {
    const angle = (index / kinds.length) * 2 * Math.PI - Math.PI / 2
    return { kind, x: 64 + 46 * Math.cos(angle), y: 64 + 46 * Math.sin(angle) }
  })
  return (
    <div className="relative hidden size-32 shrink-0 sm:block" aria-hidden="true">
      <svg viewBox="0 0 128 128" aria-hidden="true" className="absolute inset-0 size-full text-ink">
        <circle cx={64} cy={64} r={46} fill="none" stroke="currentColor" strokeOpacity={0.12} strokeDasharray="2 4" />
        {points.map((point) => (
          <line
            key={point.kind}
            x1={64}
            y1={64}
            x2={point.x}
            y2={point.y}
            stroke="currentColor"
            strokeDasharray="3 3"
            className="[stroke-opacity:0.18] transition-[stroke-opacity] duration-300 group-hover:[stroke-opacity:0.45]"
          />
        ))}
      </svg>
      {points.map((point) => (
        <span
          key={point.kind}
          className="absolute flex size-7 items-center justify-center rounded-md border border-divider bg-surface text-ink-2 transition-colors duration-300 group-hover:text-ink [&_svg]:size-3.5"
          style={{ left: point.x - 14, top: point.y - 14 }}
        >
          {KINDS[point.kind].icon}
        </span>
      ))}
      <span className="absolute top-1/2 left-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-signal text-white transition-transform duration-200 group-hover:scale-110 [&_svg]:size-5">
        <Plus />
      </span>
    </div>
  )
}

function AddTile({ noun, pitch, groups, onAdd }: { noun: string; pitch: string; groups: ConnectionGroup[]; onAdd: () => void }) {
  return (
    <button
      type="button"
      onClick={onAdd}
      className="group flex w-full items-center gap-5 rounded-xl border border-dashed border-divider bg-surface p-4 text-left transition-colors duration-150 hover:border-ink-3 hover:bg-soft/40 sm:p-5"
    >
      <Orbit kinds={distinctIcons(groups.flatMap((group) => group.kinds))} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="flex size-5 items-center justify-center rounded-full bg-signal text-white sm:hidden [&_svg]:size-3.5">
            <Plus />
          </span>
          Add {article(noun)} {noun}
        </div>
        <p className="mt-1 text-sm text-ink-2">{pitch}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {groups.map((group) => (
            <Chip key={group.title} tone="outline">
              {group.icon}
              {group.title}
            </Chip>
          ))}
        </div>
      </div>
    </button>
  )
}

function EmptyGroup({ group, onAdd }: { group: ConnectionGroup; onAdd?: () => void }) {
  const labels = group.kinds.map((kind) => KINDS[kind].label)
  return (
    <div className="flex min-h-36 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-divider p-4 text-center">
      <div className="flex -space-x-1.5">
        {distinctIcons(group.kinds).map((kind) => (
          <span
            key={kind}
            className="flex size-7 items-center justify-center rounded-md border border-divider bg-surface text-ink-3 [&_svg]:size-3.5"
          >
            {KINDS[kind].icon}
          </span>
        ))}
      </div>
      <p className="max-w-xs text-xs text-ink-2">Nothing here yet. Connect {listOf(labels)}.</p>
      {onAdd ? (
        <Button size="sm" onClick={onAdd}>
          <Plus />
          Connect
        </Button>
      ) : null}
    </div>
  )
}

export function ConnectionBoard({ tab }: { tab: keyof typeof TABS }) {
  const { title, description, noun, pitch, groups } = TABS[tab]
  const { data, error, mutate } = useConnections()
  const { data: me } = useMe()
  const plugins = usePlugins().data?.plugins ?? []
  const admin = me?.account.role === 'admin'
  const [editing, setEditing] = useState<ConnectionDto | null>(null)
  const [offered, setOffered] = useState<Kind[]>([])
  const [open, setOpen] = useState(false)
  const [webhookFor, setWebhookFor] = useState<ConnectionDto | null>(null)
  const [deleting, setDeleting] = useState<ConnectionDto | null>(null)
  const [removing, setRemoving] = useState(false)
  const uses = useConnectionUses(deleting?.id ?? null)
  const start = (connection: ConnectionDto | null, kinds: Kind[]) => {
    setEditing(connection)
    setOffered(kinds)
    setOpen(true)
  }
  const askToDelete = (connection: ConnectionDto) => {
    setOpen(false)
    setDeleting(connection)
  }
  const remove = async () => {
    if (!deleting) return
    setRemoving(true)
    try {
      await api.delete(`/api/connections/${deleting.id}`)
      setDeleting(null)
      await mutate()
    } catch (error) {
      toast.error((error as Error).message)
      void uses.mutate()
    } finally {
      setRemoving(false)
    }
  }
  const inUse = uses.data?.uses ?? []
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-5">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-sm text-ink-2">{description}</p>
      </div>
      {error && !data ? (
        <ErrorState error={error} retry={() => void mutate()} />
      ) : !data ? (
        <ListSkeleton rows={3} />
      ) : (
        <div className="flex flex-col gap-8">
          {admin ? (
            <AddTile
              noun={noun}
              pitch={pitch}
              groups={groups}
              onAdd={() =>
                start(
                  null,
                  groups.flatMap((group) => group.kinds),
                )
              }
            />
          ) : null}
          {groups.map((group) => {
            const items = data.connections.filter((connection) => group.kinds.includes(connection.kind))
            return (
              <section key={group.title} aria-label={group.title}>
                <div className="mb-3 flex items-center gap-2">
                  <span className="text-ink-3 [&_svg]:size-4">{group.icon}</span>
                  <h2 className="text-sm font-semibold">{group.title}</h2>
                  <span className="text-xs text-ink-3 tabular-nums">{items.length}</span>
                  <p className="hidden min-w-0 truncate text-xs text-ink-2 sm:block">{group.description}</p>
                  {admin && items.length > 0 ? (
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={() => start(null, group.kinds)}>
                      <Plus />
                      Add
                    </Button>
                  ) : null}
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {items.map((connection) => (
                    <ConnectionCard
                      key={connection.id}
                      connection={connection}
                      pluginName={plugins.find((plugin) => plugin.id === connection.config.pluginId)?.name}
                      admin={admin}
                      onEdit={() => start(connection, [connection.kind])}
                      onWebhook={() => setWebhookFor(connection)}
                    />
                  ))}
                  {items.length === 0 ? <EmptyGroup group={group} onAdd={admin ? () => start(null, group.kinds) : undefined} /> : null}
                </div>
              </section>
            )
          })}
        </div>
      )}
      <ConnectionDialog
        connection={editing}
        kinds={offered}
        noun={noun}
        open={open}
        onOpenChange={setOpen}
        onSaved={(saved) => {
          void mutate()
          if (!editing && saved.webhookUrl && saved.kind !== 'slack') toast.success('Connected. Create a project to register its webhooks.')
        }}
        onDelete={askToDelete}
      />
      <Dialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
        title={`Delete ${deleting?.name ?? 'this connection'}?`}
        description={
          !uses.data
            ? 'Checking what uses it.'
            : inUse.length > 0
              ? 'Something still uses it. Remove it from these first, so nothing loses it without you choosing that.'
              : 'Nothing uses it. Factorix forgets its secret and stops taking its webhooks. This cannot be undone.'
        }
      >
        {inUse.length > 0 ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
            {inUse.map((use) => (
              <li key={use}>{use}</li>
            ))}
          </ul>
        ) : null}
        {uses.error ? <p className="text-sm text-danger-ink">{(uses.error as Error).message}</p> : null}
        <DialogFooter>
          <Button size="sm" onClick={() => setDeleting(null)}>
            Keep it
          </Button>
          <Button size="sm" variant="danger" loading={removing} disabled={!uses.data || inUse.length > 0} onClick={() => void remove()}>
            Delete {noun}
          </Button>
        </DialogFooter>
      </Dialog>
      <Dialog
        open={webhookFor !== null}
        onOpenChange={(value) => {
          if (!value) setWebhookFor(null)
        }}
        title={`${webhookFor?.name ?? ''} webhook`}
        description={
          webhookFor?.kind === 'slack'
            ? 'Slack sends its events here, so workflows can start from messages.'
            : 'Project setup can register this for you. Use these values if your token cannot.'
        }
      >
        {webhookFor?.webhookUrl ? (
          <div className="flex flex-col gap-3">
            <CopyField label="URL" value={webhookFor.webhookUrl} />
            {webhookFor.webhookSecret ? (
              <CopyField label={webhookFor.kind === 'gitlab' ? 'Secret token' : 'Signing secret'} value={webhookFor.webhookSecret} secret />
            ) : null}
            <p className="text-xs text-ink-2">
              {webhookFor.kind === 'slack'
                ? 'In your Slack app, turn on Event Subscriptions, paste this as the Request URL, and subscribe the bot to app_mention, message.channels, message.groups, and message.im. It also needs the app_mentions:read, channels:history, groups:history, and im:history scopes, and for direct messages the Messages tab under App Home. Slack checks the URL right away, so save the signing secret first.'
                : webhookFor.kind === 'gitlab'
                  ? 'Enable merge request, comment, and pipeline events on the project.'
                  : webhookFor.kind === 'trello'
                    ? 'Project setup registers this on the board. Trello signs with the API secret of its key, so webhooks are accepted once that secret is saved on the connection.'
                    : webhookFor.kind === 'jira'
                      ? 'Paste the secret into the webhook in Jira, limit it to the project, and enable issue created, updated, and deleted, and comment created and updated. Data Center cannot sign webhooks, so it relies on polling.'
                      : webhookFor.kind === 'github'
                        ? 'Send JSON, and enable pull requests, pull request reviews, pull request review comments, issue comments, check suites, and statuses.'
                        : 'Enable issues, issue comments, and issue labels.'}
            </p>
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}
