import type { CanUseTool, HookCallback, ModelInfo, Options, PermissionMode, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  type AgentRuntime,
  type ApprovalRequest,
  AsyncQueue,
  EMPTY_USAGE,
  matchesAnyToolRule,
  type PermissionPolicy,
  RUNTIME_CAPABILITIES,
  type RunControl,
  type RunEventBody,
  type RunnerIO,
  type RunSpec,
  type RuntimeModel,
  type RuntimeModelCatalog,
} from '@factorix/runtime'
import { summarizeInput } from '../truncate'
import { ClaudeNormalizer, classifyError } from './claude-normalize'

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'

export function permissionOptionsFor(policy: PermissionPolicy): Pick<Options, 'permissionMode' | 'allowDangerouslySkipPermissions'> {
  const needsCallback = policy.requireApproval.length > 0
  let permissionMode: PermissionMode
  if (policy.mode === 'edit') permissionMode = 'acceptEdits'
  else permissionMode = needsCallback ? 'default' : 'bypassPermissions'
  return permissionMode === 'bypassPermissions' ? { permissionMode, allowDangerouslySkipPermissions: true } : { permissionMode }
}

export function createCanUseTool(policy: PermissionPolicy, control: Pick<RunControl, 'requestApproval'>): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    if (toolName === 'AskUserQuestion') {
      const decision = await control.requestApproval({ kind: 'question', tool: toolName, input, summary: summarizeQuestion(input) })
      return decision.decision === 'approve'
        ? { behavior: 'allow', updatedInput: (decision.updatedInput as Record<string, unknown> | undefined) ?? input }
        : { behavior: 'deny', message: decision.message ?? 'No answer was given. Continue with your best judgment.' }
    }
    if (matchesAnyToolRule(policy.requireApproval, toolName, input)) {
      const request: ApprovalRequest = { kind: 'tool', tool: toolName, input, summary: summarizeInput(toolName, input) }
      const decision = await control.requestApproval(request)
      return decision.decision === 'approve'
        ? { behavior: 'allow', updatedInput: (decision.updatedInput as Record<string, unknown> | undefined) ?? input }
        : { behavior: 'deny', message: decision.message ?? 'A person rejected this tool call.' }
    }
    if (policy.mode === 'edit' && !matchesAnyToolRule(policy.allow, toolName, input)) {
      return { behavior: 'deny', message: `${toolName} is outside this agent's edit-only policy.` }
    }
    return { behavior: 'allow', updatedInput: input }
  }
}

function summarizeQuestion(input: unknown): string {
  const questions = (input as { questions?: { question?: string }[] } | null)?.questions
  return questions?.map((question) => question.question).join(' / ') || 'The agent has a question'
}

export function createRequireApprovalHook(policy: PermissionPolicy): HookCallback {
  return async (input) => {
    if (input.hook_event_name === 'PreToolUse' && matchesAnyToolRule(policy.requireApproval, input.tool_name, input.tool_input)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'Factorix policy requires a person to approve this call',
        },
      }
    }
    return { continue: true }
  }
}

function userMessage(text: string, sessionId: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: sessionId } as SDKUserMessage
}

export function buildClaudeOptions(spec: RunSpec, control: RunControl, io: RunnerIO, abortController: AbortController): Options {
  const { policy, model } = spec
  return {
    abortController,
    cwd: spec.cwd,
    model: model.name ?? DEFAULT_CLAUDE_MODEL,
    effort: model.reasoningEffort,
    maxTurns: model.maxTurns,
    maxBudgetUsd: model.maxBudgetUsd,
    persistSession: true,
    settingSources: [],
    env: { ...process.env, CLAUDE_CONFIG_DIR: `${io.homeDir}/.claude`, HOME: io.homeDir },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.prompt.system },
    allowedTools: policy.allow,
    disallowedTools: policy.deny,
    includePartialMessages: true,
    thinking: { type: 'adaptive', display: 'summarized' },
    outputFormat: spec.outputSchema ? { type: 'json_schema', schema: spec.outputSchema } : undefined,
    mcpServers: spec.mcpServers,
    canUseTool: createCanUseTool(policy, control),
    hooks: policy.requireApproval.length > 0 ? { PreToolUse: [{ hooks: [createRequireApprovalHook(policy)] }] } : undefined,
    stderr: (data) => process.stderr.write(data),
    ...permissionOptionsFor(policy),
    ...(spec.resume ? { resume: spec.resume.sessionRef } : { sessionId: spec.runId }),
  }
}

