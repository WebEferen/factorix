'use client'

import type { AuditEntryDto } from '@factorix/schemas'
import { useState } from 'react'
import useSWRInfinite from 'swr/infinite'
import { fetcher } from '@/modules/lib/api'
import { fullDate } from '@/modules/lib/format'
import { Avatar, Button, Chip, EmptyState, ErrorState, ListSkeleton, Select } from '@/modules/ui'
import { AuditArt } from '@/modules/ui/empty-art'

const TARGETS = [
  { value: 'all', label: 'Everything' },
  { value: 'agent', label: 'Agents' },
  { value: 'run', label: 'Runs' },
  { value: 'issue', label: 'Issues' },
  { value: 'project', label: 'Projects' },
  { value: 'connection', label: 'Connections' },
  { value: 'approval', label: 'Approvals' },
]

const PAGE = 50

export default function AuditPage() {
  const [target, setTarget] = useState('all')
  const { data, error, size, setSize, isValidating, mutate } = useSWRInfinite<{ entries: AuditEntryDto[] }>(
    (index, previous: { entries: AuditEntryDto[] } | null) => {
      if (previous && previous.entries.length < PAGE) return null
      const params = new URLSearchParams({ limit: String(PAGE) })
      if (target !== 'all') params.set('targetType', target)
      const before = previous?.entries.at(-1)?.ts
      if (index > 0 && before) params.set('before', before)
      return `/api/audit?${params}`
    },
    fetcher as never,
  )
  const entries = data?.flatMap((page) => page.entries) ?? []
  const hasMore = (data?.at(-1)?.entries.length ?? 0) === PAGE
  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Audit log</h1>
          <p className="text-sm text-ink-2">Everything people, agents, and the factory did. This log is append-only.</p>
        </div>
        <Select className="w-40" value={target} onChange={setTarget} options={TARGETS} />
      </div>
      {error && !data ? (
        <ErrorState error={error} retry={() => void mutate()} />
      ) : !data ? (
        <ListSkeleton />
      ) : entries.length === 0 ? (
        <EmptyState art={<AuditArt />} title="Nothing logged here yet" />
      ) : (
        <div className="overflow-hidden rounded-lg border border-divider">
          {entries.map((entry) => (
            <details key={entry.id} className="group border-b border-divider last:border-b-0">
              <summary className="flex h-10 cursor-pointer list-none items-center gap-2.5 px-3 text-sm transition-colors duration-75 hover:bg-softer">
                <Avatar name={entry.actorName ?? 'Factorix'} agent={entry.actorKind !== 'human'} size={18} />
                <span className="hidden w-32 shrink-0 truncate text-ink-2 sm:block">{entry.actorName ?? 'Factorix'}</span>
                {entry.actorKind === 'agent' ? <Chip className="hidden sm:inline-flex">Agent</Chip> : null}
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.action}</span>
                <span className="hidden shrink-0 text-xs text-ink-3 md:block">{entry.targetType}</span>
                <span className="shrink-0 text-xs text-ink-3">{fullDate(entry.ts)}</span>
              </summary>
              <pre className="scroll-thin overflow-x-auto border-t border-divider bg-softer p-3 font-mono text-xs">
                {JSON.stringify({ target: entry.targetId, ...entry.metadata }, null, 2)}
              </pre>
            </details>
          ))}
        </div>
      )}
      {hasMore ? (
        <div className="mt-4 flex justify-center">
          <Button loading={isValidating} onClick={() => void setSize(size + 1)}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  )
}
