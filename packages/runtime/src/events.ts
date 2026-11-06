import type { BridgeOp } from './bridge'
import type { RuntimeId } from './spec'

export type ToolCategory = 'read' | 'search' | 'edit' | 'exec' | 'mcp' | 'web' | 'subagent' | 'other'
export type RunOutcome = 'completed' | 'cancelled' | 'failed' | 'budget_exceeded' | 'max_turns' | 'awaiting_input'
export type ErrorCode = 'auth' | 'rate_limit' | 'model' | 'runtime_crash' | 'tool' | 'policy' | 'timeout' | 'unknown'
export type ApprovalRequestKind = 'tool' | 'plan' | 'question'

export interface UsageSnapshot {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens?: number
  costUsd?: number
  turns: number
}

export const EMPTY_USAGE: UsageSnapshot = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 }

export type RunEventBody =
  | { type: 'run.started'; sessionRef: string; runtime: RuntimeId; model: string; tools: string[]; mcpServers: { name: string; status: string }[] }
  | { type: 'message'; role: 'assistant' | 'user'; text: string; partial?: boolean; messageId: string }
  | { type: 'thinking'; text: string; messageId: string }
  | { type: 'tool.call'; callId: string; tool: string; category: ToolCategory; input: unknown; summary: string }
  | { type: 'tool.result'; callId: string; output: string; isError: boolean; exitCode?: number; truncated?: boolean }
  | { type: 'file.change'; path: string; kind: 'add' | 'update' | 'delete'; callId?: string }
  | { type: 'approval.requested'; approvalId: string; kind: ApprovalRequestKind; tool?: string; input?: unknown; summary: string; options?: string[] }
  | { type: 'approval.resolved'; approvalId: string; decision: 'approve' | 'reject'; by: 'human' | 'policy' | 'timeout' }
  | ({ type: 'usage'; cumulative: true } & UsageSnapshot)
  | { type: 'status'; state: 'running' | 'waiting_approval' | 'cancelling' }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; source?: string }
  | { type: 'error'; code: ErrorCode; message: string; fatal: boolean }
  | { type: 'done'; outcome: RunOutcome; finalText: string; structuredOutput?: unknown; sessionRef: string; usage: UsageSnapshot }
  | { type: 'request'; requestId: string; op: BridgeOp; input: unknown }

export type RunEventType = RunEventBody['type']

export type RunEvent = RunEventBody & { seq: number; ts: string; runId: string }

export function isPartial(event: RunEventBody): boolean {
  return event.type === 'message' && event.partial === true
}
