'use client'

import type { ConnectionDto } from '@factorix/schemas'
import { Bot, CheckCircle2, CircleAlert, GitBranch, Hash, KeyRound, Plug, Plus, SquareKanban, Vault } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/modules/lib/api'
import { useConnections, useMe } from '@/modules/lib/data'
import { timeAgo } from '@/modules/lib/format'
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
  gitlab: {
    label: 'GitLab',
    hint: 'Source: repositories, merge requests, CI',
    icon: <GitBranch />,
    secret: 'Personal access token with api and write_repository',
    placeholder: 'glpat-...',
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
  doppler: {
    label: 'Doppler',
    hint: 'Secret source: configs for previews. The token stays in Factorix',
    icon: <Vault />,
    secret: 'Service token, or a service account token to pick from several configs',
    placeholder: 'dp.st...',
  },
}

const usesJsonSecret = (kind: string) => kind === 'mcp_http' || kind === 'generic'

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
  const [botName, setBotName] = useState('')
  const [botEmail, setBotEmail] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open) return
    setKind(connection?.kind ?? 'linear')
    setName(connection?.name ?? '')
    setSecret('')
    setUrl(String(connection?.config.url ?? ''))
    setCommand(String(connection?.config.command ?? ''))
    setArgs(((connection?.config.args as string[] | undefined) ?? []).join(' '))
    setHost(String(connection?.config.host ?? 'https://gitlab.com'))
    setBotName(String(connection?.config.botName ?? ''))
    setBotEmail(String(connection?.config.botEmail ?? ''))
  }, [open, connection])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try {
      const config: Record<string, unknown> =
        kind === 'gitlab'
          ? { host, ...(botName.trim() ? { botName: botName.trim() } : {}), ...(botEmail.trim() ? { botEmail: botEmail.trim() } : {}) }
          : kind === 'mcp_http'
            ? { url }
            : kind === 'mcp_stdio'
              ? { command, args: args.split(/\s+/).filter(Boolean) }
              : {}
      let secretValue: unknown
      if (secret) secretValue = usesJsonSecret(kind) ? JSON.parse(secret) : secret
      const body = { name: name || KINDS[kind].label, config, secret: secretValue }
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
              onChange={(value) => setKind(value as ConnectionDto['kind'])}
              options={Object.entries(KINDS).map(([value, item]) => ({ value, label: item.label, hint: item.hint }))}
            />
          </Field>
        )}
        <Field label="Name">
          <Input value={name} placeholder={meta.label} onChange={(event) => setName(event.target.value)} />
        </Field>
        {kind === 'gitlab' ? (
          <Field label="Host">
            <Input required value={host} onChange={(event) => setHost(event.target.value)} />
          </Field>
        ) : null}
        {kind === 'gitlab' ? (
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
        {kind !== 'mcp_stdio' ? (
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
          Start with Linear, GitLab, and a model API key.
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
                    {!connection.hasSecret && connection.kind !== 'mcp_stdio' ? <Chip>No secret</Chip> : null}
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
                : 'Enable issues, issue comments, and issue labels.'}
            </p>
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}
