import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { promisify } from 'node:util'
import {
  type AgentRuntime,
  type McpServerSpec,
  type ReasoningEffort,
  RUNTIME_CAPABILITIES,
  type RunControl,
  type RunEventBody,
  type RunnerIO,
  type RunOutcome,
  type RunSpec,
  type RuntimeModelCatalog,
} from '@factorix/runtime'
import { Codex, type ModelReasoningEffort, type ThreadOptions } from '@openai/codex-sdk'
import { CodexNormalizer, parseStructuredOutput } from './codex-normalize'

type ConfigValue = string | number | boolean | ConfigValue[] | { [key: string]: ConfigValue }

export function mcpServersToConfig(servers: Record<string, McpServerSpec>): Record<string, ConfigValue> {
  const config: Record<string, ConfigValue> = {}
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === 'stdio') {
      config[name] = { command: server.command, args: server.args ?? [], env: server.env ?? {} }
    } else {
      config[name] = { url: server.url, http_headers: server.headers ?? {} }
    }
  }
  return config
}

export function buildThreadOptions(spec: RunSpec): ThreadOptions {
  return {
    model: spec.model.name,
    modelReasoningEffort: spec.model.reasoningEffort as ModelReasoningEffort | undefined,
    workingDirectory: spec.cwd,
    skipGitRepoCheck: true,
    // Codex's own Landlock sandbox does not reliably initialize inside a container. The container and its read-only mount are the boundary.
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    networkAccessEnabled: spec.policy.networkAccess,
    webSearchMode: 'disabled',
  }
}

export function buildFirstTurn(spec: RunSpec): string {
  const denied = spec.policy.deny.length > 0 ? `\n\nDo not use these tools or commands: ${spec.policy.deny.join(', ')}.` : ''
  return `<operator_instructions>\n${spec.prompt.system}${denied}\n</operator_instructions>\n\n${spec.prompt.user}`
}

interface CodexCatalogRow {
  slug: string
  display_name: string
  description?: string | null
  visibility?: string
  supported_in_api?: boolean
  priority?: number
  supported_reasoning_levels?: { effort: string }[]
}

const KNOWN_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Runs authenticate with an API key, so models the catalog marks as unavailable there would only fail later. */
export function codexCatalog(rows: CodexCatalogRow[]): RuntimeModelCatalog {
  const models = rows
    .filter((row) => row.visibility === 'list' && row.supported_in_api !== false)
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
    .map((row) => ({
      id: row.slug,
      label: row.display_name,
      description: row.description || null,
      efforts: KNOWN_EFFORTS.filter((effort) => row.supported_reasoning_levels?.some((level) => level.effort === effort)),
    }))
  return { defaultModel: null, models }
}

export class CodexRuntime implements AgentRuntime {
  readonly id = 'codex' as const

  /** The Codex SDK has no model list, so this asks the CLI it wraps, which is pinned with it. */
  async listModels(io: RunnerIO): Promise<RuntimeModelCatalog> {
    const home = `${io.homeDir}/.codex`
    mkdirSync(home, { recursive: true })
    const { stdout } = await promisify(execFile)('codex', ['debug', 'models', '--bundled'], {
      env: { ...process.env, CODEX_HOME: home, HOME: io.homeDir },
      maxBuffer: 256 * 1024 * 1024,
    })
    return codexCatalog((JSON.parse(stdout) as { models: CodexCatalogRow[] }).models)
  }

  capabilities() {
    return RUNTIME_CAPABILITIES.codex
  }

  async prepare(): Promise<void> {}

  async *run(spec: RunSpec, control: RunControl, io: RunnerIO): AsyncIterable<RunEventBody> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
    env.CODEX_HOME = `${io.homeDir}/.codex`
    env.HOME = io.homeDir

    const codex = new Codex({
      env,
      apiKey: process.env.CODEX_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      config: Object.keys(spec.mcpServers).length > 0 ? { mcp_servers: mcpServersToConfig(spec.mcpServers) } : undefined,
    })
    const options = buildThreadOptions(spec)
    const thread = spec.resume ? codex.resumeThread(spec.resume.sessionRef, options) : codex.startThread(options)
    const normalizer = new CodexNormalizer(spec.model.name, spec.resume?.sessionRef)

    const pending: string[] = [buildFirstTurn(spec)]
    const forward = (async () => {
      for await (const message of control.messages) pending.push(message.text)
    })()

    let outcome: RunOutcome = 'completed'
    try {
      while (pending.length > 0 && outcome === 'completed') {
        const prompt = pending.shift() as string
        const { events } = await thread.runStreamed(prompt, { outputSchema: spec.outputSchema, signal: control.signal })
        for await (const event of events) {
          yield* normalizer.normalize(event)
          if (normalizer.failed) {
            outcome = 'failed'
            break
          }
          if (event.type === 'turn.completed') {
            if (spec.model.maxTurns !== undefined && normalizer.usage.turns >= spec.model.maxTurns) outcome = 'max_turns'
            const cost = normalizer.usage.costUsd
            if (spec.model.maxBudgetUsd !== undefined && cost !== undefined && cost >= spec.model.maxBudgetUsd) outcome = 'budget_exceeded'
          }
        }
      }
    } catch (error) {
      if (control.signal.aborted) {
        outcome = 'cancelled'
      } else {
        outcome = 'failed'
        const message = error instanceof Error ? error.message : String(error)
        yield { type: 'error', code: 'runtime_crash', message, fatal: true }
      }
    }
    void forward

    yield {
      type: 'done',
      outcome: control.signal.aborted ? 'cancelled' : outcome,
      finalText: normalizer.finalText,
      structuredOutput: spec.outputSchema ? parseStructuredOutput(normalizer.finalText) : undefined,
      sessionRef: thread.id ?? normalizer.sessionRef,
      usage: normalizer.usage,
    }
  }
}
