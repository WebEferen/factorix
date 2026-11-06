/** Where the runner listens for tools inside the agent's container. The MCP server that the agent's runtime starts connects here. */
export const BRIDGE_SOCKET = '/tmp/factorix-bridge.sock'

/** Asks the worker for something only Factorix can do, such as starting a preview. */
export type BridgeOp = 'preview.start' | 'preview.status' | 'preview.logs' | 'preview.stop'

export const BRIDGE_OPS: readonly BridgeOp[] = ['preview.start', 'preview.status', 'preview.logs', 'preview.stop']

/** One line on the socket each way. */
export interface BridgeCall {
  id: number
  op: BridgeOp
  input: unknown
}

export interface BridgeReply {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}
