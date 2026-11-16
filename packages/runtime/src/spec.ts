export type RuntimeId = 'claude' | 'codex' | 'scripted'
export type Phase = 'plan' | 'implement' | 'review' | 'address_review' | 'ad_hoc' | 'task' | 'prompt'
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type JsonSchema = Record<string, unknown>

export type McpServerSpec =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }

export type ToolRule = string

export interface PermissionPolicy {
  mode: 'read_only' | 'edit' | 'full'
  allow: ToolRule[]
  deny: ToolRule[]
  requireApproval: ToolRule[]
  networkAccess: boolean
}

export interface ModelSpec {
  name?: string
  reasoningEffort?: ReasoningEffort
  maxTurns?: number
  maxBudgetUsd?: number
}

/** A helper as an agent's settings keep it. `read` lets it look at files only, and `all` gives it what its agent may use. */
export interface AgentHelper {
  name: string
  description: string
  prompt: string
  model: string | null
  access: 'read' | 'all'
}

/** Tools of a helper that may only read. */
export const HELPER_READ_TOOLS = ['Read', 'Grep', 'Glob']

export interface ScriptedStep {
  sleepMs?: number
  say?: string
  writeFile?: { path: string; content: string }
  exec?: string
  askApproval?: { tool: string; summary: string }
}

export interface ScriptedPlan {
  steps: ScriptedStep[]
  structuredOutput?: unknown
  fail?: { code: 'auth' | 'rate_limit' | 'model' | 'runtime_crash'; message: string }
}

/** Where the runner writes the files attached to the issue. Outside the repositories, so nothing commits them by accident. */
export const ISSUE_FILES_DIR = '/workspace/.factorix/issue-files'

export interface RunFile {
  /** A plain file name, no folders. */
  name: string
  /** Base64. */
  content: string
}

export interface RunSpec {
  runId: string
  attempt: number
  phase: Phase
  cwd: string
  runtime: RuntimeId
  model: ModelSpec
  /** Runs inside this run, in the same container and under the same policy. Only a runtime with `subagents` uses them. */
  helpers?: AgentHelper[]
  prompt: { system: string; user: string }
  mcpServers: Record<string, McpServerSpec>
  policy: PermissionPolicy
  resume?: { sessionRef: string }
  outputSchema?: JsonSchema
  /** Runner sequence numbers continue from here so a resumed container never reuses one. */
  startSeq: number
  /** Written to ISSUE_FILES_DIR before the agent starts, replacing what an earlier run left there. */
  files?: RunFile[]
  scripted?: ScriptedPlan
}
