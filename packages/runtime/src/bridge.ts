/** Where the runner listens for tools inside the agent's container. The MCP server that the agent's runtime starts connects here. */
export const BRIDGE_SOCKET = '/tmp/factorix-bridge.sock'

/** Asks the worker for something only Factorix can do, such as starting a preview or calling a plugin's tool. */
export type BridgeOp = 'preview.start' | 'preview.status' | 'preview.logs' | 'preview.stop' | 'tool.list' | 'tool.call'

export const BRIDGE_OPS: readonly BridgeOp[] = ['preview.start', 'preview.status', 'preview.logs', 'preview.stop', 'tool.list', 'tool.call']

/** Answered by the runner itself, inside the container: the helpers of a runtime whose SDK has none of its own. */
export type RunnerOp = 'helper.list' | 'helper.run'

export const RUNNER_OPS: readonly RunnerOp[] = ['helper.list', 'helper.run']

/** One line on the socket each way. */
export interface BridgeCall {
  id: number
  op: BridgeOp | RunnerOp
  input: unknown
}

export interface BridgeReply {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}
