'use client'

import type { IssueDetailDto } from '@factorix/schemas'
import { type FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { api, fetcher } from '../lib/api'
import { Button, Dialog, DialogColumns, DialogFooter, Field, Input, Select, Textarea } from '../ui'
import { refreshIssueData } from './agent-picker'
import { PRIORITY_LABEL } from './icons'

/** Built-in tickets only. Any other tracker has its own screen for this. */
export function EditIssueDialog({ issue, open, onOpenChange }: { issue: IssueDetailDto; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { project } = issue
  const { data: states } = useSWR<{ states: { id: string; name: string }[] }>(
    open ? `/api/tracker/states?connectionId=${project.trackerConnectionId}&teamId=${project.trackerTeamId}` : null,
    fetcher as never,
  )
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('0')
  const [stateId, setStateId] = useState<string>()
  const [loading, setLoading] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: fill the form when it opens, never over what someone is typing
  useEffect(() => {
    if (!open) return
    setTitle(issue.title)
    setDescription(issue.descriptionSource ?? '')
    setPriority(String(issue.priority))
    setStateId(issue.trackerStateId ?? undefined)
  }, [open])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try {
      await api.put(`/api/issues/${issue.id}`, { title, description: description || null, priority: Number(priority), stateId })
      refreshIssueData()
      onOpenChange(false)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Edit ${issue.identifier}`} description="This ticket lives in Factorix." wide>
      <form onSubmit={submit}>
        <DialogColumns
          className="md:grid-cols-[2fr_1fr]"
          start={
            <>
              <Input required aria-label="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
              <Textarea
                placeholder="Add a description. Agents read this as the brief."
                aria-label="Description"
                className="min-h-72"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </>
          }
          end={
            <>
              <Field label="Status">
                <Select
                  value={stateId}
                  onChange={setStateId}
                  disabled={!states}
                  options={states?.states.map((state) => ({ value: state.id, label: state.name })) ?? []}
                />
              </Field>
              <Field label="Priority">
                <Select value={priority} onChange={setPriority} options={PRIORITY_LABEL.map((label, index) => ({ value: String(index), label }))} />
              </Field>
            </>
          }
        />
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={loading} disabled={!title.trim()}>
            Save
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
