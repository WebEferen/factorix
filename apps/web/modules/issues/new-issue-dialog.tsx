'use client'

import type { IssueDto, IssueFieldsDto } from '@factorix/schemas'
import { ChevronDown } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'
import useSWR from 'swr'
import { api, fetcher } from '../lib/api'
import { useAgents, useProjects } from '../lib/data'
import { Button, Dialog, DialogColumns, DialogFooter, Field, Input, Menu, MenuCheckboxItem, MenuContent, MenuTrigger, Select, Textarea } from '../ui'
import { refreshIssueData } from './agent-picker'

const NO_AGENT = 'none'

export function NewIssueDialog({ open, onOpenChange, projectId }: { open: boolean; onOpenChange: (open: boolean) => void; projectId?: string }) {
  const router = useRouter()
  const { data: projects } = useProjects()
  const { data: agents } = useAgents()
  const [project, setProject] = useState<string | undefined>(projectId)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('0')
  const [labels, setLabels] = useState<string[]>([])
  const [agent, setAgent] = useState(NO_AGENT)
  const [loading, setLoading] = useState(false)
  const { data: fields } = useSWR<IssueFieldsDto>(open && project ? `/api/projects/${project}/issue-fields` : null, fetcher as never)
  const labelNames = new Map(fields?.labels.map((label) => [label.id, label.name]))

  useEffect(() => {
    if (!open) return
    setProject(projectId ?? projects?.projects[0]?.id)
    setTitle('')
    setDescription('')
    setPriority('0')
    setLabels([])
    setAgent(NO_AGENT)
  }, [open, projectId, projects])

  const pickProject = (next: string) => {
    setProject(next)
    setPriority('0')
    setLabels([])
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!project) return
    setLoading(true)
    try {
      const { issue } = await api.post<{ issue: IssueDto }>(`/api/projects/${project}/issues`, {
        title,
        description: description || undefined,
        priority: fields?.priorities.length ? Number(priority) : undefined,
        labelIds: labels.length > 0 ? labels : undefined,
        assignAgentId: agent === NO_AGENT ? null : agent,
      })
      refreshIssueData()
      onOpenChange(false)
      toast.success(`Created ${issue.identifier}`, { action: { label: 'Open', onClick: () => router.push(`/issues/${issue.id}`) } })
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
    <Dialog open={open} onOpenChange={onOpenChange} title="New issue" description="The issue is created in the project's tracker." wide>
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
                  onChange={pickProject}
                  options={projects?.projects.map((item) => ({ value: item.id, label: item.name })) ?? []}
                />
              </Field>
              {fields?.priorities.length ? (
                <Field label="Priority">
                  <Select
                    value={priority}
                    onChange={setPriority}
                    options={fields.priorities.map((item) => ({ value: String(item.value), label: item.label }))}
                  />
                </Field>
              ) : null}
              {fields?.labels.length ? (
                <Field label="Labels">
                  <Menu>
                    <MenuTrigger asChild>
                      <Button className="w-full justify-between font-normal">
                        <span className="truncate">{labels.length > 0 ? labels.map((id) => labelNames.get(id) ?? id).join(', ') : 'None'}</span>
                        <ChevronDown className="text-ink-3" />
                      </Button>
                    </MenuTrigger>
                    <MenuContent className="max-h-72 overflow-y-auto">
                      {fields.labels.map((label) => (
                        <MenuCheckboxItem
                          key={label.id}
                          checked={labels.includes(label.id)}
                          onSelect={(event) => event.preventDefault()}
                          onCheckedChange={(checked) =>
                            setLabels((current) => (checked ? [...current, label.id] : current.filter((id) => id !== label.id)))
                          }
                        >
                          {label.name}
                        </MenuCheckboxItem>
                      ))}
                    </MenuContent>
                  </Menu>
                </Field>
              ) : null}
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
