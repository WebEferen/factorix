import { createInterface } from 'node:readline'
import { BRIDGE_SOCKET, type BridgeOp, type RunnerOp } from '@factorix/runtime'
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

type Call = (op: BridgeOp | RunnerOp, input: unknown) => Promise<unknown>

/** Offered only when the run has helpers and the runtime's SDK cannot run them itself. */
async function delegateTool(call: Call): Promise<object | null> {
  const helpers = (await call('helper.list', {})) as { name: string; description: string }[]
  if (helpers.length === 0) return null
  return {
    name: 'delegate',
    description:
      'Hands a task to a helper, a smaller model that works in this same checkout and answers when it is done. ' +
      'Use it for work that does not need you, and say in task everything the helper needs, since it sees nothing else. Helpers:\n' +
      helpers.map((helper) => `- ${helper.name}: ${helper.description}`).join('\n'),
    inputSchema: {
      type: 'object',
      properties: { helper: { type: 'string', enum: helpers.map((helper) => helper.name) }, task: { type: 'string' } },
      required: ['helper', 'task'],
      additionalProperties: false,
    },
  }
}

const BUILT_IN = new Set([...PREVIEW_TOOLS.map((tool) => tool.name), 'delegate'])

/** The tools of the organization's plugins, listed by the worker, which also answers each call by asking the plugin. */
async function pluginTools(call: Call): Promise<object[]> {
  const tools = (await call('tool.list', {})) as { name: string }[]
  return tools.filter((tool) => !BUILT_IN.has(tool.name))
}

interface Message {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: { protocolVersion?: string; name?: string; arguments?: unknown }
}

const reply = (id: Message['id'], result: unknown) => ({ jsonrpc: '2.0', id, result })
const failure = (id: Message['id'], code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })

/** Answers one MCP message, or returns null for a notification. */
export function createMcpHandler(call: Call, groups: string[] = ['preview']) {
  const previews = groups.includes('preview') ? PREVIEW_TOOLS : []
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
      case 'tools/list': {
        const delegate = groups.includes('helpers') ? await delegateTool(call).catch(() => null) : null
        const plugins = groups.includes('plugins') ? await pluginTools(call).catch(() => []) : []
        return reply(id, { tools: [...previews.map(({ op: _op, ...tool }) => tool), ...(delegate ? [delegate] : []), ...plugins] })
      }
      case 'tools/call': {
        const name = message.params?.name
        const tool = previews.find((candidate) => candidate.name === name)
        const op = tool?.op ?? (groups.includes('helpers') && name === 'delegate' ? 'helper.run' : null)
        const plugin = !op && groups.includes('plugins') && typeof name === 'string' && !BUILT_IN.has(name)
        if (!op && !plugin) return failure(id, -32602, `There is no tool called ${String(name)}.`)
        try {
          const value = op
            ? await call(op, message.params?.arguments ?? {})
            : await call('tool.call', { name, input: message.params?.arguments ?? {} })
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
  const handle = createMcpHandler((op, input) => callBridge(path, op, input), (process.env.FACTORIX_TOOLS ?? 'preview').split(','))
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
