import { type PluginTool, runPluginTool } from '@factorix/connectors'
import type { Db, IssueRow, OrganizationPluginRow, PluginRow, ProjectRow, RunRow } from '@factorix/db'
import type { BridgeOp } from '@factorix/runtime'
import type { AppDeps } from '../deps'
import { endpointOf, manifestOf, pluginAllows } from './plugins'
import { readSettings } from './settings'
import type { AgentSnapshot } from './spec'

type Deps = Pick<AppDeps, 'db' | 'env' | 'secrets'>

export interface AgentPluginTool {
  /** What the agent calls it: the plugin's name, then the tool's key, as an MCP tool name allows. */
  name: string
  plugin: PluginRow
  tool: PluginTool
}

const MAX_INPUT_BYTES = 64 * 1024

function toolName(plugin: string, key: string): string {
  const prefix =
    plugin
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20) || 'plugin'
  return `${prefix}_${key}`
}

/**
 * The tools a run's agent gets from plugins: those of each plugin its organization turned on and allowed `agents:tools`.
 * A call leaves the container through the worker to the plugin, so a project whose network policy is None gets none.
 */
export async function pluginToolsFor(db: Db, run: RunRow, project: ProjectRow | null): Promise<AgentPluginTool[]> {
  if (project?.networkPolicy === 'none') return []
  const enabled = await db<OrganizationPluginRow>('organization_plugins').where({ orgId: run.orgId })
  if (enabled.length === 0) return []
  const plugins = await db<PluginRow>('plugins')
    .whereIn(
      'id',
      enabled.map((row) => row.pluginId),
    )
    .where((query) => query.whereNull('orgId').orWhere({ orgId: run.orgId }))
    .orderBy([{ column: 'createdAt' }, { column: 'id' }])
  const tools: AgentPluginTool[] = []
  for (const plugin of plugins) {
    const allowed = enabled.find((row) => row.pluginId === plugin.id)
    if (!allowed || !pluginAllows(plugin, allowed, 'agents:tools')) continue
    const manifest = manifestOf(plugin)
    for (const tool of manifest.tools) {
      const name = toolName(manifest.name, tool.key)
      // Two plugins can end up with one name, and the one installed first keeps it.
      if (!tools.some((other) => other.name === name)) tools.push({ name, plugin, tool })
    }
  }
  return tools
}

/** Answers `tool.list` and `tool.call` from the factorix MCP server. Each call checks again that the tool is still offered. */
export async function answerPluginTool(
  deps: Deps,
  request: { run: RunRow; issue: IssueRow | null; project: ProjectRow | null; op: BridgeOp; input: unknown },
): Promise<unknown> {
  const { run, issue } = request
  const tools = await pluginToolsFor(deps.db, run, request.project)
  if (request.op === 'tool.list') return tools.map(({ name, tool }) => ({ name, description: tool.description, inputSchema: tool.inputSchema }))
  const { name, input = {} } = (request.input ?? {}) as { name?: unknown; input?: unknown }
  const found = tools.find((tool) => tool.name === name)
  if (!found) throw new Error(`There is no tool called ${String(name)}. Its plugin may have been turned off.`)
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${found.name} takes an object as its input`)
  if (JSON.stringify(input).length > MAX_INPUT_BYTES) throw new Error(`The input to ${found.name} is larger than 64 KB`)
  const agent = run.agentSnapshot as unknown as AgentSnapshot
  return runPluginTool(endpointOf(deps, found.plugin), {
    tool: found.tool.key,
    plugin: { id: found.plugin.id },
    org: { id: run.orgId },
    agent: { id: run.agentId, handle: agent.handle },
    run: { id: run.id, url: `${(await readSettings(deps)).publicUrl}/runs/${run.id}` },
    issue: issue && { identifier: issue.identifier, title: issue.title, url: issue.trackerUrl },
    input: input as Record<string, unknown>,
  })
}
