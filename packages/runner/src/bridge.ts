import { rmSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { BRIDGE_OPS, type BridgeCall, type BridgeOp, type BridgeReply, LineSplitter } from '@factorix/runtime'

export type BridgeHandler = (op: BridgeOp, input: unknown) => Promise<unknown>

/** Listens inside the agent's container for tools that need the worker, one JSON line per call and per reply. */
export function serveBridge(path: string, handle: BridgeHandler): Promise<Server> {
  rmSync(path, { force: true })
  const server = createServer((socket) => {
    const lines = new LineSplitter()
    socket.setEncoding('utf8')
    socket.on('error', () => undefined)
    const answer = async (line: string) => {
      let call: BridgeCall
      try {
        call = JSON.parse(line) as BridgeCall
      } catch {
        return
      }
      let reply: BridgeReply
      if (!BRIDGE_OPS.includes(call.op)) reply = { id: call.id, ok: false, error: `There is no operation called ${String(call.op)}.` }
      else {
        try {
          reply = { id: call.id, ok: true, result: await handle(call.op, call.input) }
        } catch (error) {
          reply = { id: call.id, ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`)
    }
    socket.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) void answer(line)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => resolve(server))
  })
}

/** One call over the bridge. Rejects with the worker's message when it refuses. */
export function callBridge(path: string, op: BridgeOp, input: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    const lines = new LineSplitter()
    socket.setEncoding('utf8')
    socket.on('error', (error) => reject(new Error(`Factorix is not reachable from here: ${error.message}`)))
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 1, op, input } satisfies BridgeCall)}\n`))
    socket.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) {
        const reply = JSON.parse(line) as BridgeReply
        socket.end()
        if (reply.ok) resolve(reply.result)
        else reject(new Error(reply.error ?? 'Factorix could not do that.'))
      }
    })
    socket.on('close', () => reject(new Error('Factorix closed the connection without answering.')))
  })
}
