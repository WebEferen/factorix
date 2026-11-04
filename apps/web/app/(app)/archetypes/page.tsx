'use client'

import { ARCHETYPE_ROLES, type ArchetypeDto } from '@factorix/schemas'
import { Plus, Shapes } from 'lucide-react'
import Link from 'next/link'
import { type FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/modules/lib/api'
import { useArchetypes, useMe } from '@/modules/lib/data'
import { worksAs } from '@/modules/lib/format'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { Button, Chip, Dialog, DialogColumns, DialogFooter, EmptyState, ErrorState, Field, Input, ListSkeleton, Select, Textarea } from '@/modules/ui'
import { ArchetypesArt } from '@/modules/ui/empty-art'

const ROLE_OPTIONS = ARCHETYPE_ROLES.map((role) => ({ value: role.value, label: role.label, hint: role.hint }))

function ArchetypeDialog({
  archetype,
  open,
  admin,
  onOpenChange,
  onSaved,
  onDelete,
}: {
  archetype: ArchetypeDto | null
  open: boolean
  admin: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  onDelete: (archetype: ArchetypeDto) => void
}) {
  const [form, setForm] = useState({ name: '', description: '', role: 'engineer', systemPrompt: '' })
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (open)
      setForm({
        name: archetype?.name ?? '',
        description: archetype?.description ?? '',
        role: archetype?.role ?? 'engineer',
        systemPrompt: archetype?.systemPrompt ?? '',
      })
  }, [open, archetype])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try {
      if (archetype) await api.put(`/api/archetypes/${archetype.id}`, form)
      else await api.post('/api/archetypes', form)
      onSaved()
      onOpenChange(false)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setLoading(false)
    }
  }
  const agents = archetype?.agents ?? []
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={archetype ? archetype.name : 'New archetype'}
      description="Agents built from an archetype share its prompt. Changes reach them on their next run."
      wide
    >
      <form onSubmit={submit}>
        <DialogColumns
          className="md:grid-cols-[1fr_2fr]"
          start={
            <>
              <Field label="Name">
                <Input
                  required
                  autoFocus={admin}
                  disabled={!admin}
                  maxLength={60}
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="Frontend engineer"
                />
              </Field>
              <Field label="Description">
                <Textarea
                  disabled={!admin}
                  className="min-h-20"
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                />
              </Field>
              <Field label="Works as" hint="Decides which pipeline steps its agents can take.">
                <Select disabled={!admin} value={form.role} onChange={(role) => setForm({ ...form, role })} options={ROLE_OPTIONS} />
              </Field>
              {archetype ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-2">Used by</span>
                  {agents.length === 0 ? (
                    <span className="text-sm text-ink-3">No agents yet</span>
                  ) : (
                    <>
                      <ul className="flex flex-col gap-1 text-sm">
                        {agents.map((agent) => (
                          <li key={agent.id}>
                            <Link href={`/agents/${agent.id}`} className="text-link hover:underline">
                              {agent.displayName}
                            </Link>
                          </li>
                        ))}
                      </ul>
                      {admin ? <span className="text-xs text-ink-3">Move these agents to another archetype before deleting this one.</span> : null}
                    </>
                  )}
                </div>
              ) : null}
            </>
          }
          end={
            <Field label="Prompt" hint="Goes into the system prompt of every agent built from this archetype.">
              <Textarea
                readOnly={!admin}
                className="min-h-96 font-mono text-xs"
                value={form.systemPrompt}
                onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })}
                placeholder="You are a frontend engineer. Care about accessibility and how the change feels in the browser."
              />
            </Field>
          }
        />
        <DialogFooter>
          {admin ? (
            <>
              {archetype ? (
                <div className="mr-auto">
                  <Button type="button" variant="ghost" disabled={agents.length > 0} onClick={() => onDelete(archetype)}>
                    Delete
                  </Button>
                </div>
              ) : null}
              <Button type="submit" variant="primary" loading={loading}>
                {archetype ? 'Save changes' : 'Create archetype'}
              </Button>
            </>
          ) : (
            <Button type="button" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  )
}

export default function ArchetypesPage() {
  const { data, error, mutate } = useArchetypes()
  const { data: me } = useMe()
  const admin = me?.account.role === 'admin'
  const [editing, setEditing] = useState<ArchetypeDto | null>(null)
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState<ArchetypeDto | null>(null)
  const [removing, setRemoving] = useState(false)
  const start = (archetype: ArchetypeDto | null) => {
    setEditing(archetype)
    setOpen(true)
  }
  const askToDelete = (archetype: ArchetypeDto) => {
    setOpen(false)
    setDeleting(archetype)
  }
  const remove = async () => {
    if (!deleting) return
    setRemoving(true)
    try {
      await api.delete(`/api/archetypes/${deleting.id}`)
      setDeleting(null)
      await mutate()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setRemoving(false)
    }
  }
  const newButton = (
    <Button size="sm" onClick={() => start(null)}>
      <Plus />
      New archetype
    </Button>
  )
  return (
    <>
      <PageHeader crumbs={[{ label: 'Archetypes' }]}>{admin ? newButton : null}</PageHeader>
      <PageBody>
        {error && !data ? (
          <ErrorState error={error} retry={() => void mutate()} />
        ) : !data ? (
          <ListSkeleton rows={4} />
        ) : data.archetypes.length === 0 ? (
          <EmptyState
            art={<ArchetypesArt />}
            title="No archetypes yet"
            action={
              admin ? (
                <Button variant="primary" onClick={() => start(null)}>
                  New archetype
                </Button>
              ) : undefined
            }
          >
            An archetype is a job description with a shared prompt. Agents are built from one.
          </EmptyState>
        ) : (
          data.archetypes.map((archetype) => (
            <button
              key={archetype.id}
              type="button"
              onClick={() => start(archetype)}
              className="flex h-13 w-full items-center gap-3 border-b border-divider px-4 text-left transition-colors duration-75 hover:bg-softer"
            >
              <Shapes className="size-4 shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{archetype.name}</span>
                <span className="block truncate text-xs text-ink-2">{archetype.description || worksAs(archetype.role)}</span>
              </span>
              <Chip tone="neutral" className="hidden sm:inline-flex">
                {worksAs(archetype.role)}
              </Chip>
              <span className="w-16 shrink-0 text-right text-xs text-ink-3">
                {archetype.agents.length === 0 ? 'No agents' : archetype.agents.length === 1 ? '1 agent' : `${archetype.agents.length} agents`}
              </span>
            </button>
          ))
        )}
      </PageBody>
      <ArchetypeDialog archetype={editing} open={open} admin={admin} onOpenChange={setOpen} onSaved={() => void mutate()} onDelete={askToDelete} />
      <Dialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
        title={`Delete ${deleting?.name ?? 'this archetype'}?`}
        description="No agents use it. This cannot be undone, but the audit log keeps its last prompt."
      >
        <DialogFooter>
          <Button size="sm" onClick={() => setDeleting(null)}>
            Keep it
          </Button>
          <Button size="sm" variant="danger" loading={removing} onClick={() => void remove()}>
            Delete archetype
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  )
}
