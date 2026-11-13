import { parseSse } from '@factorix/runtime'
import type { FrameTransport, RunnerFrame } from '@factorix/sandbox'

export interface RunnerLinkOptions {
  /** Where Factorix is, such as https://factorix.example.com. */
  url: string
  token: string
  fetchImpl?: typeof fetch
  log?: (message: string) => void
  /** The first wait before reconnecting or resending. It doubles up to `maxRetryMs`. */
  retryMs?: number
  maxRetryMs?: number
}

export interface RunnerLink extends FrameTransport {
  /** A call to one of the runner endpoints beside the frames, such as asking what a run token allows. */
  request<T>(path: string, body: unknown): Promise<T>
  close(): void
}

const BATCH_FRAMES = 200
const BATCH_BYTES = 4 * 1024 * 1024
/** Frames kept while Factorix cannot be reached. Past this the oldest go, since nobody is waiting for them any more. */
const MAX_QUEUED = 50_000

/**
 * The runner's connection to Factorix. It only ever dials out: one stream brings frames from the workers, and frames going back are
 * posted in order, a batch at a time, and resent until they arrive.
 */
export function connectRunner(options: RunnerLinkOptions): RunnerLink {
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? (() => undefined)
  const base = options.url.replace(/\/+$/, '')
  const headers = { authorization: `Bearer ${options.token}` }
  const firstRetry = options.retryMs ?? 1000
  const maxRetry = options.maxRetryMs ?? 15_000
  const listeners = new Set<(frame: RunnerFrame) => void>()
  const outbox: string[] = []
  const closing = new AbortController()
  let sending = false

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      closing.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      })
    })

  const receive = async () => {
    let wait = firstRetry
    while (!closing.signal.aborted) {
      try {
        const response = await fetchImpl(`${base}/api/runner/stream`, {
          headers: { ...headers, accept: 'text/event-stream' },
          signal: closing.signal,
        })
        if (response.status === 401) throw new Error('Factorix did not accept the runner token')
        if (!response.ok || !response.body) throw new Error(`Factorix answered ${response.status}`)
        log('connected')
        wait = firstRetry
        for await (const data of parseSse(response.body.pipeThrough(new TextDecoderStream()) as unknown as AsyncIterable<string>)) {
          const frame = JSON.parse(data) as RunnerFrame
          for (const listener of listeners) listener(frame)
        }
        log('the stream ended, reconnecting')
      } catch (error) {
        if (closing.signal.aborted) return
        log(`not connected: ${(error as Error).message}`)
      }
      await pause(wait)
      wait = Math.min(wait * 2, maxRetry)
    }
  }

  const flush = async () => {
    if (sending) return
    sending = true
    let wait = firstRetry
    try {
      while (outbox.length > 0 && !closing.signal.aborted) {
        let count = 0
        let bytes = 0
        while (count < outbox.length && count < BATCH_FRAMES && (count === 0 || bytes + (outbox[count] as string).length <= BATCH_BYTES)) {
          bytes += (outbox[count] as string).length
          count += 1
        }
        try {
          const response = await fetchImpl(`${base}/api/runner/frames`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: `{"frames":[${outbox.slice(0, count).join(',')}]}`,
            signal: closing.signal,
          })
          if (!response.ok) throw new Error(`Factorix answered ${response.status}`)
          await response.arrayBuffer()
          outbox.splice(0, count)
          wait = firstRetry
        } catch (error) {
          if (closing.signal.aborted) return
          log(`could not send ${count} frames, retrying: ${(error as Error).message}`)
          await pause(wait)
          wait = Math.min(wait * 2, maxRetry)
        }
      }
    } finally {
      sending = false
    }
  }

  void receive()

  return {
    send(frame) {
      outbox.push(JSON.stringify(frame))
      if (outbox.length > MAX_QUEUED) {
        outbox.splice(0, outbox.length - MAX_QUEUED)
        log('dropped the oldest frames, Factorix has been unreachable for too long')
      }
      void flush()
    },
    onFrame(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async request<T>(path: string, body: unknown): Promise<T> {
      const response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: closing.signal,
      })
      if (!response.ok) throw new Error(`Factorix answered ${response.status}`)
      return (await response.json()) as T
    },
    close() {
      closing.abort()
    },
  }
}
