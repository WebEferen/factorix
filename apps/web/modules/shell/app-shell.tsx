'use client'

import type { IssueDto } from '@factorix/schemas'
import { Command } from 'cmdk'
import { Bot, CircleDot, FolderKanban, Inbox, Moon, Play, Plus, Settings, Shapes, Sparkles, Workflow } from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { NewIssueDialog } from '../issues/new-issue-dialog'
import { ApiError, fetcher } from '../lib/api'
import { useAgents, useMe, useProjects } from '../lib/data'
import { Dialog, ErrorState, Kbd, Skeleton } from '../ui'
import { Boundary } from '../ui/boundary'
import { LiveUpdates } from './live'
import { Sidebar } from './sidebar'
import { ShellContext } from './state'
import { useTheme } from './theme'

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  return (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT' ||
    element.isContentEditable ||
    Boolean(element.closest('[role="dialog"],[role="menu"],[role="listbox"]'))
  )
}

const SHORTCUTS: [string, string[]][] = [
  ['Search and commands', ['⌘', 'K']],
  ['New issue', ['C']],
  ['Go to inbox', ['G', 'I']],
  ['Go to issues', ['G', 'L']],
  ['Go to projects', ['G', 'P']],
  ['Go to runs', ['G', 'R']],
  ['Go to workflows', ['G', 'W']],
  ['Go to agents', ['G', 'A']],
  ['Go to settings', ['G', 'S']],
  ['Move in a list', ['J', 'K']],
  ['Open the selected row', ['↵']],
  ['Show this list', ['?']],
]

function PaletteItem({
  icon,
  label,
  hint,
  onSelect,
  value,
}: {
  icon?: ReactNode
  label: string
  hint?: string
  onSelect: () => void
  value?: string
}) {
  return (
    <Command.Item
      value={value ?? label}
      onSelect={onSelect}
      className="flex h-9 cursor-default items-center gap-2.5 rounded-sm px-2 text-sm select-none data-[selected=true]:bg-soft [&_svg]:size-4 [&_svg]:text-ink-2"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? <span className="shrink-0 text-xs text-ink-3">{hint}</span> : null}
    </Command.Item>
  )
}

