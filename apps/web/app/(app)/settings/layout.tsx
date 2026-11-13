'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { cn } from '@/modules/lib/format'
import { PageHeader } from '@/modules/shell/page-header'

const SECTIONS = [
  { href: '/settings/general', label: 'General' },
  { href: '/settings/connections', label: 'Connections' },
  { href: '/settings/network', label: 'Network' },
  { href: '/settings/runners', label: 'Runners' },
  { href: '/settings/members', label: 'Members' },
  { href: '/settings/tokens', label: 'API tokens' },
  { href: '/settings/audit', label: 'Audit log' },
  { href: '/settings/spend', label: 'Spend' },
]

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Settings' }]}
        below={SECTIONS.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            aria-current={pathname.startsWith(section.href) ? 'page' : undefined}
            className={cn(
              'flex h-7 items-center rounded-sm px-2 text-sm whitespace-nowrap transition-colors duration-150',
              pathname.startsWith(section.href) ? 'bg-soft text-ink' : 'text-ink-2 hover:bg-soft/60 hover:text-ink',
            )}
          >
            {section.label}
          </Link>
        ))}
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
    </>
  )
}
