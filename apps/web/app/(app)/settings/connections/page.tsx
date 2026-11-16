'use client'

import type { ConnectionDto } from '@factorix/schemas'
import { Bot, CheckCircle2, CircleAlert, GitBranch, GitPullRequest, Hash, KeyRound, Plug, Plus, Puzzle, SquareKanban, Vault } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/modules/lib/api'
import { useConnections, useMe, usePlugins } from '@/modules/lib/data'
import { timeAgo } from '@/modules/lib/format'
import { PluginFields } from '@/modules/plugins/fields'
import { Button, Chip, CopyField, Dialog, EmptyState, ErrorState, Field, Input, ListSkeleton, Select, Textarea } from '@/modules/ui'
import { ConnectionsArt } from '@/modules/ui/empty-art'

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
    hint: 'A tracker served by a plugin that is turned on under Settings, Plugins',
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
    hint: 'Workflows post to its channels. The bot token needs chat:write, chat:write.public, channels:read, and groups:read',
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
  open,
  onOpenChange,
  onSaved,
}: {
  connection: ConnectionDto | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (saved: ConnectionDto) => void
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
    setKind(connection?.kind ?? 'linear')
    setName(connection?.name ?? '')
    setSecret('')
    setUrl(String(connection?.config.url ?? ''))
    setCommand(String(connection?.config.command ?? ''))
    setArgs(((connection?.config.args as string[] | undefined) ?? []).join(' '))
    setHost(String(connection?.config.host ?? SCM_HOSTS[connection?.kind ?? 'gitlab'] ?? (connection?.kind === 'jira' ? '' : 'https://gitlab.com')))
    setEmail(String(connection?.config.email ?? ''))
    setApiKey(String(connection?.config.apiKey ?? ''))
    setApiSecret('')
    setBotName(String(connection?.config.botName ?? ''))
    setBotEmail(String(connection?.config.botEmail ?? ''))
  }, [open, connection])

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
            : kind === 'mcp_http'
              ? { url }
              : kind === 'mcp_stdio'
                ? { command, args: args.split(/\s+/).filter(Boolean) }
                : {}
      let secretValue: unknown
      if (secret) secretValue = usesJsonSecret(kind) ? JSON.parse(secret) : secret
      if (kind === 'plugin') {
        if (!plugin) throw new Error('Turn a plugin on under Settings, Plugins first')
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
    <Dialog open={open} onOpenChange={onOpenChange} title={connection ? connection.name : 'Add a connection'} description={meta.hint}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        {connection ? null : (
          <Field label="Kind">
            <Select
              value={kind}
              onChange={(value) => {
                setKind(value as ConnectionDto['kind'])
                const defaultHost = SCM_HOSTS[value as ConnectionDto['kind']]
                if (defaultHost) setHost(defaultHost)
                else if (value === 'jira') setHost('')
              }}
              options={Object.entries(KINDS).map(([value, item]) => ({ value, label: item.label, hint: item.hint }))}
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
            <p className="text-sm text-ink-2">No plugin with a tracker is turned on. Turn one on under Settings, Plugins.</p>
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
          <Button type="submit" variant="primary" loading={loading}>
            {connection ? 'Save changes' : 'Add connection'}
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
        <span className={`hidden min-w-0 items-center gap-1 truncate text-xs sm:flex ${result.ok ? 'text-success' : 'text-danger-ink'}`}>
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

export default function ConnectionsPage() {
  const { data, error, mutate } = useConnections()
  const { data: me } = useMe()
  const admin = me?.account.role === 'admin'
  const [editing, setEditing] = useState<ConnectionDto | null>(null)
  const [open, setOpen] = useState(false)
  const [webhookFor, setWebhookFor] = useState<ConnectionDto | null>(null)
  const start = (connection: ConnectionDto | null) => {
    setEditing(connection)
    setOpen(true)
  }
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Connections</h1>
          <p className="text-sm text-ink-2">Accounts the factory uses to reach your tracker, your code, and models.</p>
        </div>
        {admin ? (
          <Button size="sm" onClick={() => start(null)}>
            <Plus />
            Add
          </Button>
        ) : null}
      </div>
      {error && !data ? (
        <ErrorState error={error} retry={() => void mutate()} />
      ) : !data ? (
        <ListSkeleton rows={3} />
      ) : data.connections.length === 0 ? (
        <EmptyState
          art={<ConnectionsArt />}
          title="Nothing connected yet"
          action={
            admin ? (
              <Button variant="primary" onClick={() => start(null)}>
                Add a connection
              </Button>
            ) : undefined
          }
        >
          Start with GitLab or GitHub and a model API key. Add Linear too, or use Factorix's own tickets.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border border-divider">
          {data.connections.map((connection) => {
            const meta = KINDS[connection.kind]
            return (
              <div key={connection.id} className="flex min-h-13 items-center gap-3 border-b border-divider px-4 py-2 last:border-b-0">
                <span className="shrink-0 text-ink-2 [&_svg]:size-5">{meta.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="truncate">{connection.name}</span>
                    {!connection.hasSecret && connection.kind !== 'mcp_stdio' && connection.kind !== 'factorix' ? <Chip>No secret</Chip> : null}
                  </div>
                  <div className="truncate text-xs text-ink-2">
                    {meta.label}, {connection.config.botName ? `commits as ${String(connection.config.botName)}, ` : ''}updated{' '}
                    {timeAgo(connection.updatedAt)} ago
                  </div>
                </div>
                <TestResult connectionId={connection.id} />
                {connection.webhookUrl && admin ? (
                  <Button size="sm" variant="ghost" onClick={() => setWebhookFor(connection)}>
                    Webhook
                  </Button>
                ) : null}
                {admin ? (
                  <Button size="sm" variant="ghost" onClick={() => start(connection)}>
                    Edit
                  </Button>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
      <ConnectionDialog
        connection={editing}
        open={open}
        onOpenChange={setOpen}
        onSaved={(saved) => {
          void mutate()
          if (!editing && saved.webhookUrl) toast.success('Connected. Create a project to register its webhooks.')
        }}
      />
      <Dialog
        open={webhookFor !== null}
        onOpenChange={(value) => {
          if (!value) setWebhookFor(null)
        }}
        title={`${webhookFor?.name ?? ''} webhook`}
        description="Project setup can register this for you. Use these values if your token cannot."
      >
        {webhookFor?.webhookUrl ? (
          <div className="flex flex-col gap-3">
            <CopyField label="URL" value={webhookFor.webhookUrl} />
            {webhookFor.webhookSecret ? (
              <CopyField label={webhookFor.kind === 'gitlab' ? 'Secret token' : 'Signing secret'} value={webhookFor.webhookSecret} secret />
            ) : null}
            <p className="text-xs text-ink-2">
              {webhookFor.kind === 'gitlab'
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
