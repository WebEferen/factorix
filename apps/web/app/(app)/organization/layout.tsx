'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { useMe } from '@/modules/lib/data'
import { cn } from '@/modules/lib/format'
import { PageHeader } from '@/modules/shell/page-header'

export default function OrganizationLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { data: me } = useMe()
  const sections = [
    { href: '/organization/members', label: 'Members' },
    ...(me?.installationAdmin ? [{ href: '/organization/all', label: 'All organizations' }] : []),
  ]
  return (
    <>
      <PageHeader
        crumbs={[{ label: me?.org.name ?? 'Organization' }]}
        below={sections.map((section) => (
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
