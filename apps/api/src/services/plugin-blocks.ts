import {
  type PluginBlock,
  type PluginBlockField,
  type PluginTrigger,
  parsePluginTriggerEvent,
  pluginBlockOptions,
  runPluginBlock,
} from '@factorix/connectors'
import { renderTemplate } from '@factorix/core'
import type { ConnectionRow, Db, OrganizationPluginRow, PluginRow } from '@factorix/db'
import {
  type BlockCatalog,
  type BlockField,
  type BlockSpec,
  integrationBlocks,
  type PluginTriggerInput,
  parsePluginBlockType,
  parsePluginTriggerType,
  pluginBlockType,
  pluginTriggerType,
} from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { badRequest, notFound } from '../lib/errors'
import { endpointOf, manifestOf, pluginAllows } from './plugins'
import type { BlockContext, BlockResult } from './workflow-blocks'
import { fireTrigger } from './workflows'

/** A step a plugin holds fails when the plugin never reports it, so a lost plugin cannot keep a run open forever. */
export const PLUGIN_STEP_TIMEOUT_MS = 7 * 86_400_000

function fieldSpec(field: PluginBlockField): BlockField {
  return {
    key: field.key,
    label: field.label,
    kind: field.kind,
    ...(field.required ? { required: true } : {}),
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(field.hint ? { hint: field.hint } : {}),
    ...(field.options ? { options: field.options } : {}),
    ...(field.dynamic ? { dynamic: true } : {}),
    ...(field.initial !== undefined ? { initial: field.initial } : {}),
  }
}

function specOf(plugin: PluginRow, block: PluginBlock): BlockSpec {
  return {
    category: 'plugin',
    title: block.title,
    description: block.description,
    fields: block.fields.map(fieldSpec),
    outputs: [...block.outputs, { id: 'failed', label: 'Failed', failure: true }],
    provides: block.provides,
    owner: { kind: 'plugin', id: plugin.id, name: plugin.name },
  }
}

function triggerSpecOf(plugin: PluginRow, trigger: PluginTrigger): BlockSpec {
  return {
    category: 'trigger',
    title: trigger.title,
    description: trigger.description,
    fields: trigger.fields.map(fieldSpec),
    outputs: [{ id: 'next', label: 'Next' }],
    provides: trigger.provides,
    owner: { kind: 'plugin', id: plugin.id, name: plugin.name },
    ticketless: true,
  }
}

type UsablePlugin = { plugin: PluginRow; blocks: PluginBlock[]; triggers: PluginTrigger[] }

/** A block is usable while its plugin is on for the organization, still offers it, and may add blocks there. */
async function usablePlugins(db: Db, orgId: string, pluginId?: string): Promise<UsablePlugin[]> {
  const enabled = await db<OrganizationPluginRow>('organization_plugins').where({ orgId, ...(pluginId ? { pluginId } : {}) })
  if (enabled.length === 0) return []
  const plugins = await db<PluginRow>('plugins').whereIn(
    'id',
    enabled.map((row) => row.pluginId),
  )
  return plugins.flatMap((plugin) => {
    const allowed = enabled.find((row) => row.pluginId === plugin.id)
    if (!allowed || !pluginAllows(plugin, allowed, 'workflows:blocks')) return []
    const manifest = manifestOf(plugin)
    return [{ plugin, blocks: manifest.blocks, triggers: manifest.triggers }]
  })
}

/** The blocks the organization can add beyond Factorix's own: those of the integrations it connected and of its plugins. */
export async function blockCatalog(db: Db, orgId: string): Promise<BlockCatalog> {
  const kinds = (await db<ConnectionRow>('connections').where({ orgId }).distinct('kind')).map((row) => row.kind)
  return { ...integrationBlocks(kinds), ...(await pluginBlockCatalog(db, orgId)) }
}

