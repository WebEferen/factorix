'use client'

import { API_TOKEN_SCOPES, type ApiTokenDto, type ApiTokenScope, DEFAULT_API_TOKEN_SCOPES } from '@factorix/schemas'
import { Plus } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { api, fetcher } from '@/modules/lib/api'
import { fullDate, timeAgo } from '@/modules/lib/format'
import { Button, Chip, CopyField, Dialog, EmptyState, ErrorState, Field, Input, ListSkeleton, Select, Toggle } from '@/modules/ui'

const NEVER = 'never'
const EXPIRY = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: NEVER, label: 'Never', hint: 'Lasts until you revoke it' },
]

const NEW_TOKEN = { name: '', expiry: '90', scopes: DEFAULT_API_TOKEN_SCOPES }

export default function TokensPage() {
  const { data, error, mutate } = useSWR<{ tokens: ApiTokenDto[] }>('/api/tokens', fetcher as never)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<{ name: string; expiry: string; scopes: ApiTokenScope[] }>(NEW_TOKEN)
  const [loading, setLoading] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const close = (next: boolean) => {
    setOpen(next)
    if (!next) setSecret(null)
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try {
      const created = await api.post<{ secret: string }>('/api/tokens', {
        name: form.name,
        scopes: form.scopes,
        expiresInDays: form.expiry === NEVER ? undefined : Number(form.expiry),
      })
      setSecret(created.secret)
      setForm(NEW_TOKEN)
      void mutate()
    } catch (caught) {
      toast.error((caught as Error).message)
    } finally {
      setLoading(false)
    }
  }
  const revoke = async (token: ApiTokenDto) => {
    try {
      await api.delete(`/api/tokens/${token.id}`)
      toast.success(`Revoked ${token.name}`)
      void mutate()
    } catch (caught) {
      toast.error((caught as Error).message)
    }
  }
  const address = typeof window === 'undefined' ? '' : window.location.origin
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">API tokens</h1>
          <p className="text-sm text-ink-2">
            Your own keys for the <code>fx</code> command line and its MCP server. A token can read what you can and change only what you allow it to.
            Admin actions and tokens themselves stay in the browser.
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus />
          New token
        </Button>
      </div>
      {error && !data ? (
        <ErrorState error={error} retry={() => void mutate()} />
      ) : !data ? (
        <ListSkeleton rows={3} />
      ) : data.tokens.length === 0 ? (
        <EmptyState title="No tokens yet">Create one, then run fx login in a terminal to hand work to agents from there.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border border-divider">
          {data.tokens.map((token) => {
            const expired = token.expiresAt !== null && new Date(token.expiresAt).getTime() < Date.now()
            return (
              <div key={token.id} className="flex h-13 items-center gap-3 border-b border-divider px-4 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{token.name}</div>
                  <div className="truncate text-xs text-ink-2">
                    <code>{token.prefix}…</code> · {token.lastUsedAt ? `used ${timeAgo(token.lastUsedAt)}` : 'never used'} ·{' '}
                    {token.scopes.length > 0
                      ? API_TOKEN_SCOPES.filter((scope) => token.scopes.includes(scope.id))
                          .map((scope) => scope.label.toLowerCase())
                          .join(', ')
                      : 'read only'}
                  </div>
                </div>
                {expired ? (
                  <Chip tone="danger">Expired</Chip>
                ) : (
                  <span className="text-xs text-ink-2">{token.expiresAt ? `Expires ${fullDate(token.expiresAt)}` : 'No expiry'}</span>
                )}
                <Button size="sm" variant="ghost" onClick={() => void revoke(token)}>
                  Revoke
                </Button>
              </div>
            )
          })}
        </div>
      )}
      <Dialog open={open} onOpenChange={close} title={secret ? 'Copy your token' : 'New API token'}>
        {secret ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-2">This is the only time it is shown. Factorix keeps a hash of it, not the token.</p>
            <CopyField label="Token" value={secret} secret />
            <CopyField label="Log in from a terminal" value={`fx login --url ${address} --token ${secret}`} secret />
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => close(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field label="Name" hint="Where it will live, such as a laptop or a CI job.">
              <Input required autoFocus maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </Field>
            <Field label="Expires">
              <Select value={form.expiry} onChange={(expiry) => setForm({ ...form, expiry })} options={EXPIRY} />
            </Field>
            <div className="flex flex-col gap-2">
              <div>
                <div className="text-sm text-ink">Can change</div>
                <div className="text-xs text-ink-2">Reading is always allowed. With nothing ticked the token is read only.</div>
              </div>
              {API_TOKEN_SCOPES.map((scope) => (
                <Toggle
                  key={scope.id}
                  checked={form.scopes.includes(scope.id)}
                  label={scope.label}
                  hint={scope.description}
                  onChange={(on) => setForm({ ...form, scopes: on ? [...form.scopes, scope.id] : form.scopes.filter((id) => id !== scope.id) })}
                />
              ))}
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={loading}>
                Create token
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  )
}
