import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { type TunnelFrame, TunnelStream } from '@factorix/runtime'
import type { Redis } from 'ioredis'
import type { PreviewTarget } from './gateway'

const DOWN_TTL_SECONDS = 3600

/**
 * Connections to previews on runners. Frames go out on the queue the runner's own link reads and come back on a channel of their
 * own, so the runner still only dials out and the gateway sees nothing else the runner sends.
 */
export function createRunnerDialer(redis: Redis): { dial(runnerId: string, target: PreviewTarget): Promise<Duplex>; close(): void } {
  const subscriber = redis.duplicate({ maxRetriesPerRequest: null })
  const subscribed = new Map<string, Promise<unknown>>()
  const streams = new Map<string, TunnelStream>()
  subscriber.on('message', (_channel: string, message: string) => {
    const frame = JSON.parse(message) as TunnelFrame
    streams.get(frame.id)?.receive(frame)
  })

  return {
    async dial(runnerId, target) {
      if ((await redis.exists(`runner:${runnerId}:online`)) !== 1) throw new Error('the runner is offline')
      const channel = `runner:${runnerId}:tun`
      let ready = subscribed.get(channel)
      if (!ready) {
        ready = subscriber.subscribe(channel)
        subscribed.set(channel, ready)
        ready.catch(() => subscribed.delete(channel))
      }
      await ready
      const queue = `runner:${runnerId}:down`
      const stream = new TunnelStream(randomBytes(12).toString('hex'), (frame) => {
        void redis
          .multi()
          .rpush(queue, JSON.stringify(frame))
          .expire(queue, DOWN_TTL_SECONDS)
          .exec()
          .catch(() => stream.destroy())
      })
      streams.set(stream.id, stream)
      stream.on('close', () => streams.delete(stream.id))
      redis
        .multi()
        .rpush(queue, JSON.stringify({ t: 'tun.open', id: stream.id, host: target.host, port: target.port } satisfies TunnelFrame))
        .expire(queue, DOWN_TTL_SECONDS)
        .exec()
        .catch(() => stream.destroy())
      return stream
    },
    close() {
      for (const stream of streams.values()) stream.destroy()
      subscriber.disconnect()
    },
  }
}
