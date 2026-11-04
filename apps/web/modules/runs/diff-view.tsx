'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '../lib/format'
import { EmptyState } from '../ui'
import { NoChangesArt } from '../ui/empty-art'

interface DiffFile {
  path: string
  added: number
  removed: number
  lines: string[]
}

function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = / b\/(.*)$/.exec(line)
      current = { path: match?.[1] ?? line, added: 0, removed: 0, lines: [] }
      files.push(current)
      continue
    }
    if (!current) continue
    if (
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('similarity') ||
      line.startsWith('rename ')
    )
      continue
    if (line.startsWith('+')) current.added += 1
    else if (line.startsWith('-')) current.removed += 1
    current.lines.push(line)
  }
  return files
}

function FileBlock({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="overflow-hidden rounded-md border border-divider">
      <button type="button" onClick={() => setOpen(!open)} className="flex h-9 w-full items-center gap-2 bg-softer px-3 text-left">
        {open ? <ChevronDown className="size-4 text-ink-3" /> : <ChevronRight className="size-4 text-ink-3" />}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
        <span className="font-mono text-xs text-success">+{file.added}</span>
        <span className="font-mono text-xs text-danger-ink">-{file.removed}</span>
      </button>
      {open ? (
        <pre className="scroll-thin overflow-x-auto border-t border-divider py-1 font-mono text-xs leading-5">
          {file.lines.map((line, index) => (
            <div
              key={index}
              className={cn(
                'min-w-max px-3 whitespace-pre',
                line.startsWith('+') && 'bg-diff-add',
                line.startsWith('-') && 'bg-diff-del',
                line.startsWith('@@') && 'text-ink-3',
              )}
            >
              {line || ' '}
            </div>
          ))}
        </pre>
      ) : null}
    </section>
  )
}

export function DiffView({ diff }: { diff: string | null | undefined }) {
  const files = useMemo(() => (diff ? parseDiff(diff) : []), [diff])
  if (files.length === 0)
    return (
      <EmptyState art={<NoChangesArt />} title="No changes to show">
        This run did not change any files, or it has not finished yet.
      </EmptyState>
    )
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-3 p-4 sm:p-6">
      {files.map((file) => (
        <FileBlock key={file.path} file={file} />
      ))}
    </div>
  )
}
