'use client'

import type { IssueDto } from '@factorix/schemas'
import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { useAgents, useProjects } from '../lib/data'
import { Button, Dialog, DialogColumns, DialogFooter, Field, Input, Select, Textarea } from '../ui'
import { refreshIssueData } from './agent-picker'
import { PRIORITY_LABEL } from './icons'

const NO_AGENT = 'none'

export function NewIssueDialog({ open, onOpenChange, projectId }: { open: boolean; onOpenChange: (open: boolean) => void; projectId?: string }) {
  const router = useRouter()
  const { data: projects } = useProjects()
  const { data: agents } = useAgents()
  const [project, setProject] = useState<string | undefined>(projectId)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('0')
  const [agent, setAgent] = useState(NO_AGENT)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setProject(projectId ?? projects?.projects[0]?.id)
    setTitle('')
    setDescription('')
    setPriority('0')
    setAgent(NO_AGENT)
  }, [open, projectId, projects])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!project) return
    setLoading(true)
    try {
      const { issue } = await api.post<{ issue: IssueDto }>(`/api/projects/${project}/issues`, {
        title,
        description: description || undefined,
        priority: Number(priority),
        assignAgentId: agent === NO_AGENT ? null : agent,
      })
      refreshIssueData()
      onOpenChange(false)
      toast.success(`Created ${issue.identifier} in the tracker`, { action: { label: 'Open', onClick: () => router.push(`/issues/${issue.id}`) } })
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setLoading(false)
    }
  }

  if (projects && projects.projects.length === 0) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange} title="New issue" description="Issues live in a project, and there are none yet.">
        <Button
          variant="primary"
          onClick={() => {
            onOpenChange(false)
            router.push('/projects/new')
          }}
        >
          Create a project
        </Button>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New issue" description="The issue is created in your tracker and mirrored here." wide>
      <form onSubmit={submit}>
        <DialogColumns
          className="md:grid-cols-[2fr_1fr]"
          start={
            <>
              <Input
                autoFocus
                required
                placeholder="Issue title"
                aria-label="Title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
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
              <Field label="Project">
                <Select
                  value={project}
                  onChange={setProject}
                  options={projects?.projects.map((item) => ({ value: item.id, label: item.name })) ?? []}
                />
              </Field>
              <Field label="Priority">
                <Select value={priority} onChange={setPriority} options={PRIORITY_LABEL.map((label, index) => ({ value: String(index), label }))} />
              </Field>
              <Field label="Agent">
                <Select
                  value={agent}
                  onChange={setAgent}
                  options={[
                    { value: NO_AGENT, label: 'Nobody yet' },
                    ...(agents?.agents.filter((item) => item.status === 'active').map((item) => ({ value: item.id, label: item.displayName })) ?? []),
                  ]}
                />
              </Field>
            </>
          }
        />
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={loading} disabled={!title.trim() || !project}>
            Create issue
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
