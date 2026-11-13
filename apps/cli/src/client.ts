import { parseSse } from '@factorix/runtime'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export class Client {
  constructor(
    readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async failure(response: Response): Promise<ApiError> {
    const text = await response.text().catch(() => '')
    let error: { code?: string; message?: string } | undefined
    try {
      error = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error
    } catch {
      error = undefined
    }
    if (response.status === 401) return new ApiError(401, 'unauthenticated', 'The token was not accepted. Run fx login again.')
    return new ApiError(response.status, error?.code ?? 'error', error?.message ?? `The request failed with status ${response.status}`)
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw await this.failure(response)
    const text = await response.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  async *events(path: string, signal: AbortSignal): AsyncGenerator<string> {
    const response = await this.fetchImpl(`${this.url}${path}`, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
      signal,
    })
    if (!response.ok || !response.body) throw await this.failure(response)
    yield* parseSse(response.body.pipeThrough(new TextDecoderStream()) as unknown as AsyncIterable<string>)
  }
}
