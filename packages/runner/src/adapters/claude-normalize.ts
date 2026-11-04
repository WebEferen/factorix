import { EMPTY_USAGE, type ErrorCode, type RunEventBody, type RunOutcome, type ToolCategory, type UsageSnapshot } from '@factorix/runtime'
import { summarizeInput, truncateOutput } from '../truncate'

const CATEGORY_BY_TOOL: Record<string, ToolCategory> = {
  Read: 'read',
  Glob: 'search',
  Grep: 'search',
  LS: 'search',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'exec',
  WebFetch: 'web',
  WebSearch: 'web',
  Agent: 'subagent',
  Task: 'subagent',
}

export function toolCategory(tool: string): ToolCategory {
  if (tool.startsWith('mcp__')) return 'mcp'
  return CATEGORY_BY_TOOL[tool] ?? 'other'
}

const ASSISTANT_ERROR_CODES: Record<string, ErrorCode> = {
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  account_on_hold: 'auth',
  verification_required: 'auth',
  billing_error: 'auth',
  cloud_credential_error: 'auth',
  rate_limit: 'rate_limit',
  overloaded: 'rate_limit',
  invalid_request: 'model',
  model_not_found: 'model',
  max_output_tokens: 'model',
  server_error: 'runtime_crash',
}

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface LooseMessage {
  type: string
  subtype?: string
  session_id?: string
  [key: string]: unknown
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block: ContentBlock) => (block.type === 'text' ? (block.text ?? '') : `[${block.type}]`))
      .filter((text) => text.length > 0)
      .join('\n')
  }
  return content === undefined || content === null ? '' : JSON.stringify(content)
}

function usageFromResult(message: LooseMessage): UsageSnapshot {
  const usage = (message.usage ?? {}) as Record<string, number | undefined>
  const modelUsage = message.modelUsage as Record<string, Record<string, number | undefined>> | undefined
  const totals = modelUsage && Object.keys(modelUsage).length > 0 ? Object.values(modelUsage) : null
  const sum = (key: string, fallback: string) => (totals ? totals.reduce((total, entry) => total + (entry[key] ?? 0), 0) : (usage[fallback] ?? 0))
  return {
    inputTokens: sum('inputTokens', 'input_tokens'),
    outputTokens: sum('outputTokens', 'output_tokens'),
    cacheReadTokens: sum('cacheReadInputTokens', 'cache_read_input_tokens'),
    cacheWriteTokens: sum('cacheCreationInputTokens', 'cache_creation_input_tokens'),
    costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : undefined,
    turns: typeof message.num_turns === 'number' ? message.num_turns : 0,
  }
}

function outcomeForResult(message: LooseMessage): RunOutcome {
  switch (message.subtype) {
    case 'error_max_turns':
      return 'max_turns'
    case 'error_max_budget_usd':
      return 'budget_exceeded'
    case 'success':
      return message.is_error === true ? 'failed' : 'completed'
    default:
      return 'failed'
  }
}

/** Stateful because tool results and streamed deltas only make sense next to what came before them. */
export class ClaudeNormalizer {
  sessionRef = ''
  private readonly tools = new Map<string, { name: string; input: unknown }>()
  private currentMessageId = ''
  private lastAssistantText = ''
  private fatalCode: ErrorCode | null = null

  get lastFatalCode(): ErrorCode | null {
    return this.fatalCode
  }

  normalize(raw: unknown): RunEventBody[] {
    const message = raw as LooseMessage
    if (typeof message.session_id === 'string' && message.session_id) this.sessionRef = message.session_id
    switch (message.type) {
      case 'system':
        return this.system(message)
      case 'stream_event':
        return this.stream(message)
      case 'assistant':
        return this.assistant(message)
      case 'user':
        return this.user(message)
      case 'result':
        return this.result(message)
      default:
        return []
    }
  }

  private system(message: LooseMessage): RunEventBody[] {
    if (message.subtype === 'init') {
      return [
        {
          type: 'run.started',
          sessionRef: this.sessionRef,
          runtime: 'claude',
          model: String(message.model ?? ''),
          tools: (message.tools as string[] | undefined) ?? [],
          mcpServers: ((message.mcp_servers as { name: string; status: string }[] | undefined) ?? []).map(({ name, status }) => ({ name, status })),
        },
      ]
    }
    if (message.subtype === 'api_retry') {
      return [
        {
          type: 'log',
          level: 'warn',
          source: 'claude',
          message: `API retry ${String(message.attempt)}/${String(message.max_retries)} after ${String(message.error)}, status ${String(message.error_status)}`,
        },
      ]
    }
    return []
  }

