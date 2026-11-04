'use client'

import { Menu as MenuIcon } from 'lucide-react'
import Link from 'next/link'
import { Fragment, type ReactNode, useEffect } from 'react'
import { Button } from '../ui'
import { useShell } from './state'

export interface Crumb {
  label: string
  href?: string
}

export function PageHeader({ crumbs, children, below }: { crumbs: Crumb[]; children?: ReactNode; below?: ReactNode }) {
  const { openNav } = useShell()
  const title = [...crumbs]
    .reverse()
    .map((crumb) => crumb.label)
    .join(' · ')
  useEffect(() => {
    document.title = title ? `${title} · Factorix` : 'Factorix'
  }, [title])
  return (
    <header className="shrink-0 border-b border-divider bg-surface">
      <div className="flex h-11 items-center gap-2 px-4">
        <Button variant="ghost" size="icon" className="-ml-1 md:hidden" aria-label="Open navigation" onClick={openNav}>
          <MenuIcon />
        </Button>
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
          {crumbs.map((crumb, index) => (
            <Fragment key={`${crumb.label}-${index}`}>
              {index > 0 ? <span className="text-ink-3">/</span> : null}
              {crumb.href ? (
                <Link href={crumb.href} className="truncate text-ink-2 transition-colors duration-150 hover:text-ink">
                  {crumb.label}
                </Link>
              ) : (
                <span className="truncate font-semibold">{crumb.label}</span>
              )}
            </Fragment>
          ))}
        </nav>
        {children ? <div className="flex shrink-0 items-center gap-1.5">{children}</div> : null}
      </div>
      {below ? <div className="flex min-h-9 items-center gap-2 overflow-x-auto border-t border-divider px-4 py-1">{below}</div> : null}
    </header>
  )
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`scroll-thin min-h-0 flex-1 overflow-y-auto ${className ?? ''}`}>{children}</div>
}
