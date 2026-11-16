'use client'

import type { AccountDto } from '@factorix/schemas'
import { MoreHorizontal, Plus, Shield, User, UserMinus } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { api, fetcher } from '@/modules/lib/api'
import { useMe } from '@/modules/lib/data'
import {
  Avatar,
  Button,
  Chip,
  Dialog,
  ErrorState,
  Field,
  Input,
  ListSkeleton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Select,
} from '@/modules/ui'

export default function MembersPage() {
  const { data, error, mutate } = useSWR<{ members: AccountDto[] }>('/api/members', fetcher as never)
  const { data: me } = useMe()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'member' })
  const [loading, setLoading] = useState(false)
  const [removing, setRemoving] = useState<AccountDto | null>(null)
  const admin = me?.account.role === 'admin'
  const act = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work()
      toast.success(done)
      void mutate()
    } catch (caught) {
      toast.error((caught as Error).message)
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try {
      const { existing } = await api.post<{ existing: boolean }>('/api/members', { ...form, password: form.password || undefined })
      if (existing) toast.success(`${form.email} already signs in here, so they keep their own name and password.`)
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
          <p className="text-sm text-ink-2">People who work in {me?.org.name ?? 'this organization'}. Agents have their own accounts under Agents.</p>
        </div>
        {admin ? (
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
              {member.id === me?.account.id ? <Chip>You</Chip> : null}
              <Chip tone={member.role === 'admin' ? 'info' : 'neutral'}>{member.role === 'admin' ? 'Admin' : 'Member'}</Chip>
              {admin && member.id !== me?.account.id ? (
                <Menu>
                  <MenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={`Change ${member.displayName}`}>
                      <MoreHorizontal />
                    </Button>
                  </MenuTrigger>
                  <MenuContent align="end">
                    {member.role === 'admin' ? (
                      <MenuItem
                        onSelect={() =>
                          void act(() => api.put(`/api/members/${member.id}`, { role: 'member' }), `${member.displayName} is now a member`)
                        }
                      >
                        <User />
                        Make a member
                      </MenuItem>
                    ) : (
                      <MenuItem
                        onSelect={() =>
                          void act(() => api.put(`/api/members/${member.id}`, { role: 'admin' }), `${member.displayName} is now an admin`)
                        }
                      >
                        <Shield />
                        Make an admin
                      </MenuItem>
                    )}
                    <MenuSeparator />
                    <MenuItem onSelect={() => setRemoving(member)}>
                      <UserMinus />
                      Remove from organization
                    </MenuItem>
                  </MenuContent>
                </Menu>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <Dialog
        open={removing !== null}
        onOpenChange={(next) => (next ? undefined : setRemoving(null))}
        title={`Remove ${removing?.displayName ?? ''}?`}
      >
        <p className="text-sm text-ink-2">
          They lose access to {me?.org.name ?? 'this organization'} now, and their API tokens for it stop working. What they did stays in the history.
          They keep any other organization they are in, and you can add them back later.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setRemoving(null)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              const member = removing
              setRemoving(null)
              if (member) void act(() => api.delete(`/api/members/${member.id}`), `${member.displayName} was removed`)
            }}
          >
            Remove
          </Button>
        </div>
      </Dialog>
      <Dialog open={open} onOpenChange={setOpen} title="Add a member">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label="Name">
            <Input required autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Email">
            <Input required type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </Field>
          <Field
            label="Temporary password"
            hint="At least 10 characters. Share it with them directly. Leave it empty for someone who already signs in to another organization here."
          >
            <Input
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
