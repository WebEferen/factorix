import type { Metadata } from 'next'
import Link from 'next/link'
import { Button } from '@/modules/ui'
import { NotFoundArt } from '@/modules/ui/empty-art'

export const metadata: Metadata = { title: 'Page not found' }

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas p-6 text-center">
      <div className="flex flex-col items-center">
        <div className="mb-5 w-full max-w-60">
          <NotFoundArt />
        </div>
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="mt-1 mb-4 text-sm text-ink-2">The link may be old, or the page may have moved.</p>
        <Link href="/">
          <Button variant="primary">Back to Factorix</Button>
        </Link>
      </div>
    </main>
  )
}
