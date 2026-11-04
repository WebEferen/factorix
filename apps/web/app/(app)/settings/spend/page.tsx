'use client'

import type { SpendDto, SpendRowDto } from '@factorix/schemas'
import useSWR from 'swr'
import { fetcher } from '@/modules/lib/api'
import { compactNumber, money } from '@/modules/lib/format'
import { Avatar, ErrorState, ListSkeleton, SectionTitle } from '@/modules/ui'

function Rows({ rows, agent }: { rows: SpendRowDto[]; agent?: boolean }) {
  const top = Math.max(...rows.map((row) => row.costUsd), 0.01)
  if (rows.length === 0) return <p className="text-sm text-ink-3">No spend yet.</p>
  return (
    <div className="overflow-hidden rounded-lg border border-divider">
      {rows.map((row) => (
        <div key={row.key} className="flex h-12 items-center gap-3 border-b border-divider px-3 last:border-b-0">
          {agent ? <Avatar name={row.label} agent size={20} /> : null}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{row.label}</div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-soft">
              <div className="h-full rounded-full bg-signal" style={{ width: `${(row.costUsd / top) * 100}%` }} />
            </div>
          </div>
          <span className="hidden w-16 text-right text-xs text-ink-2 sm:block">{row.runs === 1 ? '1 run' : `${row.runs} runs`}</span>
          <span className="hidden w-28 text-right text-xs text-ink-2 md:block">
            {compactNumber(row.inputTokens)} in, {compactNumber(row.outputTokens)} out
          </span>
          <span className="w-20 text-right text-sm">
            {money(row.costUsd)}
            {row.estimatedCostUsd > 0 ? <span className="block text-xs text-ink-3">{money(row.estimatedCostUsd)} est.</span> : null}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function SpendPage() {
  const { data, error, mutate } = useSWR<SpendDto>('/api/spend', fetcher as never)
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <h1 className="text-xl font-semibold">Spend</h1>
      <p className="mb-4 text-sm text-ink-2">Model cost this month. Runtimes that only report tokens are estimated from the price table.</p>
      {error && !data ? (
        <ErrorState error={error} retry={() => void mutate()} />
      ) : !data ? (
        <ListSkeleton rows={4} />
      ) : (
        <div className="flex flex-col gap-6">
          <div>
            <div className="text-2xl font-bold">{money(data.totalUsd)}</div>
            <div className="text-xs text-ink-2">since {new Date(data.from).toLocaleDateString(undefined, { dateStyle: 'medium' })}</div>
          </div>
          <section>
            <SectionTitle>By agent</SectionTitle>
            <Rows rows={data.byAgent} agent />
          </section>
          <section>
            <SectionTitle>By project</SectionTitle>
            <Rows rows={data.byProject} />
          </section>
        </div>
      )}
    </div>
  )
}
