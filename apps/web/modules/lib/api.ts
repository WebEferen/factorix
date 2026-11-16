import type { ApiErrorBody } from '@factorix/schemas'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

const LINK = /^\/api\/(issues|runs|projects|agents|workflows)\/([0-9a-f]{8}-[0-9a-f-]{27})$/
export const SWITCHED_KEY = 'fx-switched-org'

/**
 * A link to something in another organization of yours answers 404 in the one you are in. This moves the session
 * to the right one and loads the page again. It tries once per address, so a link to nothing stays a 404.
 */
async function followLink(path: string): Promise<void> {
  const match = LINK.exec(path)
  if (!match || typeof window === 'undefined') return
  const tried = `fx-followed:${path}`
  if (sessionStorage.getItem(tried)) return
  sessionStorage.setItem(tried, '1')
  const response = await fetch('/api/auth/follow', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: match[1], id: match[2] }),
  })
  if (!response.ok) return
  const result = (await response.json()) as { switched: boolean; org?: { name: string } }
  if (!result.switched) return
  sessionStorage.setItem(SWITCHED_KEY, result.org?.name ?? '')
  window.location.reload()
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const error = (parsed as ApiErrorBody | undefined)?.error
    if (
      response.status === 401 &&
      typeof window !== 'undefined' &&
      !window.location.pathname.startsWith('/login') &&
      !window.location.pathname.startsWith('/setup') &&
      path !== '/api/auth/login'
    ) {
      window.location.href = '/login'
    }
    if (response.status === 404 && method === 'GET') await followLink(path).catch(() => undefined)
    throw new ApiError(response.status, error?.code ?? 'error', error?.message ?? `The request failed with status ${response.status}`, error?.details)
  }
  return parsed as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T = unknown>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T = unknown>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: <T = unknown>(path: string) => request<T>('DELETE', path),
}

export const fetcher = <T>(path: string) => api.get<T>(path)
