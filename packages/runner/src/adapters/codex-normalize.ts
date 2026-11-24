import { EMPTY_USAGE, estimateCostUsd, estimateRunCostUsd, type ModelUsage, type RunEventBody, type UsageSnapshot } from '@factorix/runtime'
import { truncateOutput } from '../truncate'

interface LooseItem {
  id: string
  type: string
  text?: string
  command?: string
  aggregated_output?: string
  exit_code?: number
  status?: string
  changes?: { path: string; kind: 'add' | 'delete' | 'update' }[]
  server?: string
  tool?: string
  arguments?: unknown
  result?: { content?: { type: string; text?: string }[]; structured_content?: unknown }
  error?: { message: string }
  query?: string
  message?: string
  items?: { text: string; completed: boolean }[]
}

interface LooseEvent {
  type: string
  thread_id?: string
  usage?: {
    input_tokens: number
    cached_input_tokens: number
    cache_write_input_tokens?: number
    output_tokens: number
    reasoning_output_tokens?: number
  }
  error?: { message: string }
  message?: string
  item?: LooseItem
}

export class CodexNormalizer {
  sessionRef: string
  finalText = ''
  failed: string | null = null
  private own: UsageSnapshot = { ...EMPTY_USAGE }
  private readonly started = new Set<string>()
  private readonly model: string | undefined
  private announced = false

  /** `helperUsage` is what helpers spent, by model. They run beside this thread, so it is read each time usage is asked for. */
  constructor(
    model: string | undefined,
    resumeRef?: string,
    private readonly helperUsage: Record<string, ModelUsage> = {},
  ) {
    this.model = model
    this.sessionRef = resumeRef ?? ''
  }

