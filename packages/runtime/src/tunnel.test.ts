import { describe, expect, it } from 'vitest'
import { TUNNEL_WINDOW, type TunnelFrame, TunnelStream } from './tunnel'

/** Two ends with frames crossing as JSON on a later tick. */
function pair() {
  const frames: TunnelFrame[] = []
  const ends: TunnelStream[] = []
  const end = (other: () => TunnelStream) =>
    new TunnelStream('c1', (frame) => {
      frames.push(frame)
      const copy = JSON.parse(JSON.stringify(frame)) as TunnelFrame
      queueMicrotask(() => other().receive(copy))
    })
  ends.push(
    end(() => ends[1] as TunnelStream),
    end(() => ends[0] as TunnelStream),
  )
  return { near: ends[0] as TunnelStream, far: ends[1] as TunnelStream, frames }
}

const read = async (stream: TunnelStream): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

describe('a tunnelled connection', () => {
  it('carries bytes both ways and ends each direction on its own', async () => {
    const { near, far } = pair()
    near.end(Buffer.from([0, 255, 10, 13]))
    far.end('pong')
    const [there, back] = await Promise.all([read(far), read(near)])
    expect([...there]).toEqual([0, 255, 10, 13])
    expect(back.toString()).toBe('pong')
  })

  it('holds the sender once a window is unread, and lets it go as the reader catches up', async () => {
    const { near, far, frames } = pair()
    const chunk = Buffer.alloc(256 * 1024, 1)
    let written = 0
    for (let index = 0; index < 12; index += 1) near.write(chunk, () => (written += 1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(written).toBeLessThan(12)
    const sent = frames.filter((frame) => frame.t === 'tun.data').length * chunk.length
    expect(sent).toBeLessThanOrEqual(TUNNEL_WINDOW + chunk.length)

    near.end()
    far.end()
    near.resume()
    expect((await read(far)).length).toBe(12 * chunk.length)
    expect(written).toBe(12)
  })

  it('closes the other end, with the reason when there is one', async () => {
    const { near, far } = pair()
    const failed = new Promise<Error>((resolve) => far.on('error', resolve))
    near.on('error', () => undefined)
    near.destroy(new Error('connect ECONNREFUSED'))
    expect((await failed).message).toBe('connect ECONNREFUSED')

    const second = pair()
    const closed = new Promise<void>((resolve) => second.far.on('close', resolve))
    second.near.destroy()
    await closed
    expect(second.frames.filter((frame) => frame.t === 'tun.close')).toHaveLength(1)
  })
})
