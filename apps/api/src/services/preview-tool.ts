import type { EnvironmentInstanceRow, IssueRow, RunRow } from '@factorix/db'
import type { BridgeOp } from '@factorix/runtime'
import type { SandboxProvider } from '@factorix/sandbox'
import type { EnvironmentDefinition, PreviewLogDto } from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { previewKeys } from '../lib/channels'
import { PREVIEW_DOMAIN } from './environment-runtime'
import { previewAddress } from './preview-spec'
import { previewOf, requestPreview } from './previews'

/** Codex gives an MCP call 60 seconds, so an answer has to come sooner. The agent asks again to keep waiting. */
const WAIT_MS = 45_000
const POLL_MS = 1000
const LOG_LINES = 50
const MAX_LOG_LINES = 200
const WITH_SECRETS = 'This preview runs with the project’s secret values, which agents never see, so you cannot reach it or read its logs.'

type Deps = Pick<AppDeps, 'db' | 'env' | 'redis'> & { sandbox: SandboxProvider }

interface ToolInput {
  run: RunRow
  issue: IssueRow | null
  op: BridgeOp
  input: unknown
  waitMs?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Answers the preview tools an agent calls from its container. It acts as the agent, on its own issue's preview only. */
export async function answerPreviewTool(deps: Deps, request: ToolInput): Promise<unknown> {
  const { run, issue } = request
  if (!issue) throw new Error('This run has no issue, so it has no preview.')
  const args = (request.input ?? {}) as { source?: unknown; wait?: unknown; service?: unknown; lines?: unknown }
  const waitMs = request.waitMs ?? WAIT_MS
  const actor = { kind: 'agent' as const, accountId: run.agentId }
  switch (request.op) {
    case 'preview.start': {
      const source = args.source === 'branch' ? 'branch' : 'worktree'
      const row = await previewOf(deps.db, issue.id)
      if (row?.state === 'stopping') throw new Error('The preview is stopping. Try again in a moment.')
      if (row && row.state !== 'stopped' && row.state !== 'failed' && holdsSecrets(row))
        throw new Error(`${WITH_SECRETS} Call preview_stop first, then preview_start runs one without them.`)
      if (row?.state === 'ready') await requestPreview(deps, issue, 'refresh', actor, { source })
      else if (!row || row.state === 'stopped' || row.state === 'failed') await requestPreview(deps, issue, 'start', actor, { source })
      return status(deps, issue, run, waitMs)
    }
    case 'preview.status':
      return status(deps, issue, run, args.wait === true ? waitMs : 0)
    case 'preview.logs':
      return logs(deps, issue, typeof args.service === 'string' ? args.service : undefined, Number(args.lines) || LOG_LINES)
    case 'preview.stop':
      await requestPreview(deps, issue, 'stop', actor)
      return { state: 'stopping' }
  }
}

async function status(deps: Deps, issue: IssueRow, run: RunRow, waitMs: number): Promise<unknown> {
  const deadline = Date.now() + waitMs
  let row = await previewOf(deps.db, issue.id)
  while (row && (row.state === 'starting' || row.state === 'refreshing') && Date.now() < deadline) {
    await sleep(POLL_MS)
    row = await previewOf(deps.db, issue.id)
  }
  if (!row) return { state: 'none', next: 'Start one with preview_start.' }
  // Messages and errors can carry service output, which could carry a secret value.
  const secret = holdsSecrets(row)
  const reachable = !secret && row.state === 'ready' && run.containerId ? await deps.sandbox.attachToEnvironment(row.slug, run.containerId) : false
  return {
    state: row.state,
    source: row.source,
    commits: row.commits,
    services: Object.fromEntries(
      Object.entries(row.services).map(([name, service]) => [
        name,
        service.message && !secret ? `${service.state}: ${service.message}` : service.state,
      ]),
    ),
    ...(row.error && !secret ? { error: row.error } : {}),
    ...(reachable ? addresses(row) : {}),
    url: previewAddress(deps.env.FACTORIX_PREVIEW_URL, row.slug).url,
    next: secret ? secretStep(row) : nextStep(row, reachable),
  }
}

/**
 * Whether the preview's services got secret values when it last started. Agent-written code may run there, so an agent never reaches
 * it, reads its output, or restarts it. A preview an agent starts gets none.
 */
function holdsSecrets(row: EnvironmentInstanceRow): boolean {
  const definition = row.definition as EnvironmentDefinition | null
  const used = new Set(Object.values(definition?.services ?? {}).flatMap((entry) => entry.secrets))
  return row.secretSets.some((set) => used.has(set.name))
}

function secretStep(row: EnvironmentInstanceRow): string {
  return row.state === 'stopped' || row.state === 'failed'
    ? 'It is not running. preview_start runs it again without the project’s secret values, so you can reach it.'
    : `${WITH_SECRETS} Call preview_stop, then preview_start runs one without them.`
}

/** Where each service answers from the agent's container, and how the public address routes between them. */
function addresses(row: EnvironmentInstanceRow): Record<string, unknown> {
  const definition = row.definition as EnvironmentDefinition | null
  const services = Object.entries(definition?.services ?? {})
  const reach = Object.fromEntries(
    services.flatMap(([name, entry]) => (entry.port ? [[name, `http://${name}.${PREVIEW_DOMAIN}:${entry.port}`]] : [])),
  )
  const expose = definition?.expose
  return {
    reach,
    ...(expose ? { routes: { '/': expose.service, ...Object.fromEntries(expose.paths.map((rule) => [rule.prefix, rule.service])) } } : {}),
  }
}

function nextStep(row: EnvironmentInstanceRow, reachable: boolean): string {
  switch (row.state) {
    case 'starting':
    case 'refreshing':
      return 'Still starting. Call preview_status with wait true, or preview_logs to see how far it got.'
    case 'ready':
      return reachable
        ? 'Reach the services from here at the reach addresses. url is the address people open from the issue page, and it needs their sign-in.'
        : 'It is ready, but this container could not join its network. People can open it from the issue page.'
    case 'failed':
      return 'It failed. preview_logs shows why. Fix the cause, then call preview_start again.'
    default:
      return 'It is not running. Start it with preview_start.'
  }
}

async function logs(deps: Deps, issue: IssueRow, service: string | undefined, lines: number): Promise<string> {
  const row = await previewOf(deps.db, issue.id)
  if (!row) return 'This issue has no preview yet.'
  if (holdsSecrets(row)) throw new Error(WITH_SECRETS)
  const entries = (await deps.redis.lrange(previewKeys.logs(row.slug), 0, -1)).map((line) => JSON.parse(line) as PreviewLogDto)
  const chosen = (service ? entries.filter((entry) => entry.service === service) : entries).slice(-Math.min(Math.max(1, lines), MAX_LOG_LINES))
  if (chosen.length === 0) return service ? `${service} has written nothing yet.` : 'The preview has written nothing yet.'
  return chosen.map((entry) => `${entry.service}: ${entry.text}`).join('\n')
}
