'use client'

import type { PreviewDto, PreviewLogDto, PreviewOpenDto, PreviewServiceDto, PreviewState } from '@factorix/schemas'
import {
  CircleAlert,
  Database,
  Eraser,
  ExternalLink,
  GitCommitHorizontal,
  Loader2,
  MonitorPlay,
  Play,
  RefreshCw,
  RotateCw,
  Square,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/modules/lib/api'
import { usePreview } from '@/modules/lib/data'
import { cn, fullDate, timeAgo } from '@/modules/lib/format'
import { Button, Chip, Input, SectionTitle, Tooltip } from '@/modules/ui'
import { Markdown } from '@/modules/ui/markdown'

const STATES: Record<PreviewState, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; spin?: boolean }> = {
  starting: { label: 'Starting', tone: 'info', spin: true },
  ready: { label: 'Ready', tone: 'success' },
  refreshing: { label: 'Refreshing', tone: 'info', spin: true },
  stopping: { label: 'Stopping', tone: 'neutral', spin: true },
  stopped: { label: 'Stopped', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
}

const SERVICE_DOT: Record<PreviewServiceDto['state'], string> = {
  waiting: 'bg-ink-3/40',
  starting: 'bg-signal animate-pulse',
  ready: 'bg-success',
  failed: 'bg-danger',
  stopped: 'bg-ink-3/40',
}

const MAX_LINES = 2000

function timeUntil(value: string): string {
  const minutes = Math.max(0, Math.round((new Date(value).getTime() - Date.now()) / 60_000))
  if (minutes < 1) return 'in a moment'
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
}

/** The ticket in the URL works once, so every load of the frame or a new tab asks for a fresh one. */
async function ticketUrl(issueId: string, path: string): Promise<string> {
  return (await api.post<PreviewOpenDto>(`/api/issues/${issueId}/preview/open`, path === '/' ? {} : { path })).url
}

export async function openPreviewTab(issueId: string, path = '/'): Promise<void> {
  // Opened inside the click, so popup blockers allow it, then pointed at the ticket once it arrives.
  const tab = window.open('', '_blank')
  try {
    const url = await ticketUrl(issueId, path)
    if (tab) {
      tab.opener = null
      tab.location.href = url
    } else window.location.href = url
  } catch (error) {
    tab?.close()
    toast.error((error as Error).message)
  }
}

function PreviewLogs({ issueId, services, live }: { issueId: string; services: string[]; live: boolean }) {
  const [lines, setLines] = useState<PreviewLogDto[]>([])
  const [filter, setFilter] = useState<string>('all')
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    setLines([])
    const source = new EventSource(`/api/issues/${issueId}/preview/logs`)
    source.onmessage = (message) => {
      const entries = JSON.parse(message.data) as PreviewLogDto[]
      setLines((current) => [...current, ...entries].slice(-MAX_LINES))
    }
    return () => source.close()
  }, [issueId])

  const shown = filter === 'all' ? lines : lines.filter((line) => line.service === filter)
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when new lines arrive
  useEffect(() => {
    if (pinned.current && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [shown.length])

  const names = ['all', 'factorix', ...services, ...(lines.some((line) => line.service === 'egress-proxy') ? ['egress-proxy'] : [])]
  return (
    <div className="overflow-hidden rounded-md border border-divider">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-divider bg-softer px-2 py-1">
        {names.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setFilter(name)}
            className={cn(
              'h-6 shrink-0 rounded px-2 text-xs transition-colors duration-75',
              filter === name ? 'bg-surface text-ink shadow-control' : 'text-ink-2 hover:text-ink',
            )}
          >
            {name === 'all' ? 'All' : name}
          </button>
        ))}
        {live ? <span className="ml-auto shrink-0 pl-2 text-xs text-ink-3">Live</span> : null}
      </div>
      <div
        ref={box}
        role="log"
        aria-label="Preview log"
        onScroll={(event) => {
          const element = event.currentTarget
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
        }}
        className="h-64 overflow-y-auto bg-surface px-3 py-2 font-mono text-xs leading-5"
      >
        {shown.length === 0 ? <p className="text-ink-3">Nothing logged yet.</p> : null}
        {shown.map((line, index) => (
          <div key={`${line.seq}-${index}`} className={cn('flex gap-3 whitespace-pre-wrap break-all', line.error ? 'text-danger-ink' : 'text-ink')}>
            {filter === 'all' ? <span className="w-20 shrink-0 truncate text-ink-3">{line.service}</span> : null}
            <span className="min-w-0 flex-1">{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PreviewFrame({ issueId, url }: { issueId: string; url: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [path, setPath] = useState('/')
  const [loading, setLoading] = useState(false)

  const load = async (target: string) => {
    setLoading(true)
    try {
      setSrc(await ticketUrl(issueId, target))
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-md border border-divider bg-surface">
      <form
        className="flex items-center gap-1.5 border-b border-divider bg-softer px-2 py-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          const target = path.startsWith('/') ? path : `/${path}`
          setPath(target)
          void load(target)
        }}
      >
        <span className="hidden shrink-0 font-mono text-xs text-ink-3 sm:block">{new URL(url).host}</span>
        <Input
          aria-label="Path in the preview"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          className="h-7 min-w-0 flex-1 font-mono text-xs"
        />
        <Tooltip label="Reload">
          <Button size="icon" variant="ghost" aria-label="Reload" disabled={!src} onClick={() => void load(path)}>
            <RotateCw />
          </Button>
        </Tooltip>
        <Tooltip label="Open in a new tab">
          <Button size="icon" variant="ghost" aria-label="Open in a new tab" onClick={() => void openPreviewTab(issueId, path)}>
            <ExternalLink />
          </Button>
        </Tooltip>
      </form>
      <div className="relative aspect-[16/10] min-h-80 w-full">
        {src ? (
          <iframe
            title="Preview"
            src={src}
            className="absolute inset-0 size-full bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-2 text-center">
              <Button onClick={() => void load(path)} loading={loading}>
                <MonitorPlay />
                Show the preview here
              </Button>
              <p className="max-w-xs text-xs text-ink-3">It signs you in to this preview only. Your Factorix session stays on Factorix.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function PreviewPanel({ issueId }: { issueId: string }) {
  const { data, mutate } = usePreview(issueId)
  const [busy, setBusy] = useState<string | null>(null)
  const [logsOpen, setLogsOpen] = useState(false)
  const preview = data?.preview
  const services = useMemo(() => preview?.services.map((service) => service.name) ?? [], [preview?.services])

  if (!preview) return null
  if (preview.state === null && preview.unavailable?.includes('no environment')) return null

  const act = async (action: 'start' | 'refresh' | 'reset' | 'stop', message: string) => {
    setBusy(action)
    try {
      const result = await api.post<{ preview: PreviewDto }>(`/api/issues/${issueId}/preview/${action}`)
      void mutate(result, { revalidate: false })
      toast.success(message)
      if (action !== 'stop') setLogsOpen(true)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const state = preview.state
  const running = state === 'starting' || state === 'ready' || state === 'refreshing'
  const transitional = state === 'starting' || state === 'refreshing' || state === 'stopping'
  const chip = state ? STATES[state] : null
  const outdated = running && preview.definitionVersion !== null && preview.currentVersion !== preview.definitionVersion

  return (
    <section>
      <SectionTitle
        action={
          chip ? (
            <Chip tone={chip.tone}>
              {chip.spin ? <Loader2 className="animate-spin" /> : null}
              {chip.label}
            </Chip>
          ) : null
        }
      >
        Preview
      </SectionTitle>
      <div className="flex flex-col gap-3">
        {preview.unavailable && !running ? <p className="text-sm text-ink-3">{preview.unavailable}</p> : null}
        {state === 'failed' && preview.error ? (
          <div role="alert" className="flex gap-2 rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger-ink" />
            <p className="min-w-0 break-words">{preview.error}</p>
          </div>
        ) : null}
        {outdated ? (
          <p className="text-sm text-ink-2">
            The project’s environment changed after this preview started. Stop and start it to use the new version.
          </p>
        ) : null}

        {state === 'ready' && preview.url ? <PreviewFrame issueId={issueId} url={preview.url} /> : null}

        {running || state === 'stopping' ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
            {preview.services.map((service) => (
              <li key={service.name} className="flex items-center gap-1.5 text-sm">
                <span className={cn('size-2 rounded-full', SERVICE_DOT[service.state])} aria-hidden />
                <span>{service.name}</span>
                <span className="text-ink-3">{service.state === 'ready' ? '' : service.state}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {state === null || state === 'stopped' || state === 'failed' ? (
            <Button
              size="sm"
              variant="primary"
              disabled={Boolean(preview.unavailable)}
              loading={busy === 'start'}
              onClick={() => void act('start', 'Starting the preview')}
            >
              <Play />
              {state === 'failed' ? 'Start again' : 'Start preview'}
            </Button>
          ) : null}
          {state === 'ready' ? (
            <>
              <Button size="sm" variant="primary" onClick={() => void openPreviewTab(issueId)}>
                <ExternalLink />
                Open
              </Button>
              <Button size="sm" loading={busy === 'refresh'} onClick={() => void act('refresh', 'Fetching the latest code')}>
                <RefreshCw />
                Refresh
              </Button>
            </>
          ) : null}
          {state === 'ready' || state === 'stopped' || state === 'failed' ? (
            <Tooltip label="Deletes the preview’s databases and runs setup again">
              <Button size="sm" variant="ghost" loading={busy === 'reset'} onClick={() => void act('reset', 'Clearing data and starting again')}>
                <Eraser />
                Reset data
              </Button>
            </Tooltip>
          ) : null}
          {running ? (
            <Button size="sm" variant="danger" loading={busy === 'stop'} onClick={() => void act('stop', 'Stopping the preview')}>
              <Square />
              Stop
            </Button>
          ) : null}
          {state !== null ? (
            <Button size="sm" variant="ghost" className="ml-auto" aria-expanded={logsOpen || transitional} onClick={() => setLogsOpen(!logsOpen)}>
              {logsOpen || transitional ? 'Hide logs' : 'Logs'}
            </Button>
          ) : null}
        </div>

        {state !== null && (logsOpen || transitional) ? <PreviewLogs issueId={issueId} services={services} live={running || transitional} /> : null}

        {preview.commits.length > 0 || preview.startedAt ? (
          <div className="flex flex-col gap-1 text-xs text-ink-2">
            {preview.commits.map((commit) => (
              <span key={commit.repo} className="flex items-center gap-1.5">
                <GitCommitHorizontal className="size-3.5 text-ink-3" />
                {preview.commits.length > 1 ? <span>{commit.repo}</span> : null}
                <span className="font-mono">{commit.ref}</span>
                <span className="font-mono text-ink-3">{commit.sha.slice(0, 8)}</span>
              </span>
            ))}
            {preview.source === 'worktree' ? (
              <span className="flex items-center gap-1.5">
                <CircleAlert className="size-3.5 text-ink-3" />
                An agent's working copy, not pushed yet. Refresh switches to the pushed branch.
              </span>
            ) : null}
            {preview.startedAt ? (
              <span className="flex items-center gap-1.5" title={fullDate(preview.startedAt)}>
                <Database className="size-3.5 text-ink-3" />
                Started {timeAgo(preview.startedAt) === 'now' ? 'just now' : `${timeAgo(preview.startedAt)} ago`}
                {preview.startedBy ? ` by ${preview.startedBy.name}` : ''}
                {state === 'ready' && preview.stopsAt ? `, stops by itself ${timeUntil(preview.stopsAt)}` : ''}
              </span>
            ) : null}
          </div>
        ) : null}

        {preview.notes && running ? <Markdown text={preview.notes} className="text-sm text-ink-2" /> : null}
      </div>
    </section>
  )
}

/** A shortcut in the issue header once the preview is ready. */
export function PreviewHeaderButton({ issueId }: { issueId: string }) {
  const { data } = usePreview(issueId)
  if (data?.preview.state !== 'ready') return null
  return (
    <Button size="sm" onClick={() => void openPreviewTab(issueId)}>
      <ExternalLink />
      Preview
    </Button>
  )
}
