'use client'

import type { AuditEntryDto } from '@factorix/schemas'
import Link from 'next/link'
import { use } from 'react'
import useSWR from 'swr'
import { AgentForm } from '@/modules/agents/agent-form'
import { fetcher } from '@/modules/lib/api'
import { useAgent, useRuns } from '@/modules/lib/data'
import { money, timeAgo, titleCase } from '@/modules/lib/format'
import { RunStateChip } from '@/modules/runs/run-state'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { Avatar, Chip, ErrorState, ListSkeleton, SectionTitle } from '@/modules/ui'

export default function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { data, error, mutate } = useAgent(id)
  const { data: runs } = useRuns({ agentId: id, limit: '12' })
  const { data: audit } = useSWR<{ entries: AuditEntryDto[] }>(`/api/audit?actorId=${id}&limit=15`, fetcher as never)
  const agent = data?.agent
  if (error && !data)
    return (
      <>
        <PageHeader crumbs={[{ label: 'Agents', href: '/agents' }]} />
        <ErrorState error={error} retry={() => void mutate()} />
      </>
    )
  if (!agent)
    return (
      <>
        <PageHeader crumbs={[{ label: 'Agents', href: '/agents' }]} />
        <ListSkeleton rows={6} />
      </>
    )
  return (
    <>
      <PageHeader crumbs={[{ label: 'Agents', href: '/agents' }, { label: agent.displayName }]}>
        <Chip tone="outline">Version {agent.version}</Chip>
      </PageHeader>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <PageBody className="lg:border-r lg:border-divider">
          <div className="mx-auto max-w-2xl p-4 sm:p-6">
            <div className="mb-6 flex items-center gap-3">
              <Avatar name={agent.displayName} agent size={40} />
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold">{agent.displayName}</h1>
                <p className="truncate text-sm text-ink-2">
                  {agent.handle}, {agent.archetype.name}
                </p>
              </div>
            </div>
            <AgentForm key={agent.version} agent={agent} />
          </div>
        </PageBody>
        <aside className="scroll-thin hidden w-80 shrink-0 overflow-y-auto p-4 lg:block">
          <SectionTitle>Recent runs</SectionTitle>
          {runs?.runs.length ? (
            <div className="mb-6 flex flex-col">
              {runs.runs.map((run) => (
                <Link
                  key={run.id}
                  href={`/runs/${run.id}`}
                  className="flex flex-col gap-1 rounded-md px-2 py-1.5 transition-colors duration-75 hover:bg-soft"
                >
                  <span className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {run.issueIdentifier ?? 'Ad-hoc'} {titleCase(run.phase)}
                    </span>
                    <RunStateChip state={run.state} />
                  </span>
                  <span className="text-xs text-ink-3">
                    {timeAgo(run.createdAt)} ago{run.costUsd ? `, ${run.costEstimated ? 'est. ' : ''}${money(run.costUsd)}` : ''}
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="mb-6 px-2 text-sm text-ink-3">No runs yet.</p>
          )}
          <SectionTitle>Audit trail</SectionTitle>
          {audit?.entries.length ? (
            <ol className="flex flex-col gap-1.5 px-2">
              {audit.entries.map((entry) => (
                <li key={entry.id} className="flex justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate text-ink-2">{entry.action}</span>
                  <span className="shrink-0 text-ink-3">{timeAgo(entry.ts)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="px-2 text-sm text-ink-3">Nothing yet.</p>
          )}
        </aside>
      </div>
    </>
  )
}
