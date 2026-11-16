import type { TrackerConnector, TrackerMedia } from '../tracker'
import {
  PLUGIN_PROTOCOL,
  PLUGIN_SIGNATURE_HEADER,
  PLUGIN_TIMESTAMP_HEADER,
  type PluginConnection,
  type PluginManifest,
  parsePluginManifest,
  signPlugin,
} from './protocol'

export interface PluginEndpoint {
  url: string
  secret: string
}

const TIMEOUT_MS = 30_000
const MAX_ANSWER_BYTES = 8 * 1024 * 1024

/** One signed call. The answer is someone else's data, so it is capped, and whatever is wrong with it surfaces as an error naming the plugin. */
export async function callPlugin(endpoint: PluginEndpoint, method: string, params: unknown[], connection: PluginConnection | null): Promise<unknown> {
  const body = JSON.stringify({ protocol: PLUGIN_PROTOCOL, method, params, connection })
  const timestamp = String(Date.now())
  let response: Response
  try {
    response = await fetch(endpoint.url, {
      method: 'POST',
      // A redirect would send the connection's secrets to an address nobody approved.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        [PLUGIN_TIMESTAMP_HEADER]: timestamp,
        [PLUGIN_SIGNATURE_HEADER]: signPlugin(endpoint.secret, timestamp, body),
      },
      body,
    })
  } catch (error) {
    throw new Error(`The plugin did not answer ${method}: ${(error as Error).message}`)
  }
  const raw = Buffer.from(await response.arrayBuffer())
  if (raw.length > MAX_ANSWER_BYTES) throw new Error(`The plugin's answer to ${method} is too large`)
  let answer: { result?: unknown; error?: { message?: unknown } }
  try {
    answer = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error(`The plugin answered ${method} with ${response.status} and no JSON`)
  }
  if (!response.ok || answer.error)
    throw new Error(String(answer.error?.message ?? `The plugin answered ${method} with ${response.status}`).slice(0, 500))
  return answer.result
}

export async function fetchPluginManifest(endpoint: PluginEndpoint): Promise<PluginManifest> {
  return parsePluginManifest(await callPlugin(endpoint, 'manifest', [], null))
}

const TRACKER_METHODS = [
  'viewer',
  'listTeams',
  'listProjects',
  'listWorkflowStates',
  'listLabels',
  'listIssues',
  'getIssue',
  'listComments',
  'listResources',
  'createIssue',
  'updateIssueState',
  'updateIssueLabels',
  'createLabel',
  'comment',
  'updateComment',
  'registerWebhook',
] as const

type Remote = Pick<TrackerConnector, (typeof TRACKER_METHODS)[number]>

/**
 * A tracker served by a plugin. The endpoint is resolved on the first call, since it lives in the database and a
 * connector is built without waiting.
 */
export function remoteTracker(endpoint: () => Promise<PluginEndpoint>, connection: PluginConnection): TrackerConnector {
  let resolved: Promise<PluginEndpoint> | undefined
  const call = async (method: string, params: unknown[]) => {
    resolved ??= endpoint()
    return callPlugin(await resolved, `tracker.${method}`, params, connection)
  }
  const methods = Object.fromEntries(TRACKER_METHODS.map((method) => [method, (...params: unknown[]) => call(method, params)])) as unknown as Remote
  return {
    kind: 'plugin',
    ...methods,
    // Files would mean streaming bytes through the plugin, which the protocol does not do yet.
    async fetchMedia(): Promise<TrackerMedia | null> {
      return null
    },
  }
}
