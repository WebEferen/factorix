'use client'

import type { OrgSummaryDto } from '@factorix/schemas'
import { Plus } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { api, fetcher } from '@/modules/lib/api'
import { useMe } from '@/modules/lib/data'
import { Button, Chip, Dialog, ErrorState, Field, Input, ListSkeleton } from '@/modules/ui'

const switchTo = (orgId: string) =>
  api.post('/api/auth/switch', { orgId }).then(() => {
    window.location.href = '/'
  })

export default function OrganizationsPage() {
  const { data: me, mutate: reloadMe } = useMe()
  const { data, error, mutate } = useSWR<{ orgs: OrgSummaryDto[] }>(me?.installationAdmin ? '/api/orgs' : null, fetcher as never)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try {
      await api.post('/api/orgs', { name })
      setName('')
      setOpen(false)
      void mutate()
      void reloadMe()
    } catch (caught) {
      toast.error((caught as Error).message)
    } finally {
      setLoading(false)
    }
  }
  const mine = new Set(me?.orgs.map((org) => org.id))
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Organizations</h1>
          <p className="text-sm text-ink-2">
            Each organization has its own projects, agents, connections, and members, and none can see another's. You become the admin of one you
            create.
          </p>
        </div>
        {me?.installationAdmin ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus />
            New organization
          </Button>
        ) : null}
      </div>
      {me && !me.installationAdmin ? (
        <p className="text-sm text-ink-2">Only an installation admin can see and create organizations.</p>
      ) : error && !data ? (
        <ErrorState error={error} retry={() => void mutate()} />
      ) : !data ? (
        <ListSkeleton rows={3} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-divider">
          {data.orgs.map((org) => (
            <div key={org.id} className="flex h-13 items-center gap-3 border-b border-divider px-4 last:border-b-0">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-soft text-sm font-bold">
                {org.name.charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{org.name}</div>
                <div className="truncate text-xs text-ink-2">
                  {org.memberCount} {org.memberCount === 1 ? 'member' : 'members'}, {org.projectCount}{' '}
                  {org.projectCount === 1 ? 'project' : 'projects'}
                </div>
              </div>
              {org.id === me?.org.id ? (
                <Chip tone="info">Current</Chip>
              ) : mine.has(org.id) ? (
                <Button size="sm" onClick={() => void switchTo(org.id)}>
                  Switch
                </Button>
              ) : (
                <Chip>Not a member</Chip>
              )}
            </div>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen} title="New organization">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label="Name" hint="It starts with the default agents, skills, and pipeline, and with you as its admin.">
            <Input required autoFocus maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={loading}>
              Create
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  )
}