export async function pluginBlockCatalog(db: Db, orgId: string): Promise<BlockCatalog> {
  const catalog: BlockCatalog = {}
  for (const { plugin, blocks, triggers } of await usablePlugins(db, orgId)) {
    for (const trigger of triggers) catalog[pluginTriggerType(plugin.id, trigger.key)] = triggerSpecOf(plugin, trigger)
    for (const block of blocks) catalog[pluginBlockType(plugin.id, block.key)] = specOf(plugin, block)
  }
  return catalog
}

async function pluginBlock(db: Db, orgId: string, type: string): Promise<{ plugin: PluginRow; block: PluginBlock } | null> {
  const parsed = parsePluginBlockType(type)
  if (!parsed) return null
  const [usable] = await usablePlugins(db, orgId, parsed.pluginId)
  const block = usable?.blocks.find((item) => item.key === parsed.key)
  return usable && block ? { plugin: usable.plugin, block } : null
}

export async function pluginFieldOptions(
  deps: Pick<AppDeps, 'db' | 'secrets'>,
  orgId: string,
  type: string,
  field: string,
): Promise<{ value: string; label: string }[]> {
  const parsed = parsePluginBlockType(type) ?? parsePluginTriggerType(type)
  const [usable] = parsed ? await usablePlugins(deps.db, orgId, parsed.pluginId) : []
  const found = usable && [...usable.blocks, ...usable.triggers].find((item) => item.key === parsed?.key)
  if (!usable || !found) throw notFound('Block')
  if (!found.fields.some((item) => item.key === field && item.dynamic)) throw badRequest('That field has no choices to ask for')
  return pluginBlockOptions(endpointOf(deps, usable.plugin), { block: found.key, field, org: { id: orgId } })
}

/**
 * Runs a plugin's block. Templates are filled here, so the plugin receives text and never the workflow's values
 * themselves, and only the fields its block declares.
 */
export async function runPluginBlockStep(context: BlockContext, type: string, workflowName: string): Promise<BlockResult> {
  const { deps, run, nodeId, issue, config, values } = context
  const found = await pluginBlock(deps.db, run.orgId, type)
  if (!found) throw new Error('The plugin behind this block is off, may no longer add blocks, or no longer offers this one.')
  const { plugin, block } = found
  const filled: Record<string, string> = {}
  for (const field of block.fields) {
    const value = config[field.key]
    if (value === undefined || value === null || value === '') continue
    filled[field.key] = field.kind === 'template' || field.kind === 'longTemplate' ? renderTemplate(String(value), values) : String(value)
  }
  const answer = await runPluginBlock(endpointOf(deps, plugin), block, {
    block: block.key,
    plugin: { id: plugin.id },
    org: { id: run.orgId },
    run: { id: run.id, url: String((values.run as { url?: unknown } | undefined)?.url ?? ''), workflowId: run.workflowId, workflowName },
    nodeId,
    config: filled,
    issue: issue && { identifier: issue.identifier, title: issue.title, url: issue.trackerUrl },
  })
  if (answer.wait) return { status: 'wait', wakeAt: new Date(Date.now() + PLUGIN_STEP_TIMEOUT_MS), output: answer.output }
  return { status: 'done', handle: answer.handle, output: answer.output }
}

/** A plugin reporting that one of its triggers happened. It starts only workflows built on that trigger, with no ticket. */
export async function firePluginTrigger(db: Db, pluginId: string, orgId: string, input: PluginTriggerInput): Promise<number> {
  const [usable] = await usablePlugins(db, orgId, pluginId)
  const trigger = usable?.triggers.find((item) => item.key === input.trigger)
  if (!trigger) throw notFound('Trigger')
  return fireTrigger(
    { db },
    {
      orgId,
      type: pluginTriggerType(pluginId, trigger.key),
      data: parsePluginTriggerEvent(trigger, input.data),
      eventId: `plugin:${pluginId}:${input.eventId ?? crypto.randomUUID()}`,
      filters: trigger.fields.map((field) => field.key),
    },
  )
}

export async function pluginBlockOf(db: Db, orgId: string, type: string): Promise<PluginBlock | null> {
  return (await pluginBlock(db, orgId, type))?.block ?? null
}
