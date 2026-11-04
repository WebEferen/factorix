'use client'

import type { AccountDto } from '@factorix/schemas'
import { Plus } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { api, fetcher } from '@/modules/lib/api'
import { useMe } from '@/modules/lib/data'
import { Avatar, Button, Chip, Dialog, ErrorState, Field, Input, ListSkeleton, Select } from '@/modules/ui'

export default function MembersPage() {
  const { data, error, mutate } = useSWR<{ members: AccountDto[] }>('/api/members', fetcher as never)
  const { data: me } = useMe()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'member' })
  const [loading, setLoading] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try {
      await api.post('/api/members', form)
      setForm({ name: '', email: '', password: '', role: 'member' })
      setOpen(false)
      void mutate()
    } catch (caught) {
      toast.error((caught as Error).message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Members</h1>
          <p className="text-sm text-ink-2">People who can log in. Agents have their own accounts under Agents.</p>
        </div>
        {me?.account.role === 'admin' ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus />
            Add member
          </Button>
        ) : null}
      </div>
      {error && !data ? (
        <ErrorState error={error} retry={() => void mutate()} />
      ) : !data ? (
        <ListSkeleton rows={3} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-divider">
          {data.members.map((member) => (
            <div key={member.id} className="flex h-13 items-center gap-3 border-b border-divider px-4 last:border-b-0">
              <Avatar name={member.displayName} size={28} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{member.displayName}</div>
                <div className="truncate text-xs text-ink-2">{member.email}</div>
              </div>
              {member.status === 'disabled' ? <Chip>Disabled</Chip> : null}
              <Chip tone={member.role === 'admin' ? 'info' : 'neutral'}>{member.role === 'admin' ? 'Admin' : 'Member'}</Chip>
            </div>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen} title="Add a member">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label="Name">
            <Input required autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Email">
            <Input required type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </Field>
          <Field label="Temporary password" hint="At least 10 characters. Share it with them directly.">
            <Input
              required
              type="password"
              minLength={10}
              autoComplete="new-password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
            />
          </Field>
          <Field label="Role">
            <Select
              value={form.role}
              onChange={(role) => setForm({ ...form, role })}
              options={[
                { value: 'member', label: 'Member', hint: 'Works with issues, agents, and runs' },
                { value: 'admin', label: 'Admin', hint: 'Also manages connections and members' },
              ]}
            />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={loading}>
              Add member
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  )
}
