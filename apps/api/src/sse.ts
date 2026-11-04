import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Redis } from 'ioredis'

const KEEPALIVE_MS = 20_000

export interface SseStream {
  send(data: string, id?: number): void
  onClose(listener: () => void): void
}

export function openSse(request: FastifyRequest, reply: FastifyReply): SseStream {
  reply.hijack()
  const socket = reply.raw
  socket.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  socket.flushHeaders()
  socket.write('retry: 2000\n\n')
  const keepalive = setInterval(() => socket.write(': keepalive\n\n'), KEEPALIVE_MS)
  const closers = new Set<() => void>([() => clearInterval(keepalive)])
  request.raw.on('close', () => {
    for (const close of closers) close()
    closers.clear()
  })
  return {
    send(data, id) {
      socket.write(`${id ? `id: ${id}\n` : ''}data: ${data}\n\n`)
    },
    onClose(listener) {
      if (request.raw.destroyed) listener()
      else closers.add(listener)
    },
  }
}

/** One Redis subscriber per API process, fanned out in memory, so a thousand viewers cost one connection. */
export class RedisFanout {
  private readonly listeners = new Map<string, Set<(message: string) => void>>()
  private readonly subscriber: Redis

  constructor(redis: Redis) {
    this.subscriber = redis.duplicate({ maxRetriesPerRequest: null })
    this.subscriber.on('message', (channel: string, message: string) => {
      for (const listener of this.listeners.get(channel) ?? []) listener(message)
    })
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<() => void> {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
      await this.subscriber.subscribe(channel)
    }
    set.add(listener)
    return () => {
      const current = this.listeners.get(channel)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) {
        this.listeners.delete(channel)
        void this.subscriber.unsubscribe(channel).catch(() => undefined)
      }
    }
  }

  close(): void {
    this.subscriber.disconnect()
  }
}
