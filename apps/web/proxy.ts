import { type NextRequest, NextResponse } from 'next/server'

const apiUrl = process.env.API_URL ?? 'http://localhost:4100'
const previewBase = new URL(process.env.FACTORIX_PREVIEW_URL ?? 'http://preview.localhost:4102')
const BASE_FRAMES = `https://www.loom.com https://www.youtube-nocookie.com ${previewBase.protocol}//*.${previewBase.host}`
const TTL_MS = 30_000

let cached: { origins: string[]; at: number } | undefined

/** Plugins are installed for the whole installation, so one answer serves everyone. Only a signed-in request can refresh it. */
async function pluginOrigins(request: NextRequest): Promise<string[]> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.origins
  const cookie = request.headers.get('cookie')
  if (!cookie?.includes('fx_session=')) return cached?.origins ?? []
  try {
    const response = await fetch(`${apiUrl}/api/plugins/origins`, { headers: { cookie }, signal: AbortSignal.timeout(2000) })
    if (!response.ok) return cached?.origins ?? []
    const { origins } = (await response.json()) as { origins: string[] }
    // An origin goes into a header, so anything that is not plainly one is dropped.
    cached = { origins: origins.filter((origin) => /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)), at: Date.now() }
    return cached.origins
  } catch {
    return cached?.origins ?? []
  }
}

/**
 * Ticket and agent text must not be able to load a remote image or video, because the request itself can carry data out.
 * Frames are limited to previews, the two video hosts, and the plugins an installation admin installed.
 */
export async function proxy(request: NextRequest) {
  const response = NextResponse.next()
  const frames = [BASE_FRAMES, ...(await pluginOrigins(request))].join(' ')
  response.headers.set('Content-Security-Policy', `img-src 'self' data: blob:; media-src 'self' blob:; frame-src ${frames}`)
  return response
}

export const config = {
  matcher: ['/((?!api/|webhooks/|_plugin/|_next/|favicon.ico|icon.svg|apple-icon.png).*)'],
}
