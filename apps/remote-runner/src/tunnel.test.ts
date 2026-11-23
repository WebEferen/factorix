import { connect } from 'node:net'
import { Duplex } from 'node:stream'
import { TUNNEL_WINDOW, type TunnelFrame, TunnelStream } from '@factorix/runtime'
import type { RunnerFrame } from '@factorix/sandbox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serveTunnel } from './tunnel'

vi.mock('node:net', async (original) => ({ ...(await original<typeof import('node:net')>()), connect: vi.fn() }))

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('serveTunnel', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  it('passes on what the app sent before it hung up, even while the gateway still owes acks', async () => {
    const app = new Duplex({ read: () => undefined, write: (_chunk, _encoding, done) => done() })
    vi.mocked(connect).mockReturnValue(app as unknown as ReturnType<typeof connect>)

    const toRunner = new Set<(frame: RunnerFrame) => void>()
    const deliver = (frame: TunnelFrame) => {
      for (const listener of toRunner) listener(frame)
    }
    let gateway: TunnelStream | undefined
    cleanups.push(
      serveTunnel(
        {
          send: (frame) => gateway?.receive(frame as TunnelFrame),
          onFrame: (listener) => {
            toRunner.add(listener)
            return () => toRunner.delete(listener)
          },
        },
        { allow: () => true },
      ),
    )
    const owed: TunnelFrame[] = []
    gateway = new TunnelStream('tun-1', (frame) => (frame.t === 'tun.ack' ? owed.push(frame) : deliver(frame)))
    gateway.on('error', () => undefined)
    let received = 0
    gateway.on('data', (chunk: Buffer) => (received += chunk.length))
    const done = new Promise<string>((resolve) => {
      gateway?.on('end', () => resolve('end'))
      gateway?.on('close', () => resolve('close'))
    })
    deliver({ t: 'tun.open', id: 'tun-1', host: 'fx-env-x-web', port: 80 })

    // A full window goes out. One small ack lets the runner read the app's last bytes and its end, but only part of them fits the
    // window, and the connection closes while the rest still waits for acks.
    app.push(Buffer.alloc(TUNNEL_WINDOW, 1))
    app.push(Buffer.alloc(1000, 2))
    app.push(Buffer.alloc(500, 3))
    app.push(null)
    await tick()
    deliver({ t: 'tun.ack', id: 'tun-1', n: 1000 })
    await tick()
    app.destroy()
    await tick()
    for (const ack of owed.splice(0)) deliver(ack)

    expect(await done).toBe('end')
    expect(received).toBe(TUNNEL_WINDOW + 1500)
  })
})
