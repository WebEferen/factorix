import { Duplex } from 'node:stream'

/** One TCP connection to a preview on a runner's machine, carried as frames over the runner's own link. Data is base64. */
export type TunnelFrame =
  | { t: 'tun.open'; id: string; host: string; port: number }
  | { t: 'tun.data'; id: string; d: string }
  | { t: 'tun.ack'; id: string; n: number }
  | { t: 'tun.end'; id: string }
  | { t: 'tun.close'; id: string; error?: string }

export function isTunnelFrame(frame: { t: unknown }): frame is TunnelFrame {
  return typeof frame.t === 'string' && frame.t.startsWith('tun.')
}

/** Bytes one end may send before the other has taken them, so a slow reader holds the sender instead of filling the queue between them. */
export const TUNNEL_WINDOW = 1024 * 1024

/** One end of a tunnelled connection. Both ends are the same: what is written here is read at the other one. */
export class TunnelStream extends Duplex {
  private unacked = 0
  private owed = 0
  private held: ((error?: Error | null) => void) | null = null
  private closedByPeer = false

  constructor(
    readonly id: string,
    private readonly sendFrame: (frame: TunnelFrame) => void,
  ) {
    super()
  }

  receive(frame: TunnelFrame): void {
    if (this.destroyed) return
    if (frame.t === 'tun.data') {
      const chunk = Buffer.from(frame.d, 'base64')
      if (this.push(chunk)) this.sendFrame({ t: 'tun.ack', id: this.id, n: chunk.length })
      else this.owed += chunk.length
    } else if (frame.t === 'tun.ack') {
      this.unacked -= frame.n
      if (this.unacked < TUNNEL_WINDOW && this.held) {
        const done = this.held
        this.held = null
        done()
      }
    } else if (frame.t === 'tun.end') {
      this.push(null)
    } else if (frame.t === 'tun.close') {
      this.closedByPeer = true
      this.destroy(frame.error ? new Error(frame.error) : undefined)
    }
  }

  override _read(): void {
    if (this.owed === 0) return
    this.sendFrame({ t: 'tun.ack', id: this.id, n: this.owed })
    this.owed = 0
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.sendFrame({ t: 'tun.data', id: this.id, d: chunk.toString('base64') })
    this.unacked += chunk.length
    if (this.unacked >= TUNNEL_WINDOW) this.held = done
    else done()
  }

  override _final(done: (error?: Error | null) => void): void {
    this.sendFrame({ t: 'tun.end', id: this.id })
    done()
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    if (!this.closedByPeer) this.sendFrame({ t: 'tun.close', id: this.id, ...(error ? { error: error.message } : {}) })
    const held = this.held
    this.held = null
    held?.(error ?? new Error('The connection closed.'))
    done(error)
  }

  // What node:http asks of a socket.
  setTimeout(): this {
    return this
  }
  setNoDelay(): this {
    return this
  }
  setKeepAlive(): this {
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
}
