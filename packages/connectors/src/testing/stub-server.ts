import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: IncomingMessage['headers']
  body: any
  rawBody: string
}

export type StubHandler = (request: RecordedRequest) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined

export interface StubServer {
  url: string
  requests: RecordedRequest[]
  handle(handler: StubHandler): void
  close(): Promise<void>
}

export async function startStubServer(handler?: StubHandler): Promise<StubServer> {
  const requests: RecordedRequest[] = []
  let current = handler
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url ?? '/', 'http://stub')
      let body: unknown = rawBody
      try {
        body = rawBody ? JSON.parse(rawBody) : undefined
      } catch {}
      const request: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
        rawBody,
      }
      requests.push(request)
      const response = current?.(request) ?? { status: 404, body: { message: `no stub for ${request.method} ${request.path}` } }
      res.writeHead(response.status ?? 200, { 'content-type': 'application/json', ...response.headers })
      res.end(JSON.stringify(response.body ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    handle(next) {
      current = next
    },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}