/** Rows are aliases like `opus`. Agents pin the wire id they resolve to, so an SDK upgrade cannot silently change an agent's model. */
export function claudeCatalog(rows: ModelInfo[]): RuntimeModelCatalog {
  const models = new Map<string, RuntimeModel>()
  let defaultModel: string | null = null
  for (const row of rows) {
    const id = row.resolvedModel ?? row.value
    if (row.value === 'default') {
      defaultModel = id
      continue
    }
    if (models.has(id)) continue
    const [version, ...details] = row.description.split(' · ')
    models.set(id, {
      id,
      label: details.length > 0 && version ? version : row.displayName,
      description: (details.length > 0 ? details.join(' · ') : row.description) || null,
      efforts: row.supportedEffortLevels ?? [],
    })
  }
  return { defaultModel, models: [...models.values()] }
}

export class ClaudeRuntime implements AgentRuntime {
  readonly id = 'claude' as const

  async listModels(): Promise<RuntimeModelCatalog> {
    const abortController = new AbortController()
    async function* idle(): AsyncGenerator<SDKUserMessage> {
      await new Promise((resolve) => abortController.signal.addEventListener('abort', resolve))
    }
    const session = query({ prompt: idle(), options: { abortController, settingSources: [], persistSession: false } })
    try {
      return claudeCatalog(await session.supportedModels())
    } finally {
      abortController.abort()
    }
  }

  capabilities() {
    return RUNTIME_CAPABILITIES.claude
  }

  async prepare(): Promise<void> {}

  async *run(spec: RunSpec, control: RunControl, io: RunnerIO): AsyncIterable<RunEventBody> {
    const normalizer = new ClaudeNormalizer()
    const abortController = new AbortController()
    const input = new AsyncQueue<SDKUserMessage>()
    const sessionId = spec.resume?.sessionRef ?? spec.runId
    input.push(userMessage(spec.prompt.user, sessionId))

    const onAbort = () => abortController.abort()
    if (control.signal.aborted) onAbort()
    else control.signal.addEventListener('abort', onAbort, { once: true })

    const forwardMessages = (async () => {
      for await (const message of control.messages) input.push(userMessage(message.text, sessionId))
    })()

    let sawDone = false
    try {
      const stream = query({ prompt: input, options: buildClaudeOptions(spec, control, io, abortController) })
      for await (const message of stream) {
        for (const event of normalizer.normalize(message)) {
          if (event.type !== 'done') {
            yield event
            continue
          }
          const queued = (message as { queued_turn_count?: number }).queued_turn_count ?? 0
          if (queued > 0 || input.size > 0) continue
          sawDone = true
          input.close()
          yield event
        }
      }
    } catch (error) {
      if (!control.signal.aborted) {
        const text = error instanceof Error ? error.message : String(error)
        yield { type: 'error', code: normalizer.lastFatalCode ?? classifyError(text), message: text, fatal: true }
        yield { type: 'done', outcome: 'failed', finalText: '', sessionRef: normalizer.sessionRef, usage: EMPTY_USAGE }
        sawDone = true
      }
    } finally {
      control.signal.removeEventListener('abort', onAbort)
      input.close()
      void forwardMessages
    }
    if (!sawDone) {
      const outcome = control.signal.aborted ? 'cancelled' : 'failed'
      yield { type: 'done', outcome, finalText: '', sessionRef: normalizer.sessionRef, usage: EMPTY_USAGE }
    }
  }
}
