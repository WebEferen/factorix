import { BUNDLED_PLUGIN_PAGES } from '@factorix/connectors'

/** `page` is a browser's request, passed on by the web from Factorix's own address. Anything else is Factorix calling. */
export type Route = { kind: 'list' } | { kind: 'plugin'; name: string; path: string; page: boolean } | { kind: 'none' }

export const LIST_PATH = '/__plugins'

/**
 * A browser reaches a plugin under `/_plugin/<name>`, with any method, since its pages post forms back to themselves.
 * Factorix's signed calls reach it by its first path segment, and only with POST.
 */
export function routeOf(request: { method: string; url: string }, names: ReadonlySet<string>): Route {
  const queryAt = request.url.indexOf('?')
  const pathname = queryAt === -1 ? request.url : request.url.slice(0, queryAt)
  const query = queryAt === -1 ? '' : request.url.slice(queryAt)
  if (request.method === 'GET' && pathname === LIST_PATH) return { kind: 'list' }
  const page = pathname.startsWith(`${BUNDLED_PLUGIN_PAGES}/`)
  if (!page && request.method !== 'POST') return { kind: 'none' }
  const match = /^\/([^/]+)(\/.*)?$/.exec(page ? pathname.slice(BUNDLED_PLUGIN_PAGES.length) : pathname)
  if (!match?.[1] || !names.has(match[1])) return { kind: 'none' }
  return { kind: 'plugin', name: match[1], path: `${match[2] ?? '/'}${query}`, page }
}
