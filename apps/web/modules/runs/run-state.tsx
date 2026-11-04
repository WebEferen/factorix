import type { RunStateDto } from '@factorix/schemas'
import { Loader2 } from 'lucide-react'
import { Chip } from '../ui'

const STATES: Record<RunStateDto, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; spin?: boolean }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  preparing: { label: 'Preparing', tone: 'info', spin: true },
  running: { label: 'Running', tone: 'info', spin: true },
  waiting_approval: { label: 'Needs approval', tone: 'warning' },
  suspended: { label: 'Paused', tone: 'warning' },
  finalizing: { label: 'Finishing', tone: 'info', spin: true },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

export function RunStateChip({ state }: { state: RunStateDto }) {
  const { label, tone, spin } = STATES[state]
  return (
    <Chip tone={tone}>
      {spin ? <Loader2 className="animate-spin" /> : null}
      {label}
    </Chip>
  )
}

export const ACTIVE_RUN_STATES: RunStateDto[] = ['queued', 'preparing', 'running', 'waiting_approval', 'suspended', 'finalizing']
