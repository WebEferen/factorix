'use client'

import { Bot, CircleDot, GitMerge, ScanSearch } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { cn } from '../lib/format'

const STAGES = [
  { icon: CircleDot, label: 'Ticket', detail: 'Assigned to an agent in your tracker' },
  { icon: Bot, label: 'Agent', detail: 'Plans and writes the change in a sandbox' },
  { icon: ScanSearch, label: 'Review', detail: 'A second agent reads the diff and CI' },
  { icon: GitMerge, label: 'Merge request', detail: 'Opened for you to approve' },
]
const STAGE_SECONDS = 2
const CYCLE = `${STAGES.length * STAGE_SECONDS}s`

const TIPS = [
  { title: 'Start from the tracker', body: 'Assign a ticket to an agent where you already work. Factorix follows it and opens the merge request.' },
  { title: 'Keys stay outside', body: 'Agents never hold your git token or model keys. They reach the network only through the egress proxy.' },
  { title: 'See it before you merge', body: 'A project can describe how to run its code, and every issue then gets a preview on its own address.' },
  { title: 'Find anything', body: 'Press ⌘K to search issues, runs, and agents, and C to create an issue from anywhere.' },
  { title: 'One install, several teams', body: 'Each organization keeps its own projects, agents, connections, and members.' },
  { title: 'Try it without a model key', body: 'Allow the scripted runtime under Settings, General to click through the whole flow first.' },
]
const TIP_MS = 7000

/** The side of the sign-in pages: a ticket's way through the factory, and one thing worth knowing at a time. */
export function Showcase() {
  const [tip, setTip] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTip((current) => (current + 1) % TIPS.length), TIP_MS)
    return () => clearInterval(timer)
  }, [])
  const shown = TIPS[tip] ?? TIPS[0]

  return (
    <div className="flex w-full flex-col justify-center gap-14 px-12 py-10 xl:px-20">
      <div aria-hidden className="flex items-stretch">
        {STAGES.map((stage, index) => (
          <Fragment key={stage.label}>
            <div
              className="flex min-w-0 flex-1 basis-0 flex-col gap-2 rounded-lg border border-divider bg-surface p-4 shadow-control motion-reduce:[animation:none]"
              style={{ animation: `fx-stage ${CYCLE} ease-in-out infinite`, animationDelay: `${index * STAGE_SECONDS}s` }}
            >
              <stage.icon className="size-5 text-signal" />
              <div className="truncate text-sm font-semibold">{stage.label}</div>
              <div className="text-xs text-ink-2">{stage.detail}</div>
            </div>
            {index < STAGES.length - 1 ? (
              <div
                className="h-0.5 w-6 shrink-0 self-center bg-divider motion-reduce:[animation:none] xl:w-10"
                style={{ animation: `fx-link ${CYCLE} ease-in-out infinite`, animationDelay: `${(index + 0.75) * STAGE_SECONDS}s` }}
              />
            ) : null}
          </Fragment>
        ))}
      </div>

      <div className="max-w-xl">
        <div className="text-xs font-semibold tracking-wide text-signal uppercase">Tip</div>
        <div key={tip} className="mt-2 min-h-24 animate-in fade-in-0 slide-in-from-bottom-1 duration-500" aria-live="polite">
          <h2 className="text-2xl font-bold">{shown?.title}</h2>
          <p className="mt-2 text-base text-ink-2">{shown?.body}</p>
        </div>
        <div className="mt-6 flex gap-1.5">
          {TIPS.map((entry, index) => (
            <button
              key={entry.title}
              type="button"
              aria-label={`Tip ${index + 1}: ${entry.title}`}
              aria-current={index === tip}
              onClick={() => setTip(index)}
              className={cn('h-1.5 rounded-full transition-all duration-300', index === tip ? 'w-6 bg-signal' : 'w-1.5 bg-field hover:bg-ink-3')}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
