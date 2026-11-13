'use client'

import type { RunnerDto } from '@factorix/schemas'
import { Plus } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { api, fetcher } from '@/modules/lib/api'
import { useMe } from '@/modules/lib/data'
import { timeAgo } from '@/modules/lib/format'
import { Button, Chip, CopyField, Dialog, EmptyState, ErrorState, Field, Input, ListSkeleton } from '@/modules/ui'

export default function RunnersPage() {
  const { data, error, mutate } = useSWR<{ runners: RunnerDto[] }>('/api/runners', fetcher as never, { refreshInterval: 10_000 })
  const { data: me } = useMe()
  const admin = me?.account.role === 'admin'
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
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
      const created = await api.post<{ secret: string }>('/api/runners', { name })
      setSecret(created.secret)
      setName('')
      void mutate()
    } catch (caught) {
      toast.error((caught as Error).message)
    } finally {
      setLoading(false)
    }
  }
  const remove = async (runner: RunnerDto) => {
    try {
      await api.delete(`/api/runners/${runner.id}`)
      toast.success(`Removed ${runner.name}`)
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
          <h1 className="text-xl font-semibold">Runners</h1>
          <p className="text-sm text-ink-2">
            Other machines that run agents for a project. A runner needs Docker and a way out to this address, and nothing has to reach it. Pick one
            under a project's settings.
          </p>
        </div>
        {admin ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus />
            Add runner
          </Button>
        ) : null}
      </div>
      {error && !data ? (
        <ErrorState error={error} retry={() => void mutate()} />
      ) : !data ? (
        <ListSkeleton rows={2} />
      ) : data.runners.length === 0 ? (
        <EmptyState title="No runners yet">Every project runs on the machine Factorix is installed on.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border border-divider">
          {data.runners.map((runner) => (
            <div key={runner.id} className="flex h-13 items-center gap-3 border-b border-divider px-4 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{runner.name}</div>
                <div className="truncate text-xs text-ink-2">
                  {runner.projectCount === 1 ? '1 project' : `${runner.projectCount} projects`} ·{' '}
                  {runner.online ? 'connected' : runner.lastSeenAt ? `last seen ${timeAgo(runner.lastSeenAt)}` : 'never connected'}
                </div>
              </div>
              <Chip tone={runner.online ? 'success' : 'neutral'}>{runner.online ? 'Online' : 'Offline'}</Chip>
              {admin ? (
                <Button size="sm" variant="ghost" onClick={() => void remove(runner)}>
                  Remove
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={close} title={secret ? 'Start the runner' : 'Add a runner'}>
        {secret ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-2">
              On the other machine, from a checkout of Factorix, build the sandbox image and start the runner. The token is shown only now.
            </p>
            <CopyField label="Token" value={secret} secret />
            <CopyField label="Build the sandbox image" value="docker compose -f docker-compose.runner.yml --profile build-only build" />
            <CopyField
              label="Start it"
              value={`FACTORIX_URL=${address} FACTORIX_RUNNER_TOKEN=${secret} FACTORIX_STORE_SECRET=$(openssl rand -hex 24) docker compose -f docker-compose.runner.yml up -d --build`}
              secret
            />
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => close(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field label="Name" hint="The machine it will run on.">
              <Input required autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={loading}>
                Add runner
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  )
}
