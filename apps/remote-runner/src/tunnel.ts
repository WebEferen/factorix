import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { isTunnelFrame, type TunnelFrame, TunnelStream } from '@factorix/runtime'
import type { FrameTransport } from '@factorix/sandbox'

const MAX_BODY = 16 * 1024 * 1024
const PING_MS = 20_000
/** The names preview services have on their networks. Nothing else on this machine may be dialled through the tunnel. */
const PREVIEW_SERVICE = /^fx-env-[a-z0-9]+-[a-z0-9][a-z0-9_.-]*$/

/**
 * The runner's side for the preview tunnel, which runs in a container of its own: it speaks the same two endpoints Factorix gives
 * the runner, and only tunnel frames pass in either direction. That container joins preview networks, so it holds no token and no Docker.
 */
export function createTunnelHub(options: { link: FrameTransport; secret: string }): (request: IncomingMessage, response: ServerResponse) => boolean {
  const { link } = options
  const secret = Buffer.from(`Bearer ${options.secret}`)
  const clients = new Set<ServerResponse>()

  link.onFrame((frame) => {
    if (!isTunnelFrame(frame)) return
    if (clients.size === 0) {
      if (frame.t !== 'tun.close') link.send({ t: 'tun.close', id: frame.id, error: 'no preview tunnel is running on the runner' })
      return
    }
    const event = `data: ${JSON.stringify(frame)}\n\n`
    for (const client of clients) client.write(event)
  })

  return (request, response) => {
    const stream = request.method === 'GET' && request.url === '/api/runner/stream'
    const frames = request.method === 'POST' && request.url === '/api/runner/frames'
    if (!stream && !frames) return false
    const given = Buffer.from(String(request.headers.authorization ?? ''))
    if (given.length !== secret.length || !timingSafeEqual(given, secret)) {
      response.writeHead(401).end()
      return true
    }
    if (stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      response.write(': connected\n\n')
      clients.add(response)
      const ping = setInterval(() => response.write(': ping\n\n'), PING_MS)
      response.on('close', () => {
        clearInterval(ping)
        clients.delete(response)
      })
      return true
    }
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) request.destroy()
      else chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { frames?: { t: unknown }[] }
        for (const frame of Array.isArray(body.frames) ? body.frames : []) if (isTunnelFrame(frame)) link.send(frame)
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      } catch {
        response.writeHead(400).end()
      }
    })
    return true
  }
}

/** Opens the connections the gateway asks for and carries their bytes. Runs where the preview's network is reachable. */
export function serveTunnel(
  transport: FrameTransport,
  options: { allow?: (host: string) => boolean; log?: (message: string) => void } = {},
): () => void {
  const allow = options.allow ?? ((host: string) => PREVIEW_SERVICE.test(host))
  const streams = new Map<string, TunnelStream>()
  const send = (frame: TunnelFrame) => transport.send(frame)

  const stopListening = transport.onFrame((frame) => {
    if (!isTunnelFrame(frame)) return
    if (frame.t === 'tun.open') {
      if (!allow(frame.host)) {
        options.log?.(`refused a connection to ${frame.host}`)
        return send({ t: 'tun.close', id: frame.id, error: 'not a preview service' })
      }
      const stream = new TunnelStream(frame.id, send)
      streams.set(frame.id, stream)
      const socket = connect({ host: frame.host, port: frame.port })
      socket.on('error', (error) => stream.destroy(error))
      socket.on('close', () => stream.destroy())
      stream.on('error', () => undefined)
      stream.on('close', () => {
        streams.delete(frame.id)
        socket.destroy()
      })
      socket.pipe(stream)
      stream.pipe(socket)
      return
    }
    const stream = streams.get(frame.id)
    if (stream) stream.receive(frame)
    else if (frame.t !== 'tun.close') send({ t: 'tun.close', id: frame.id })
  })

  return () => {
    stopListening()
    for (const stream of streams.values()) stream.destroy()
  }
}