  get usage(): UsageSnapshot {
    const helpers = Object.entries(this.helperUsage)
    if (helpers.length === 0) return this.own
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = this.own
    const byModel: Record<string, ModelUsage> = { [this.model ?? 'default']: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } }
    for (const [model, spent] of helpers) {
      const sum = byModel[model] ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      byModel[model] = {
        inputTokens: sum.inputTokens + spent.inputTokens,
        outputTokens: sum.outputTokens + spent.outputTokens,
        cacheReadTokens: sum.cacheReadTokens + spent.cacheReadTokens,
        cacheWriteTokens: sum.cacheWriteTokens + spent.cacheWriteTokens,
      }
    }
    const total = (key: keyof ModelUsage) => Object.values(byModel).reduce((all, spent) => all + (spent[key] ?? 0), 0)
    const usage: UsageSnapshot = {
      ...this.own,
      inputTokens: total('inputTokens'),
      outputTokens: total('outputTokens'),
      cacheReadTokens: total('cacheReadTokens'),
      cacheWriteTokens: total('cacheWriteTokens'),
      byModel,
    }
    usage.costUsd = estimateRunCostUsd(this.model, usage)
    return usage
  }

  normalize(raw: unknown): RunEventBody[] {
    const event = raw as LooseEvent
    switch (event.type) {
      case 'thread.started':
        this.sessionRef = event.thread_id ?? this.sessionRef
        return this.announce()
      case 'turn.started':
        return this.announce()
      case 'item.started':
        return event.item ? this.itemStarted(event.item) : []
      case 'item.updated':
        return event.item?.type === 'agent_message' && event.item.text
          ? [{ type: 'message', role: 'assistant', text: event.item.text, partial: true, messageId: event.item.id }]
          : []
      case 'item.completed':
        return event.item ? this.itemCompleted(event.item) : []
      case 'turn.completed':
        return this.turnCompleted(event)
      case 'turn.failed':
        this.failed = event.error?.message ?? 'The turn failed'
        return [{ type: 'error', code: 'model', message: this.failed, fatal: true }]
      case 'error':
        this.failed = event.message ?? 'Codex reported an error'
        return [{ type: 'error', code: 'runtime_crash', message: this.failed, fatal: true }]
      default:
        return []
    }
  }

  private announce(): RunEventBody[] {
    if (this.announced || !this.sessionRef) return []
    this.announced = true
    return [{ type: 'run.started', sessionRef: this.sessionRef, runtime: 'codex', model: this.model ?? 'default', tools: [], mcpServers: [] }]
  }

  private itemStarted(item: LooseItem): RunEventBody[] {
    const call = this.callFor(item)
    if (!call) return []
    this.started.add(item.id)
    return [call]
  }

  private callFor(item: LooseItem): RunEventBody | null {
    switch (item.type) {
      case 'command_execution':
        return {
          type: 'tool.call',
          callId: item.id,
          tool: 'Bash',
          category: 'exec',
          input: { command: item.command },
          summary: `Bash ${item.command ?? ''}`.slice(0, 200),
        }
      case 'mcp_tool_call':
        return {
          type: 'tool.call',
          callId: item.id,
          tool: `mcp__${item.server}__${item.tool}`,
          category: 'mcp',
          input: item.arguments,
          summary: `${item.server}.${item.tool}`,
        }
      case 'web_search':
        return {
          type: 'tool.call',
          callId: item.id,
          tool: 'WebSearch',
          category: 'web',
          input: { query: item.query },
          summary: `WebSearch ${item.query ?? ''}`.slice(0, 200),
        }
      default:
        return null
    }
  }

  private itemCompleted(item: LooseItem): RunEventBody[] {
    const events: RunEventBody[] = []
    if (!this.started.has(item.id)) {
      const call = this.callFor(item)
      if (call) events.push(call)
    }
    this.started.delete(item.id)
    switch (item.type) {
      case 'agent_message':
        this.finalText = item.text ?? ''
        events.push({ type: 'message', role: 'assistant', text: this.finalText, messageId: item.id })
        break
      case 'reasoning':
        if (item.text) events.push({ type: 'thinking', text: item.text, messageId: item.id })
        break
      case 'command_execution':
        events.push({
          type: 'tool.result',
          callId: item.id,
          isError: item.status === 'failed' || (item.exit_code ?? 0) !== 0,
          exitCode: item.exit_code,
          ...truncateOutput(item.aggregated_output ?? ''),
        })
        break
      case 'file_change':
        if (item.status === 'completed')
          for (const change of item.changes ?? []) events.push({ type: 'file.change', path: change.path, kind: change.kind, callId: item.id })
        break
      case 'mcp_tool_call':
        events.push({
          type: 'tool.result',
          callId: item.id,
          isError: item.status === 'failed',
          ...truncateOutput(item.error?.message ?? item.result?.content?.map((block) => block.text ?? `[${block.type}]`).join('\n') ?? ''),
        })
        break
      case 'web_search':
        events.push({ type: 'tool.result', callId: item.id, isError: false, output: '' })
        break
      case 'todo_list':
        events.push({
          type: 'log',
          level: 'info',
          source: 'codex',
          message: (item.items ?? []).map((todo) => `${todo.completed ? '[x]' : '[ ]'} ${todo.text}`).join('\n'),
        })
        break
      case 'error':
        events.push({ type: 'error', code: 'tool', message: item.message ?? 'Codex reported an error item', fatal: false })
        break
    }
    return events
  }

  private turnCompleted(event: LooseEvent): RunEventBody[] {
    const usage = event.usage
    const cached = usage?.cached_input_tokens ?? 0
    const next: UsageSnapshot = {
      inputTokens: this.own.inputTokens + Math.max(0, (usage?.input_tokens ?? 0) - cached),
      outputTokens: this.own.outputTokens + (usage?.output_tokens ?? 0),
      cacheReadTokens: this.own.cacheReadTokens + cached,
      cacheWriteTokens: this.own.cacheWriteTokens + (usage?.cache_write_input_tokens ?? 0),
      reasoningTokens: (this.own.reasoningTokens ?? 0) + (usage?.reasoning_output_tokens ?? 0),
      turns: this.own.turns + 1,
    }
    next.costUsd = estimateCostUsd(this.model, next)
    this.own = next
    return [{ type: 'usage', cumulative: true, ...this.usage }]
  }
}

export function parseStructuredOutput(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
