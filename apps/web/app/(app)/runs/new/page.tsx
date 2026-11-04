'use client'

import type { RunDto } from '@factorix/schemas'
import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/modules/lib/api'
import { useAgents, useConnections } from '@/modules/lib/data'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { Button, Field, Input, Select, Textarea } from '@/modules/ui'

const PUBLIC_REPO = 'public'

export default function NewRunPage() {
  const router = useRouter()
  const { data: agents } = useAgents()
  const { data: connections } = useConnections()
  const [agentId, setAgentId] = useState<string>()
  const [gitUrl, setGitUrl] = useState('')
  const [ref, setRef] = useState('')
  const [connection, setConnection] = useState(PUBLIC_REPO)
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const scm = connections?.connections.filter((item) => item.kind === 'gitlab') ?? []

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!agentId) return
    setLoading(true)
    try {
      const { run } = await api.post<{ run: RunDto }>('/api/runs', {
        agentId,
        gitUrl,
        prompt,
        ref: ref || undefined,
        scmConnectionId: connection === PUBLIC_REPO ? undefined : connection,
      })
      router.push(`/runs/${run.id}`)
    } catch (error) {
      toast.error((error as Error).message)
      setLoading(false)
    }
  }

  return (
    <>
      <PageHeader crumbs={[{ label: 'Runs', href: '/runs' }, { label: 'Ad-hoc task' }]} />
      <PageBody>
        <form onSubmit={submit} className="mx-auto flex max-w-2xl flex-col gap-4 p-4 sm:p-6">
          <div>
            <h1 className="text-xl font-semibold">Run an ad-hoc task</h1>
            <p className="mt-1 text-sm text-ink-2">
              An agent works on a sandboxed copy of the repository. Nothing is pushed. You get the transcript and the diff.
            </p>
          </div>
          <Field label="Agent">
            <Select
              value={agentId}
              onChange={setAgentId}
              placeholder="Choose an agent"
              options={
                agents?.agents
                  .filter((agent) => agent.status === 'active')
                  .map((agent) => ({ value: agent.id, label: agent.displayName, hint: `${agent.runtime}, ${agent.archetype.name}` })) ?? []
              }
            />
          </Field>
          <Field label="Repository URL">
            <Input required placeholder="https://gitlab.com/group/repo.git" value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Branch or ref" hint="Defaults to the repository's default branch.">
              <Input placeholder="main" value={ref} onChange={(event) => setRef(event.target.value)} />
            </Field>
            <Field label="Git access" hint="Which token reads the repository.">
              <Select
                value={connection}
                onChange={setConnection}
                options={[{ value: PUBLIC_REPO, label: 'Public repository' }, ...scm.map((item) => ({ value: item.id, label: item.name }))]}
              />
            </Field>
          </div>
          <Field label="What should the agent do?">
            <Textarea required className="min-h-40" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={loading} disabled={!agentId || !gitUrl.trim() || !prompt.trim()}>
              Start run
            </Button>
          </div>
        </form>
      </PageBody>
    </>
  )
}