function Palette({ open, onOpenChange, onNewIssue }: { open: boolean; onOpenChange: (open: boolean) => void; onNewIssue: () => void }) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const { data: projects } = useProjects()
  const { data: agents } = useAgents()
  const [, toggleTheme] = useTheme()
  const { data: found } = useSWR<{ issues: IssueDto[] }>(
    open && search.trim().length > 1 ? `/api/issues?q=${encodeURIComponent(search.trim())}&limit=8` : null,
    fetcher as never,
    { keepPreviousData: true },
  )
  useEffect(() => {
    if (!open) setSearch('')
  }, [open])
  const run = (action: () => void) => {
    onOpenChange(false)
    action()
  }
  const go = (href: string) => run(() => router.push(href))
  const groupStyles =
    'px-1 pb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-ink-3'
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30 animate-in fade-in-0 duration-100" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[14vh] left-1/2 z-50 w-[calc(100vw-32px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-divider bg-surface shadow-overlay animate-in fade-in-0 zoom-in-98 duration-100"
        >
          <DialogPrimitive.Title className="sr-only">Search and commands</DialogPrimitive.Title>
          <Command loop shouldFilter>
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder="Type a command or search issues"
              className="h-11 w-full border-b border-divider bg-transparent px-4 text-base outline-none placeholder:text-ink-3"
            />
            <Command.List className="scroll-thin max-h-96 overflow-y-auto py-1">
              <Command.Empty className="px-4 py-6 text-center text-sm text-ink-2">Nothing matches that.</Command.Empty>
              {found && found.issues.length > 0 ? (
                <Command.Group heading="Issues" className={groupStyles}>
                  {found.issues.map((issue) => (
                    <PaletteItem
                      key={issue.id}
                      value={`${issue.identifier} ${issue.title} ${search}`}
                      icon={<CircleDot />}
                      label={issue.title}
                      hint={issue.identifier}
                      onSelect={() => go(`/issues/${issue.id}`)}
                    />
                  ))}
                </Command.Group>
              ) : null}
              <Command.Group heading="Actions" className={groupStyles}>
                <PaletteItem icon={<Plus />} label="New issue" hint="C" onSelect={() => run(onNewIssue)} />
                <PaletteItem icon={<Play />} label="Run an ad-hoc task" onSelect={() => go('/runs/new')} />
                <PaletteItem icon={<Bot />} label="New agent" onSelect={() => go('/agents/new')} />
                <PaletteItem icon={<FolderKanban />} label="New project" onSelect={() => go('/projects/new')} />
                <PaletteItem icon={<Moon />} label="Switch theme" onSelect={() => run(toggleTheme)} />
              </Command.Group>
              <Command.Group heading="Go to" className={groupStyles}>
                <PaletteItem icon={<Inbox />} label="Inbox" hint="G I" onSelect={() => go('/inbox')} />
                <PaletteItem icon={<CircleDot />} label="Issues" hint="G L" onSelect={() => go('/issues')} />
                <PaletteItem icon={<FolderKanban />} label="Projects" hint="G P" onSelect={() => go('/projects')} />
                <PaletteItem icon={<Play />} label="Runs" hint="G R" onSelect={() => go('/runs')} />
                <PaletteItem icon={<Workflow />} label="Workflows" hint="G W" onSelect={() => go('/workflows')} />
                <PaletteItem icon={<Bot />} label="Agents" hint="G A" onSelect={() => go('/agents')} />
                <PaletteItem icon={<Sparkles />} label="Skills" onSelect={() => go('/skills')} />
                <PaletteItem icon={<Shapes />} label="Archetypes" onSelect={() => go('/archetypes')} />
                <PaletteItem icon={<Settings />} label="Settings" hint="G S" onSelect={() => go('/settings')} />
                <PaletteItem icon={<Settings />} label="Network" onSelect={() => go('/settings/network')} />
                <PaletteItem icon={<Settings />} label="Audit log" onSelect={() => go('/settings/audit')} />
                <PaletteItem icon={<Settings />} label="Spend" onSelect={() => go('/settings/spend')} />
              </Command.Group>
              {projects && projects.projects.length > 0 ? (
                <Command.Group heading="Projects" className={groupStyles}>
                  {projects.projects.map((project) => (
                    <PaletteItem
                      key={project.id}
                      value={`project ${project.name}`}
                      icon={<FolderKanban />}
                      label={project.name}
                      onSelect={() => go(`/projects/${project.id}`)}
                    />
                  ))}
                </Command.Group>
              ) : null}
              {agents && agents.agents.length > 0 ? (
                <Command.Group heading="Agents" className={groupStyles}>
                  {agents.agents.map((agent) => (
                    <PaletteItem
                      key={agent.id}
                      value={`agent ${agent.displayName} ${agent.handle}`}
                      icon={<Bot />}
                      label={agent.displayName}
                      hint={agent.handle}
                      onSelect={() => go(`/agents/${agent.id}`)}
                    />
                  ))}
                </Command.Group>
              ) : null}
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { data: me, error, mutate: reloadMe } = useMe()
  const signedOut = error instanceof ApiError && error.status === 401
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const [newIssue, setNewIssue] = useState<{ open: boolean; projectId?: string }>({ open: false })
  const lastG = useRef(0)

  // Only a real 401 signs you out. An API restart or a dropped connection must not throw you onto the login page.
  useEffect(() => {
    if (!signedOut) return
    void fetch('/api/auth/status')
      .then((response) => response.json())
      .then((status: { setUp?: boolean }) => router.replace(status.setUp ? '/login' : '/setup'))
      .catch(() => router.replace('/login'))
  }, [signedOut, router])

  const openNewIssue = useCallback((projectId?: string) => setNewIssue({ open: true, projectId }), [])

  useEffect(() => {
    const destinations: Record<string, string> = {
      i: '/inbox',
      l: '/issues',
      p: '/projects',
      r: '/runs',
      w: '/workflows',
      a: '/agents',
      s: '/settings',
    }
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
      const key = event.key.toLowerCase()
      if (Date.now() - lastG.current < 900) {
        lastG.current = 0
        const destination = destinations[key]
        if (destination) {
          event.preventDefault()
          router.push(destination)
        }
        return
      }
      if (key === 'g') lastG.current = Date.now()
      else if (key === 'c') {
        event.preventDefault()
        openNewIssue()
      } else if (event.key === '?') setShortcutsOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openNewIssue, router])

  const actions = useMemo(
    () => ({ openPalette: () => setPaletteOpen(true), openNewIssue, openShortcuts: () => setShortcutsOpen(true), openNav: () => setNavOpen(true) }),
    [openNewIssue],
  )

  if (!me && error && !signedOut) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <ErrorState error={error} retry={() => void reloadMe()} />
      </div>
    )
  }

  if (!me) {
    return (
      <div className="flex h-dvh">
        <div className="hidden w-56 flex-col gap-2 border-r border-divider bg-softer p-3 md:flex">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="mt-3 h-5" />
          <Skeleton className="h-5" />
          <Skeleton className="h-5" />
        </div>
        <div className="flex-1" />
      </div>
    )
  }

  return (
    <ShellContext.Provider value={actions}>
      <LiveUpdates>
        <div className="flex h-dvh overflow-hidden">
          <aside className="hidden w-56 shrink-0 border-r border-divider md:block">
            <Boundary label="the navigation" resetKey={pathname}>
              <Sidebar me={me} />
            </Boundary>
          </aside>
          <DialogPrimitive.Root open={navOpen} onOpenChange={setNavOpen}>
            <DialogPrimitive.Portal>
              <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30 md:hidden" />
              <DialogPrimitive.Content
                aria-describedby={undefined}
                className="fixed inset-y-0 left-0 z-50 w-64 border-r border-divider shadow-overlay animate-in slide-in-from-left duration-200 md:hidden"
              >
                <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
                <Boundary label="the navigation" resetKey={pathname}>
                  <Sidebar me={me} onNavigate={() => setNavOpen(false)} />
                </Boundary>
              </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
          </DialogPrimitive.Root>
          <main className="flex min-w-0 flex-1 flex-col bg-surface">{children}</main>
        </div>
        <Boundary label="search" fallback={null} resetKey={paletteOpen}>
          <Palette open={paletteOpen} onOpenChange={setPaletteOpen} onNewIssue={() => openNewIssue()} />
        </Boundary>
        <Boundary label="the new issue form" fallback={null} resetKey={newIssue.open}>
          <NewIssueDialog
            open={newIssue.open}
            projectId={newIssue.projectId}
            onOpenChange={(open) => setNewIssue((current) => ({ ...current, open }))}
          />
        </Boundary>
        <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} title="Keyboard shortcuts">
          <ul className="divide-y divide-divider">
            {SHORTCUTS.map(([label, keys]) => (
              <li key={label} className="flex items-center justify-between py-2 text-sm">
                {label}
                <span className="flex gap-1">
                  {keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </Dialog>
      </LiveUpdates>
    </ShellContext.Provider>
  )
}
