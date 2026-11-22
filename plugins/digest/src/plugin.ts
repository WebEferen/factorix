import { randomBytes } from 'node:crypto'
import { type Agent, definePlugin, type PageContext, type Plugin } from '@moxxylabs/factorix-plugin-sdk'
import { type Deps, DigestError, refreshOrg, saveSchedule, scheduleOf, startDigest } from './digests'
import { NOTICES, renderPage } from './page'

export const VERSION = '0.1.0'
const MAX_DIGESTS = 30

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300)

function html(body: string, nonce: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      // Every piece of tracker and agent text is escaped, and this keeps a slip from running anything.
      'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:; form-action 'self'; base-uri 'none'`,
    },
  })
}

async function render(deps: Deps, context: PageContext, request: Request, token: string): Promise<Response> {
  const orgId = context.org.id
  const pluginId = context.plugin.id
  await deps.store.rememberPlugin(orgId, pluginId)
  // A digest whose run finished shows now, without waiting for the sweep.
  await refreshOrg(deps, orgId, pluginId)
  const url = new URL(request.url)
  const digests = await deps.store.digests(orgId, MAX_DIGESTS)
  const wanted = url.searchParams.get('digest')
  const selected = (wanted ? digests.find((digest) => digest.id === wanted) : undefined) ?? digests[0] ?? null
  const admin = context.account.role === 'admin'
  let agents: Agent[] | null = null
  let agentsError: string | null = null
  if (admin) {
    try {
      agents = await deps.factorix(pluginId).agents(orgId)
    } catch (error) {
      agentsError = messageOf(error)
    }
  }
  const nonce = randomBytes(16).toString('base64')
  return html(
    renderPage({
      token,
      exp: context.exp,
      nonce,
      admin,
      schedule: await scheduleOf(deps.store, orgId, pluginId),
      digests,
      selected,
      agents,
      agentsError,
      notice: NOTICES[url.searchParams.get('notice') ?? ''] ?? null,
      error: url.searchParams.get('error')?.slice(0, 300) ?? null,
    }),
    nonce,
  )
}

/** A form on the page: Write now, or the schedule. Either way the answer is the page again, with what happened. */
async function act(deps: Deps, context: PageContext, request: Request, token: string): Promise<Response> {
  const back = (params: Record<string, string>) =>
    new Response(null, { status: 303, headers: { location: `?${new URLSearchParams({ factorix: token, ...params })}` } })
  if (context.account.role !== 'admin') return back({ error: 'Only an admin of the organization can change the digest' })
  const form = await request.formData()
  const field = (name: string) => String(form.get(name) ?? '').trim()
  const orgId = context.org.id
  const schedule = { ...(await scheduleOf(deps.store, orgId, context.plugin.id)), pluginId: context.plugin.id }
  try {
    if (field('intent') === 'write') {
      const digest = await startDigest(deps, schedule)
      return back({
        digest: digest.id,
        ...(digest.status === 'writing' ? { notice: 'started' } : digest.runId || digest.error ? {} : { notice: 'nothing' }),
      })
    }
    if (field('intent') === 'schedule') {
      const agents = await deps.factorix(context.plugin.id).agents(orgId)
      const input = {
        enabled: field('enabled') === 'on',
        days: field('days'),
        time: field('time'),
        timezone: field('timezone'),
        agentId: field('agentId') || null,
      }
      const saved = await saveSchedule(deps, schedule, input, agents)
      return back({ notice: saved.enabled ? 'saved' : 'off' })
    }
    return back({ error: 'The page sent something it should not have. Open Digest again in the sidebar' })
  } catch (error) {
    if (!(error instanceof DigestError)) deps.log?.(`Digest page action failed for ${orgId}: ${messageOf(error)}`)
    return back({ error: messageOf(error) })
  }
}

export function digestPlugin(deps: Deps): Plugin {
  return definePlugin({
    name: 'Digest',
    version: VERSION,
    description: 'Once a day an agent writes what each person and agent finished, has in progress, and has next, ready to paste into a channel',
    permissions: ['activity:read', 'agents:run'],
    pages: [
      {
        key: 'digest',
        label: 'Digest',
        placement: 'sidebar',
        render: (context, request, token) => render(deps, context, request, token),
        action: (context, request, token) => act(deps, context, request, token),
      },
    ],
  })
}
