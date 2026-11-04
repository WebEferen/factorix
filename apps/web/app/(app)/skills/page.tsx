'use client'

import type { SkillDto } from '@factorix/schemas'
import { Plus, Sparkles } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/modules/lib/api'
import { useSkills } from '@/modules/lib/data'
import { timeAgo } from '@/modules/lib/format'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { Button, Dialog, DialogColumns, DialogFooter, EmptyState, ErrorState, Field, Input, ListSkeleton, Textarea } from '@/modules/ui'
import { SkillsArt } from '@/modules/ui/empty-art'

function SkillDialog({
  skill,
  open,
  onOpenChange,
  onSaved,
}: {
  skill: SkillDto | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [form, setForm] = useState({ name: '', slug: '', markdown: '' })
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (open) setForm({ name: skill?.name ?? '', slug: skill?.slug ?? '', markdown: skill?.markdown ?? '' })
  }, [open, skill])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try {
      if (skill) await api.put(`/api/skills/${skill.id}`, form)
      else await api.post('/api/skills', form)
      onSaved()
      onOpenChange(false)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setLoading(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={skill ? skill.name : 'New skill'}
      description="Agents with this skill read it as part of their system prompt."
      wide
    >
      <form onSubmit={submit}>
        <DialogColumns
          className="md:grid-cols-[1fr_2fr]"
          start={
            <>
              <Field label="Name">
                <Input required autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
              </Field>
              <Field label="Slug">
                <Input
                  required
                  pattern="[a-z0-9][a-z0-9\-]*"
                  value={form.slug}
                  onChange={(event) => setForm({ ...form, slug: event.target.value })}
                />
              </Field>
            </>
          }
          end={
            <Field label="Instructions">
              <Textarea
                required
                className="min-h-96 font-mono text-xs"
                value={form.markdown}
                onChange={(event) => setForm({ ...form, markdown: event.target.value })}
              />
            </Field>
          }
        />
        <DialogFooter>
          <Button type="submit" variant="primary" loading={loading}>
            {skill ? 'Save changes' : 'Create skill'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

export default function SkillsPage() {
  const { data, error, mutate } = useSkills()
  const [editing, setEditing] = useState<SkillDto | null>(null)
  const [open, setOpen] = useState(false)
  const start = (skill: SkillDto | null) => {
    setEditing(skill)
    setOpen(true)
  }
  return (
    <>
      <PageHeader crumbs={[{ label: 'Skills' }]}>
        <Button size="sm" onClick={() => start(null)}>
          <Plus />
          New skill
        </Button>
      </PageHeader>
      <PageBody>
        {error && !data ? (
          <ErrorState error={error} retry={() => void mutate()} />
        ) : !data ? (
          <ListSkeleton rows={3} />
        ) : data.skills.length === 0 ? (
          <EmptyState
            art={<SkillsArt />}
            title="No skills yet"
            action={
              <Button variant="primary" onClick={() => start(null)}>
                New skill
              </Button>
            }
          >
            A skill is a set of instructions several agents can share.
          </EmptyState>
        ) : (
          data.skills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              onClick={() => start(skill)}
              className="flex h-13 w-full items-center gap-3 border-b border-divider px-4 text-left transition-colors duration-75 hover:bg-softer"
            >
              <Sparkles className="size-4 shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{skill.name}</span>
                <span className="block truncate text-xs text-ink-2">
                  {skill.markdown.split('\n').find((line) => line.trim() && !line.startsWith('#')) ?? skill.slug}
                </span>
              </span>
              <span className="text-xs text-ink-3">{timeAgo(skill.updatedAt)}</span>
            </button>
          ))
        )}
      </PageBody>
      <SkillDialog skill={editing} open={open} onOpenChange={setOpen} onSaved={() => void mutate()} />
    </>
  )
}
