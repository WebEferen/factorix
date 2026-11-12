import { createInterface } from 'node:readline'
import { BRIDGE_SOCKET, type BridgeOp } from '@factorix/runtime'
import { callBridge } from './bridge'

interface Tool {
  name: string
  op: BridgeOp
  description: string
  inputSchema: Record<string, unknown>
}

export const PREVIEW_TOOLS: Tool[] = [
  {
    name: 'preview_start',
    op: 'preview.start',
    description:
      'Starts a preview of this issue with the project environment, or refreshes the running one, and waits up to 45 seconds for it. ' +
      'source "worktree" (the default) runs your files as they are now, including uncommitted and untracked ones. source "branch" runs what is pushed. ' +
      'It runs without the project’s secret values. Returns its state and the addresses to reach it from here.',
    inputSchema: { type: 'object', properties: { source: { type: 'string', enum: ['worktree', 'branch'] } }, additionalProperties: false },
  },
  {
    name: 'preview_status',
    op: 'preview.status',
    description: 'Shows the preview state, services, and addresses. With wait true it waits up to 45 seconds while the preview starts.',
    inputSchema: { type: 'object', properties: { wait: { type: 'boolean' } }, additionalProperties: false },
  },
  {
    name: 'preview_logs',
    op: 'preview.logs',
    description: 'Returns recent preview log lines, newest last. Give service for one service. lines defaults to 50, at most 200.',
    inputSchema: {
      type: 'object',
      properties: { service: { type: 'string' }, lines: { type: 'integer', minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
  },
  {
    name: 'preview_stop',
    op: 'preview.stop',
    description: 'Stops the preview and removes its containers. Its data stays for the next start.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

interface Message {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: { protocolVersion?: string; name?: string; arguments?: unknown }
}

const reply = (id: Message['id'], result: unknown) => ({ jsonrpc: '2.0', id, result })
const failure = (id: Message['id'], code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })

/** Answers one MCP message, or returns null for a notification. */
export function createMcpHandler(call: (op: BridgeOp, input: unknown) => Promise<unknown>) {
  return async (message: Message): Promise<object | null> => {
    if (message.id === undefined || message.id === null) return null
    const { id } = message
    switch (message.method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'factorix', version: '1.0.0' },
        })
      case 'ping':
        return reply(id, {})
      case 'tools/list':
        return reply(id, { tools: PREVIEW_TOOLS.map(({ op: _op, ...tool }) => tool) })
      case 'tools/call': {
        const tool = PREVIEW_TOOLS.find((candidate) => candidate.name === message.params?.name)
        if (!tool) return failure(id, -32602, `There is no tool called ${String(message.params?.name)}.`)
        try {
          const value = await call(tool.op, message.params?.arguments ?? {})
          return reply(id, { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
        } catch (error) {
          return reply(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true })
        }
      }
      default:
        return failure(id, -32601, `Unknown method ${String(message.method)}.`)
    }
  }
}

/** The stdio MCP server the agent's runtime starts. Every tool call goes over the bridge to the runner, and from there to the worker. */
export async function runMcpServer(path = process.env.FACTORIX_BRIDGE ?? BRIDGE_SOCKET): Promise<void> {
  const handle = createMcpHandler((op, input) => callBridge(path, op, input))
  const pending = new Set<Promise<void>>()
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })) {
    if (!line.trim()) continue
    let message: Message
    try {
      message = JSON.parse(line) as Message
    } catch {
      process.stdout.write(`${JSON.stringify(failure(null, -32700, 'That is not JSON.'))}\n`)
      continue
    }
    const work = handle(message).then((response) => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
    })
    pending.add(work)
    void work.finally(() => pending.delete(work))
  }
  await Promise.all(pending)
}
