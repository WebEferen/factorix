export type Route = { kind: 'list' } | { kind: 'plugin'; name: string; path: string } | { kind: 'none' }

export const LIST_PATH = '/__plugins'

/** The plugin a host name belongs to, as `digest` for `digest.plugins.localhost:4110` under `http://plugins.localhost:4110`. */
export function subdomainOf(hostHeader: string | undefined, publicHostname: string): string | null {
  if (!hostHeader) return null
  const hostname = hostHeader.replace(/:\d+$/, '').toLowerCase()
  const suffix = `.${publicHostname.toLowerCase()}`
  if (!hostname.endsWith(suffix)) return null
  const label = hostname.slice(0, -suffix.length)
  return label && !label.includes('.') ? label : null
}

/**
 * Pages load only from a plugin's own subdomain, so no two plugins share an origin. On any other host name a plugin is
 * reached by its first path segment, for Factorix's signed calls, and only with POST.
 */
export function routeOf(
  request: { method: string; host: string | undefined; url: string },
  publicHostname: string,
  names: ReadonlySet<string>,
): Route {
  const label = subdomainOf(request.host, publicHostname)
  if (label !== null) return names.has(label) ? { kind: 'plugin', name: label, path: request.url } : { kind: 'none' }
  const queryAt = request.url.indexOf('?')
  const pathname = queryAt === -1 ? request.url : request.url.slice(0, queryAt)
  const query = queryAt === -1 ? '' : request.url.slice(queryAt)
  if (request.method === 'GET' && pathname === LIST_PATH) return { kind: 'list' }
  if (request.method !== 'POST') return { kind: 'none' }
  const match = /^\/([^/]+)(\/.*)?$/.exec(pathname)
  if (!match?.[1] || !names.has(match[1])) return { kind: 'none' }
  return { kind: 'plugin', name: match[1], path: `${match[2] ?? '/'}${query}` }
}
