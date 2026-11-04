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
