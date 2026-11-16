'use client'

import { use, useEffect, useState } from 'react'
import { api } from '@/modules/lib/api'
import { PageHeader } from '@/modules/shell/page-header'
import { ErrorState, Skeleton } from '@/modules/ui'

/**
 * A plugin's own page. It loads from the plugin's address in a frame, so it has no way to Factorix's session, and the
 * frame may not navigate this window.
 */
export default function PluginPage({ params }: { params: Promise<{ pluginId: string; page: string }> }) {
  const { pluginId, page } = use(params)
  const [frame, setFrame] = useState<{ url: string; label: string } | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    setFrame(null)
    setError(null)
    let current = true
    api
      .post<{ url: string; label: string }>(`/api/plugins/${pluginId}/pages/${page}/open`)
      .then((opened) => current && setFrame(opened))
      .catch((caught) => current && setError(caught))
    return () => {
      current = false
    }
  }, [pluginId, page])
  return (
    <>
      <PageHeader crumbs={[{ label: frame?.label ?? 'Plugin' }]} />
      {error ? (
        <div className="p-6">
          <ErrorState error={error} />
        </div>
      ) : frame ? (
        <iframe
          title={frame.label}
          src={frame.url}
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-surface"
        />
      ) : (
        <div className="p-6">
          <Skeleton className="h-40" />
        </div>
      )}
    </>
  )
}
