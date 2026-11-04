import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values))
}

const UNITS: [number, string][] = [
  [60, 's'],
  [3600, 'm'],
  [86_400, 'h'],
  [2_592_000, 'd'],
  [31_536_000, 'mo'],
]

export function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return ''
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000)
  if (seconds < 30) return 'now'
  let divisor = 1
  for (const [limit, unit] of UNITS) {
    if (seconds < limit) return `${Math.floor(seconds / divisor)}${unit}`
    divisor = limit
  }
  return `${Math.floor(seconds / 31_536_000)}y`
}

export function fullDate(value: string | Date | null | undefined): string {
  return value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''
}

export function duration(from: string | null | undefined, to: string | null | undefined): string {
  if (!from) return ''
  const seconds = Math.max(0, Math.round(((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

export function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return ''
  if (value > 0 && value < 0.01) return '<$0.01'
  return `$${value.toFixed(2)}`
}

export function compactNumber(value: number | null | undefined): string {
  if (!value) return '0'
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s-]+/)
  return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase() || '?'
}

const STEP_LABEL: Record<string, string> = {
  approve_plan: 'Plan approval',
  address: 'Address review',
  await_merge: 'Awaiting merge',
  fail: 'Failed',
  cancel: 'Cancelled',
}

export function stepLabel(step: string): string {
  return STEP_LABEL[step] ?? titleCase(step)
}

export function worksAs(role: string): string {
  return role === 'other' ? 'Other' : `Works as ${titleCase(role)}`
}

export function titleCase(value: string): string {
  const spaced = value.replace(/[_.-]+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
