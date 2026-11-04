'use client'

import type { MeDto } from '@factorix/schemas'
import {
  ChevronsUpDown,
  CircleDot,
  FolderKanban,
  Inbox,
  Keyboard,
  Loader2,
  LogOut,
  Moon,
  Play,
  Plus,
  Search,
  Settings,
  Shapes,
  Sparkles,
  Sun,
  Workflow,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { api } from '../lib/api'
import { useInbox, useProjects } from '../lib/data'
import { cn } from '../lib/format'
import { Avatar, Button, Kbd, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Skeleton, Tooltip } from '../ui'
import { useShell } from './state'
import { useTheme } from './theme'

function NavGroup({
  label,
  href,
  newHref,
  newLabel,
  active,
  onNavigate,
}: {
  label: string
  href: string
  newHref: string
  newLabel: string
  active: boolean
  onNavigate?: () => void
}) {
  return (
    <div className="mt-4 mb-1 flex items-center justify-between px-2">
      <Link
        href={href}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        className={cn('text-xs transition-colors duration-100 hover:text-ink', active ? 'text-ink' : 'text-ink-3')}
      >
        {label}
      </Link>
      <Tooltip label={newLabel}>
        <Link
          href={newHref}
          onClick={onNavigate}
          aria-label={newLabel}
          className="rounded-sm text-ink-3 transition-colors duration-100 hover:text-ink"
        >
          <Plus className="size-3.5" />
        </Link>
      </Tooltip>
    </div>
  )
}

function NavLink({
  href,
  icon,
  label,
  count,
  countLabel,
  loading,
  active,
  onNavigate,
}: {
  href: string
  icon: React.ReactNode
  label: string
  count?: number
  countLabel?: string
  loading?: boolean
  active: boolean
  onNavigate?: () => void
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-7 items-center gap-2 rounded-sm px-2 text-sm transition-colors duration-100 [&_svg]:size-4 [&_svg]:shrink-0',
        active ? 'bg-selected text-ink [&_svg]:text-signal' : 'text-ink-2 hover:bg-soft hover:text-ink',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? (
        <span title={countLabel} className="rounded-sm bg-action px-1 text-xs text-action-ink tabular-nums">
          {count}
        </span>
      ) : null}
      {loading ? <Loader2 className="animate-spin text-ink-3" aria-label="Importing issues" /> : null}
    </Link>
  )
}

export function Sidebar({ me, onNavigate }: { me: MeDto; onNavigate?: () => void }) {
  const pathname = usePathname()
  const { data: inbox } = useInbox()
  const { data: projects, error: projectsError, mutate: reloadProjects } = useProjects()
  const { openPalette, openNewIssue, openShortcuts } = useShell()
  const [theme, toggleTheme] = useTheme()
  const needsYou = (inbox?.approvals.length ?? 0) + (inbox?.failedIssues.length ?? 0)
  const is = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`)

  return (
    <div className="flex h-full w-full flex-col bg-softer">
      <div className="flex items-center gap-1 p-2">
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 text-left transition-colors duration-100 hover:bg-soft"
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-signal text-xs font-bold text-white">
                {me.org.name.charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{me.org.name}</span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-ink-3" />
            </button>
          </MenuTrigger>
          <MenuContent className="w-56">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <Avatar name={me.account.displayName} size={24} />
              <div className="min-w-0">
                <div className="truncate text-sm">{me.account.displayName}</div>
                <div className="truncate text-xs text-ink-2">{me.account.email}</div>
              </div>
            </div>
            <MenuSeparator />
            <MenuItem onSelect={toggleTheme}>
              {theme === 'dark' ? <Sun /> : <Moon />}
              {theme === 'dark' ? 'Light theme' : 'Dark theme'}
            </MenuItem>
            <MenuItem onSelect={openShortcuts}>
              <Keyboard />
              Keyboard shortcuts
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              onSelect={() => {
                void api.post('/api/auth/logout').finally(() => {
                  window.location.href = '/login'
                })
              }}
            >
              <LogOut />
              Log out
            </MenuItem>
          </MenuContent>
        </Menu>
        <Tooltip
          label={
            <span className="flex items-center gap-1.5">
              Search <Kbd>⌘K</Kbd>
            </span>
          }
        >
          <Button variant="ghost" size="icon" aria-label="Search" onClick={openPalette}>
            <Search />
          </Button>
        </Tooltip>
        <Tooltip
          label={
            <span className="flex items-center gap-1.5">
              New issue <Kbd>C</Kbd>
            </span>
          }
        >
          <Button variant="outline" size="icon" aria-label="New issue" onClick={() => openNewIssue()}>
            <Plus />
          </Button>
        </Tooltip>
      </div>

      <nav aria-label="Main" className="scroll-thin flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        <NavLink href="/inbox" icon={<Inbox />} label="Inbox" count={needsYou} active={is('/inbox')} onNavigate={onNavigate} />
        <NavLink href="/issues" icon={<CircleDot />} label="Issues" active={is('/issues')} onNavigate={onNavigate} />
        <NavLink href="/runs" icon={<Play />} label="Runs" active={is('/runs')} onNavigate={onNavigate} />
        <NavGroup label="Agents" href="/agents" newHref="/agents/new" newLabel="New agent" active={is('/agents')} onNavigate={onNavigate} />
        <NavLink href="/workflows" icon={<Workflow />} label="Workflows" active={is('/workflows')} onNavigate={onNavigate} />
        <NavLink href="/skills" icon={<Sparkles />} label="Skills" active={is('/skills')} onNavigate={onNavigate} />
        <NavLink href="/archetypes" icon={<Shapes />} label="Archetypes" active={is('/archetypes')} onNavigate={onNavigate} />

        <NavGroup
          label="Projects"
          href="/projects"
          newHref="/projects/new"
          newLabel="New project"
          active={pathname === '/projects' || pathname === '/projects/new'}
          onNavigate={onNavigate}
        />
        {projects?.projects.map((project) => (
          <NavLink
            key={project.id}
            href={`/projects/${project.id}`}
            icon={<FolderKanban />}
            label={project.name}
            loading={project.syncState === 'syncing'}
            count={is(`/projects/${project.id}`) ? 0 : project.newIssueCount}
            countLabel={`${project.newIssueCount} new since you last looked`}
            active={is(`/projects/${project.id}`)}
            onNavigate={onNavigate}
          />
        ))}
        {!projects && !projectsError ? (
          <div className="flex flex-col gap-1.5 px-2 py-1">
            <Skeleton className="h-4" />
            <Skeleton className="h-4" />
          </div>
        ) : null}
        {!projects && projectsError ? (
          <button type="button" onClick={() => void reloadProjects()} className="px-2 py-1 text-left text-xs text-ink-2 hover:text-ink">
            Projects did not load. Try again.
          </button>
        ) : null}
        {projects && projects.projects.length === 0 ? (
          <NavLink href="/projects" icon={<FolderKanban />} label="All projects" active={pathname === '/projects'} onNavigate={onNavigate} />
        ) : null}

        <div className="mt-auto pt-4">
          <NavLink href="/settings" icon={<Settings />} label="Settings" active={is('/settings')} onNavigate={onNavigate} />
        </div>
      </nav>
    </div>
  )
}
