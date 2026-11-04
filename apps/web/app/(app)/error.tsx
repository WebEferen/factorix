'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { Button, EmptyState } from '@/modules/ui'
import { ProblemArt } from '@/modules/ui/empty-art'

/** Renders inside the shell, so the sidebar stays and moving to another page recovers. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])
  return (
    <EmptyState
      art={<ProblemArt />}
      title="This page hit a problem"
      action={
        <span className="flex items-center gap-3">
          <Button onClick={reset}>Try again</Button>
          <Link href="/inbox" className="text-sm text-link hover:underline">
            Go to inbox
          </Link>
        </span>
      }
    >
      The rest of Factorix still works.
    </EmptyState>
  )
}
