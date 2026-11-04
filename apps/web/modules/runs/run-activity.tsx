'use client'

import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileEdit,
  FilePlus,
  FileText,
  FileX,
  Globe,
  Loader2,
  Plug,
  Search,
  ShieldCheck,
  ShieldX,
  Terminal,
  Users,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/format'
import { Markdown } from '../ui/markdown'
import type { StreamItem } from './use-run-stream'

const CATEGORY_ICON: Record<string, React.ReactNode> = {
  read: <FileText />,
  search: <Search />,
  edit: <FileEdit />,
  exec: <Terminal />,
  mcp: <Plug />,
  web: <Globe />,
  subagent: <Users />,
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function ToolRow({ item }: { item: Extract<StreamItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const failed = item.isError || (item.exitCode !== undefined && item.exitCode !== 0)
  const input = asText(item.input)
  return (
    <div className="rounded-md">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors duration-75 hover:bg-soft"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-ink-3 transition-transform duration-100', open && 'rotate-90')} />
        <span className="shrink-0 text-ink-2 [&_svg]:size-4">{CATEGORY_ICON[item.category] ?? <Terminal />}</span>
        <span className="shrink-0 text-ink-2">{item.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {item.summary.startsWith(`${item.tool} `) ? item.summary.slice(item.tool.length + 1) : item.summary}
        </span>
        {item.done ? (
          failed ? (
            <CircleAlert className="size-4 shrink-0 text-danger" />
          ) : (
            <CheckCircle2 className="size-4 shrink-0 text-ink-3" />
          )
        ) : (
          <Loader2 className="size-4 shrink-0 animate-spin text-signal" />
        )}
      </button>
      {open ? (
        <div className="mt-1 mb-2 ml-7 flex flex-col gap-2">
          {input ? (
            <pre className="scroll-thin max-h-72 overflow-auto rounded-md bg-soft p-2 font-mono text-xs whitespace-pre-wrap">{input}</pre>
          ) : null}
          {item.output !== undefined ? (
            <div>
              <div className="mb-1 text-xs text-ink-2">
                Output{item.exitCode !== undefined ? `, exit code ${item.exitCode}` : ''}
                {item.truncated ? ', truncated' : ''}
              </div>
              <pre
                className={cn(
                  'scroll-thin max-h-96 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap',
                  failed ? 'bg-danger-soft' : 'bg-soft',
                )}
              >
                {item.output || '(no output)'}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function Item({ item, showLogs }: { item: StreamItem; showLogs: boolean }) {
  switch (item.kind) {
    case 'message':
      return (
        <div className={cn('px-2 py-1.5', item.role === 'user' && 'rounded-md bg-soft')}>
          <Markdown text={item.text} />
        </div>
      )
    case 'thinking':
      return <p className="px-2 py-1 text-sm whitespace-pre-wrap text-ink-3 italic">{item.text}</p>
    case 'tool':
      return <ToolRow item={item} />
    case 'file': {
      const Icon = item.change === 'add' ? FilePlus : item.change === 'delete' ? FileX : FileEdit
      return (
        <div className="flex h-7 items-center gap-2 px-2 pl-7.5 text-sm text-ink-2">
          <Icon className="size-4 shrink-0" />
          <span className="min-w-0 truncate font-mono text-xs">{item.path}</span>
        </div>
      )
    }
    case 'approval':
      return (
        <div className="flex min-h-8 items-center gap-2 px-2 text-sm">
          {item.resolved === 'reject' ? (
            <ShieldX className="size-4 shrink-0 text-danger" />
          ) : (
            <ShieldCheck className={cn('size-4 shrink-0', item.resolved ? 'text-success' : 'text-warning')} />
          )}
          <span className="min-w-0 flex-1">{item.summary}</span>
          <span className="text-xs text-ink-2">
            {item.resolved === 'reject' ? 'rejected' : item.resolved === 'approve' ? 'approved' : 'waiting for a person'}
          </span>
        </div>
      )
    case 'log':
      if (item.level === 'warn' && item.source === 'egress-proxy') {
        return (
          <div className="flex min-h-7 items-center gap-2 rounded-md bg-warning-soft px-2 py-1 text-sm text-warning-ink">
            <ShieldX className="size-4 shrink-0" />
            {item.message}
          </div>
        )
      }
      if (!showLogs && (item.level === 'debug' || item.level === 'info')) return null
      return (
        <div
          className={cn(
            'px-2 font-mono text-xs break-words whitespace-pre-wrap',
            item.level === 'error' ? 'text-danger-ink' : item.level === 'warn' ? 'text-warning-ink' : 'text-ink-3',
          )}
        >
          {item.source ? `${item.source}: ` : ''}
          {item.message}
        </div>
      )
    case 'error':
      return (
        <div className="flex items-start gap-2 rounded-md bg-danger-soft px-2 py-1.5 text-sm text-danger-ink">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{item.message}</span>
        </div>
      )
    case 'done':
      return <div className="mt-2 border-t border-divider px-2 pt-3 text-sm text-ink-2">Agent finished: {item.outcome.replace(/_/g, ' ')}</div>
  }
}

export function RunActivity({ items, showLogs, live }: { items: StreamItem[]; showLogs: boolean; live: boolean }) {
  const end = useRef<HTMLDivElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: new items are the trigger for following the stream
  useEffect(() => {
    if (stick.current) end.current?.scrollIntoView({ block: 'end' })
  }, [items])
  return (
    <div
      ref={container}
      onScroll={(event) => {
        const element = event.currentTarget
        stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
      }}
      className="scroll-thin min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-0.5 p-3 sm:p-5">
        {items.map((item) => (
          <Item key={item.key} item={item} showLogs={showLogs} />
        ))}
        {live ? (
          <div className="flex h-8 items-center gap-2 px-2 text-sm text-ink-3">
            <Loader2 className="size-4 animate-spin" />
            Working
          </div>
        ) : null}
        <div ref={end} />
      </div>
    </div>
  )
}
