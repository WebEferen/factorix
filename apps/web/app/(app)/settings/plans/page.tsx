'use client'

import { MODEL_PLANS, type ModelPlanId } from '@factorix/runtime'
import type { ModelLoginDto, ModelPlansDto } from '@factorix/schemas'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/modules/lib/api'
import { useClaudeLoginAttempt, useMe, useModelPlans } from '@/modules/lib/data'
import { timeAgo } from '@/modules/lib/format'
import { Button, buttonStyles, Chip, Dialog, ErrorState, Field, Input, ListSkeleton, Toggle } from '@/modules/ui'

function describe(login: ModelLoginDto): string {
  const parts = [login.email, login.plan ? `${login.plan} plan` : null, login.lastUsedAt ? `used ${timeAgo(login.lastUsedAt)}` : 'not used yet']
  return parts.filter(Boolean).join(' · ')
}

function ConnectChatgpt({ open, onOpenChange, onConnected }: { open: boolean; onOpenChange: (open: boolean) => void; onConnected: () => void }) {
  const [address, setAddress] = useState('')
  const [opening, setOpening] = useState(false)
  const [saving, setSaving] = useState(false)

  const openChatgpt = async () => {
    // Opened before the request, so the browser counts it as the click's own window and does not block it.
    const tab = window.open('about:blank', '_blank')
    setOpening(true)
    try {
      const { url } = await api.post<{ url: string }>('/api/model-plans/chatgpt/start', {})
      if (tab) {
        tab.opener = null
        tab.location.href = url
      } else window.location.assign(url)
    } catch (error) {
      tab?.close()
      toast.error((error as Error).message)
    } finally {
      setOpening(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      await api.post('/api/model-plans/chatgpt/complete', { callbackUrl: address })
      toast.success('ChatGPT plan connected')
      setAddress('')
      onConnected()
      onOpenChange(false)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Connect your ChatGPT plan">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink-2">
            1. Sign in to ChatGPT and approve Factorix using your plan. In ChatGPT's settings you can cap how much of your weekly usage it may take.
          </p>
          <div>
            <Button type="button" onClick={() => void openChatgpt()} loading={opening}>
              Open ChatGPT
            </Button>
          </div>
        </div>
        <Field
          label="2. Paste the address you land on"
          hint="ChatGPT then sends you to a 127.0.0.1 page that does not load. Copy that page's whole address from the address bar."
        >
          <Input
            required
            value={address}
            placeholder="http://127.0.0.1:1455/auth/callback?code=…"
            onChange={(event) => setAddress(event.target.value)}
            className="font-mono text-xs"
          />
        </Field>
        <p className="text-xs text-ink-2">
          With the <code>fx</code> command line, <code>fx plan login chatgpt</code> does both steps for you.
        </p>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={saving} disabled={!address.trim()}>
            Connect
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function ConnectClaude({ open, onOpenChange, onConnected }: { open: boolean; onOpenChange: (open: boolean) => void; onConnected: () => void }) {
  const [attemptId, setAttemptId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const { data, mutate } = useClaudeLoginAttempt(attemptId)
  const attempt = data?.attempt
  const status = attempt?.status

  useEffect(() => {
    if (status !== 'done') return
    toast.success('Claude plan connected')
    setAttemptId(null)
    setCode('')
    onConnected()
    onOpenChange(false)
  }, [status, onConnected, onOpenChange])

  const start = async () => {
    setStarting(true)
    try {
      const started = await api.post<{ attemptId: string }>('/api/model-plans/claude/start', {})
      setCode('')
      setAttemptId(started.attemptId)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setStarting(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!attemptId) return
    setSending(true)
    try {
      await api.post(`/api/model-plans/claude/attempts/${attemptId}/code`, { code })
      await mutate()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setAttemptId(null)
        onOpenChange(next)
      }}
      title="Connect your Claude plan"
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-2">
          You sign in on Claude's own page, and Claude Code keeps the sign-in where only your runs use it. Factorix never sees your Claude password or
          tokens.
        </p>
        {!attemptId || status === 'failed' ? (
          <>
            {attempt?.error ? <p className="text-sm text-danger-ink">{attempt.error}</p> : null}
            <div>
              <Button variant="primary" onClick={() => void start()} loading={starting}>
                {attempt?.error ? 'Try again' : 'Start signing in'}
              </Button>
            </div>
          </>
        ) : status === 'waiting' && attempt?.url ? (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <p className="text-sm text-ink-2">1. Sign in to Claude and approve Claude Code.</p>
              <div>
                <a href={attempt.url} target="_blank" rel="noreferrer" className={buttonStyles({ variant: 'outline' })}>
                  Open Claude
                </a>
              </div>
            </div>
            <Field label="2. Paste the code Claude shows">
              <Input required value={code} onChange={(event) => setCode(event.target.value)} className="font-mono text-xs" autoComplete="off" />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={sending} disabled={!code.trim()}>
                Connect
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-ink-2">{status === 'checking' ? 'Checking the code with Claude…' : 'Starting Claude Code…'}</p>
        )}
      </div>
    </Dialog>
  )
}

function PlanRow({
  id,
  login,
  enabled,
  onConnect,
  onChanged,
}: {
  id: ModelPlanId
  login?: ModelLoginDto
  enabled: boolean
  onConnect: () => void
  onChanged: () => void
}) {
  const [removing, setRemoving] = useState(false)
  const disconnect = async () => {
    if (!login) return
    setRemoving(true)
    try {
      await api.delete(`/api/model-plans/${login.id}`)
      toast.success(`Disconnected your ${MODEL_PLANS[id].label} plan`)
      onChanged()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setRemoving(false)
    }
  }
  return (
    <div className="flex min-h-13 flex-wrap items-center gap-3 border-b border-divider px-4 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{MODEL_PLANS[id].label}</div>
        <div className="truncate text-xs text-ink-2">{login ? describe(login) : 'Not connected'}</div>
        {login?.status === 'needs_login' && login.lastError ? <div className="text-xs text-danger-ink">{login.lastError}</div> : null}
      </div>
      {login ? (
        <Chip tone={login.status === 'active' ? 'success' : 'warning'}>{login.status === 'active' ? 'Connected' : 'Sign in again'}</Chip>
      ) : null}
      {enabled && login?.status !== 'active' ? (
        <Button size="sm" onClick={onConnect}>
          {login ? 'Sign in again' : 'Connect'}
        </Button>
      ) : null}
      {login ? (
        <Button size="sm" variant="ghost" onClick={() => void disconnect()} loading={removing}>
          Disconnect
        </Button>
      ) : null}
    </div>
  )
}

function AdminSwitch({ data, onSaved }: { data: ModelPlansDto; onSaved: (enabled: boolean) => void }) {
  const [saving, setSaving] = useState(false)
  const change = async (enabled: boolean) => {
    setSaving(true)
    try {
      await api.put('/api/settings/model-plans', { enabled })
      onSaved(enabled)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="mb-4 rounded-lg border border-divider p-4">
      <Toggle
        checked={data.enabled}
        disabled={saving}
        onChange={(enabled) => void change(enabled)}
        label="Let members use their own plans"
        hint="Their runs then go to the vendor under their personal plan's terms, not this organization's API agreement. Applies from the next run."
      />
    </div>
  )
}

export default function ModelPlansPage() {
  const { data: me } = useMe()
  const { data, error, mutate } = useModelPlans()
  const refresh = useCallback(() => void mutate(), [mutate])
  const [connecting, setConnecting] = useState<ModelPlanId | null>(null)
  const admin = me?.account.role === 'admin'
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <h1 className="text-xl font-semibold">Model plans</h1>
      <p className="mb-4 text-sm text-ink-2">
        Run your own work on your own plan instead of the organization's keys. A plan only serves runs you start: a ticket you hand to an agent,
        start, or retry here, a workflow you run or set off from here, and a task you give an agent. Runs a tracker or a schedule starts stay on the
        organization's keys.
      </p>
      {error && !data ? (
        <ErrorState error={error} retry={() => void mutate()} />
      ) : !data ? (
        <ListSkeleton rows={2} />
      ) : (
        <>
          {admin ? <AdminSwitch data={data} onSaved={(enabled) => void mutate({ ...data, enabled })} /> : null}
          {!data.enabled ? (
            <p className="mb-4 text-sm text-ink-2">An admin has to let members use their own plans before you can connect one.</p>
          ) : null}
          <div className="overflow-hidden rounded-lg border border-divider">
            {(['chatgpt', 'claude'] as const).map((id) => (
              <PlanRow
                key={id}
                id={id}
                login={data.logins.find((login) => login.provider === id)}
                enabled={data.enabled}
                onConnect={() => setConnecting(id)}
                onChanged={() => void mutate()}
              />
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-2">
            A Claude plan serves runs on this Factorix's own machine, in projects that give agents network access. Runs on a remote runner use the
            organization's key.
          </p>
        </>
      )}
      <ConnectChatgpt
        open={connecting === 'chatgpt'}
        onOpenChange={(open) => setConnecting(open ? 'chatgpt' : null)}
        onConnected={() => void mutate()}
      />
      <ConnectClaude open={connecting === 'claude'} onOpenChange={(open) => setConnecting(open ? 'claude' : null)} onConnected={refresh} />
    </div>
  )
}