  private stream(message: LooseMessage): RunEventBody[] {
    const event = message.event as { type?: string; message?: { id?: string }; delta?: { type?: string; text?: string } } | undefined
    if (message.parent_tool_use_id) return []
    if (event?.type === 'message_start' && event.message?.id) this.currentMessageId = event.message.id
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      return [{ type: 'message', role: 'assistant', text: event.delta.text, partial: true, messageId: this.currentMessageId }]
    }
    return []
  }

  private assistant(message: LooseMessage): RunEventBody[] {
    const body = message.message as { id?: string; content?: ContentBlock[] } | undefined
    const messageId = body?.id ?? String(message.uuid ?? '')
    const events: RunEventBody[] = []
    if (typeof message.error === 'string') {
      const code = ASSISTANT_ERROR_CODES[message.error] ?? 'unknown'
      this.fatalCode = code
      events.push({ type: 'error', code, message: `Claude reported ${message.error}`, fatal: false })
    }
    for (const block of body?.content ?? []) {
      if (block.type === 'text' && block.text) {
        if (!message.parent_tool_use_id) this.lastAssistantText = block.text
        events.push({ type: 'message', role: 'assistant', text: block.text, messageId })
      } else if (block.type === 'thinking' && block.thinking) {
        events.push({ type: 'thinking', text: block.thinking, messageId })
      } else if (block.type === 'tool_use' && block.id && block.name) {
        this.tools.set(block.id, { name: block.name, input: block.input })
        events.push({
          type: 'tool.call',
          callId: block.id,
          tool: block.name,
          category: toolCategory(block.name),
          input: block.input,
          summary: summarizeInput(block.name, block.input),
        })
      }
    }
    return events
  }

  private user(message: LooseMessage): RunEventBody[] {
    const body = message.message as { content?: ContentBlock[] | string } | undefined
    if (!Array.isArray(body?.content)) return []
    const events: RunEventBody[] = []
    for (const block of body.content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      const isError = block.is_error === true
      events.push({ type: 'tool.result', callId: block.tool_use_id, isError, ...truncateOutput(toolResultText(block.content)) })
      const call = this.tools.get(block.tool_use_id)
      if (!isError && call && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(call.name)) {
        const input = (call.input ?? {}) as { file_path?: string; notebook_path?: string }
        const path = input.file_path ?? input.notebook_path
        if (path) events.push({ type: 'file.change', path, kind: call.name === 'Write' ? 'add' : 'update', callId: block.tool_use_id })
      }
      this.tools.delete(block.tool_use_id)
    }
    return events
  }

  private result(message: LooseMessage): RunEventBody[] {
    const usage = usageFromResult(message)
    const outcome = outcomeForResult(message)
    const events: RunEventBody[] = [{ type: 'usage', cumulative: true, ...usage }]
    const errors = Array.isArray(message.errors) ? (message.errors as string[]) : []
    const resultText = typeof message.result === 'string' ? message.result : ''
    if (outcome === 'failed') {
      const detail = errors.join('; ') || resultText || 'The run ended with an error'
      events.push({ type: 'error', code: this.fatalCode ?? classifyError(detail), message: detail, fatal: true })
    }
    events.push({
      type: 'done',
      outcome,
      finalText: resultText || this.lastAssistantText,
      structuredOutput: message.structured_output,
      sessionRef: this.sessionRef,
      usage,
    })
    return events
  }
}

export function classifyError(message: string): ErrorCode {
  const text = message.toLowerCase()
  if (/\b(401|403|unauthorized|invalid api key|authentication|not logged in|api key)\b/.test(text)) return 'auth'
  if (/\b(429|rate.?limit|overloaded|529)\b/.test(text)) return 'rate_limit'
  if (/\b(timeout|timed out)\b/.test(text)) return 'timeout'
  return 'unknown'
}

export const NO_USAGE = EMPTY_USAGE
