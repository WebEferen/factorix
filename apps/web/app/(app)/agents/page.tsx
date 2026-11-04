'use client'

import type { AgentDto } from '@factorix/schemas'
import { Plus } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback } from 'react'
import { useAgents } from '@/modules/lib/data'
import { cn, titleCase } from '@/modules/lib/format'
import { PageBody, PageHeader } from '@/modules/shell/page-header'
import { useListKeys } from '@/modules/shell/use-list-keys'
import { Avatar, Button, Chip, EmptyState, ErrorState, ListSkeleton } from '@/modules/ui'
import { AgentsArt } from '@/modules/ui/empty-art'

export default function AgentsPage() {
  const router = useRouter()
  const { data, error, mutate } = useAgents()
  const agents = data?.agents ?? []
  const open = useCallback((agent: AgentDto) => router.push(`/agents/${agent.id}`), [router])
  const { selected, setSelected } = useListKeys(agents, open)
  return (
    <>
      <PageHeader crumbs={[{ label: 'Agents' }]}>
        <Link href="/agents/new">
          <Button size="sm">
            <Plus />
            New agent
          </Button>
        </Link>
      </PageHeader>
      <PageBody>
        {error && !data ? (
          <ErrorState error={error} retry={() => void mutate()} />
        ) : !data ? (
          <ListSkeleton rows={4} />
        ) : agents.length === 0 ? (
          <EmptyState
            art={<AgentsArt />}
            title="No agents yet"
            action={
              <Link href="/agents/new">
                <Button variant="primary">New agent</Button>
              </Link>
            }
          />
        ) : (
          agents.map((agent, index) => (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}`}
              onMouseEnter={() => setSelected(index)}
              className={cn(
                'flex h-13 items-center gap-3 border-b border-divider px-4 transition-colors duration-75',
                selected === index ? 'bg-soft' : 'hover:bg-softer',
              )}
            >
              <Avatar name={agent.displayName} agent size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="truncate">{agent.displayName}</span>
                  <span className="hidden truncate text-xs text-ink-3 sm:block">{agent.handle}</span>
                </div>
                <div className="truncate text-xs text-ink-2">{agent.description || agent.archetype.name}</div>
              </div>
              {agent.activeRunCount ? <Chip tone="info">{agent.activeRunCount} running</Chip> : null}
              {agent.status === 'disabled' ? <Chip>Disabled</Chip> : null}
              <Chip tone="outline" className="hidden sm:inline-flex">
                {agent.archetype.name}
              </Chip>
              <span className="hidden w-40 truncate text-right text-xs text-ink-2 md:block">
                {titleCase(agent.runtime)}
                {agent.model ? `, ${agent.model}` : ''}
              </span>
            </Link>
          ))
        )}
      </PageBody>
    </>
  )
}
