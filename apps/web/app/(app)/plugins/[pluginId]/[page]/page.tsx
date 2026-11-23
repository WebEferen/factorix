'use client'

import { use, useEffect, useRef, useState } from 'react'
import { api } from '@/modules/lib/api'
import { PageHeader } from '@/modules/shell/page-header'
import { ErrorState, Skeleton } from '@/modules/ui'

/**
 * A plugin's own page. It loads in a frame from the plugin's address, or for a bundled plugin from this one without an
 * origin, so it has no way to Factorix's session, and the frame may not navigate this window.
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

  // A page's signed context lasts a few minutes. One that stays open asks for the next, and gets it only from this
  // window, which holds the session, and only for the frame this window opened. A page without an origin cannot be
  // told apart by it, so it also has to name the last token it was given.
  const frameRef = useRef<HTMLIFrameElement>(null)
  const issued = useRef<string | null>(null)
  const origin = frame ? new URL(frame.url).origin : null
  const opaque = origin !== null && origin === window.location.origin
  useEffect(() => {
    if (!frame || !origin) return
    issued.current = new URL(frame.url).searchParams.get('factorix')
    const answer = (event: MessageEvent) => {
      const target = frameRef.current?.contentWindow
      if (!target || event.source !== target || event.data?.type !== 'factorix:token') return
      if (opaque ? event.origin !== 'null' || event.data.token !== issued.current : event.origin !== origin) return
      api
        .post<{ url: string }>(`/api/plugins/${pluginId}/pages/${page}/open`)
        .then((opened) => {
          const token = new URL(opened.url).searchParams.get('factorix')
          if (opaque) issued.current = token
          target.postMessage({ type: 'factorix:token', token }, opaque ? '*' : origin)
        })
        .catch(() => undefined)
    }
    window.addEventListener('message', answer)
    return () => window.removeEventListener('message', answer)
  }, [pluginId, page, frame, origin, opaque])
  return (
    <>
      <PageHeader crumbs={[{ label: frame?.label ?? 'Plugin' }]} />
      {error ? (
        <div className="p-6">
          <ErrorState error={error} />
        </div>
      ) : frame ? (
        <iframe
          ref={frameRef}
          title={frame.label}
          src={frame.url}
          sandbox={`allow-scripts allow-forms${opaque ? '' : ' allow-same-origin'} allow-popups allow-downloads`}
          allow="clipboard-write"
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
