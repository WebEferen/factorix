import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import {
  type AgentHelper,
  type AgentRuntime,
  type McpServerSpec,
  type ModelPlanId,
  type ModelUsage,
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
      config[name] = {
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {},
        ...(server.toolTimeoutSec ? { tool_timeout_sec: server.toolTimeoutSec } : {}),
      }
    } else {
      config[name] = { url: server.url, http_headers: server.headers ?? {} }
    }
  }
  return config
}

const PLAN_PROVIDER = 'factorix_plan'

/**
 * A ChatGPT plan is a bearer token for the Responses API, as OpenAI documents it for Codex. The run's token goes in its
 * place and the proxy swaps it, so the CLI never signs in to ChatGPT itself. The plan does not take WebSockets.
 */
export function planProviderConfig(plan: ModelPlanId | undefined, baseUrl: string | undefined): Record<string, ConfigValue> {
  if (plan !== 'chatgpt' || !baseUrl) return {}
  return {
    model_provider: PLAN_PROVIDER,
    model_providers: {
      [PLAN_PROVIDER]: {
        name: 'ChatGPT plan',
        base_url: baseUrl,
        env_key: 'CODEX_API_KEY',
        wire_api: 'responses',
        requires_openai_auth: false,
        supports_websockets: false,
      },
    },
  }
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

/**
 * A helper's one turn. Codex cannot hold a thread to reading only inside a container, so for a helper that may only
 * read, that is an instruction here and not a limit.
 */
export function buildHelperTurn(helper: AgentHelper, task: string): string {
  const readOnly =
    helper.access === 'read' ? '\n\nYou may read and search files. Do not change files, and do not run commands that change anything.' : ''
  return `<operator_instructions>\n${helper.prompt}${readOnly}\n</operator_instructions>\n\n${task}`
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

/** `gpt-6.2-sol` is family `sol` at 6.2, and `gpt-5.5` has no family. */
function versionOf(slug: string): { family: string; version: number[] } | null {
  const parts = slug.split('-').slice(1)
  const version = parts.filter((part) => /^\d{1,3}(?:\.\d{1,3})?$/.test(part)).flatMap((part) => part.split('.').map(Number))
  if (version.length === 0) return null
  return { family: parts.filter((part) => /^[a-z]+$/.test(part)).join('-'), version }
}

/**
 * The CLI knows only the models of its own release and runs a newer one on fallback settings. A catalog file replaces its
 * list, so this is that list with the newer model added as a copy of its family's newest entry, or null when the CLI knows it.
 */
export function catalogWith<T extends CodexCatalogRow>(rows: T[], model: string): T[] | null {
  const wanted = versionOf(model)
  if (!wanted || rows.some((row) => row.slug === model)) return null
  const known = rows.flatMap((row) => {
    const parsed = versionOf(row.slug)
    return parsed ? [{ row, ...parsed }] : []
  })
  const family = known.filter((entry) => entry.family === wanted.family)
  const newest = (family.length > 0 ? family : known).sort(
    (a, b) => (b.version[0] ?? 0) - (a.version[0] ?? 0) || (b.version[1] ?? 0) - (a.version[1] ?? 0),
  )[0]
  return newest ? [{ ...newest.row, slug: model, display_name: model }, ...rows] : null
}

async function bundledRows(io: RunnerIO): Promise<(CodexCatalogRow & Record<string, unknown>)[]> {
  const { stdout } = await promisify(execFile)('codex', ['debug', 'models', '--bundled'], {
    env: { ...process.env, CODEX_HOME: codexHome(io), HOME: io.homeDir },
    maxBuffer: 256 * 1024 * 1024,
  })
  return (JSON.parse(stdout) as { models: (CodexCatalogRow & Record<string, unknown>)[] }).models
}

/** The Codex CLI refuses to start while CODEX_HOME does not exist, and a run's home starts empty. */
export function codexHome(io: Pick<RunnerIO, 'homeDir'>): string {
  const home = `${io.homeDir}/.codex`
  mkdirSync(home, { recursive: true })
  return home
}

export class CodexRuntime implements AgentRuntime {
  readonly id = 'codex' as const

  /** The Codex SDK has no model list, so this asks the CLI it wraps, which is pinned with it. */
  async listModels(io: RunnerIO): Promise<RuntimeModelCatalog> {
    return codexCatalog(await bundledRows(io))
  }

  capabilities() {
    return RUNTIME_CAPABILITIES.codex
  }

  async prepare(): Promise<void> {}

  private readonly helperUsage: Record<string, ModelUsage> = {}

  /** Where a catalog that knows `model` was written, when the CLI does not know it. Without one the run goes on fallback settings. */
  private async catalogFor(io: RunnerIO, model: string | undefined): Promise<string | undefined> {
    if (!model) return undefined
    try {
      const rows = catalogWith(await bundledRows(io), model)
      if (!rows) return undefined
      const path = `${codexHome(io)}/models-${model.replace(/[^\w.-]/g, '_')}.json`
      writeFileSync(path, JSON.stringify({ models: rows }))
      return path
    } catch {
      return undefined
    }
  }

  private async client(io: RunnerIO, model: string | undefined, mcpServers: RunSpec['mcpServers'] = {}, plan?: ModelPlanId): Promise<Codex> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
    env.CODEX_HOME = codexHome(io)
    env.HOME = io.homeDir
    const catalog = await this.catalogFor(io, model)
    const config: Record<string, ConfigValue> = {
      ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServersToConfig(mcpServers) } : {}),
      ...(catalog ? { model_catalog_json: catalog } : {}),
      ...planProviderConfig(plan, process.env.OPENAI_BASE_URL),
    }
    return new Codex({
      env,
      apiKey: process.env.CODEX_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      config: Object.keys(config).length > 0 ? config : undefined,
    })
  }

  /** The SDK has no helpers, so one is a second thread on its own model. It gets no MCP servers, and so cannot delegate further. */
  async runHelper(spec: RunSpec, helper: AgentHelper, task: string, signal: AbortSignal, io: RunnerIO): Promise<string> {
    const model = helper.model ?? spec.model.name
    const thread = (await this.client(io, model, {}, spec.model.plan)).startThread({
      ...buildThreadOptions(spec),
      model,
      modelReasoningEffort: undefined,
    })
    const turn = await thread.run(buildHelperTurn(helper, task), { signal })
    const key = model ?? 'default'
    const spent = this.helperUsage[key] ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const cached = turn.usage?.cached_input_tokens ?? 0
    this.helperUsage[key] = {
      inputTokens: spent.inputTokens + Math.max(0, (turn.usage?.input_tokens ?? 0) - cached),
      outputTokens: spent.outputTokens + (turn.usage?.output_tokens ?? 0),
      cacheReadTokens: spent.cacheReadTokens + cached,
      cacheWriteTokens: spent.cacheWriteTokens,
    }
    return turn.finalResponse
  }

  async *run(spec: RunSpec, control: RunControl, io: RunnerIO): AsyncIterable<RunEventBody> {
    const codex = await this.client(io, spec.model.name, spec.mcpServers, spec.model.plan)
    const options = buildThreadOptions(spec)
    const thread = spec.resume ? codex.resumeThread(spec.resume.sessionRef, options) : codex.startThread(options)
    const normalizer = new CodexNormalizer(spec.model.name, spec.resume?.sessionRef, this.helperUsage)

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
