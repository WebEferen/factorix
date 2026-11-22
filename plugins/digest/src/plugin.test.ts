import { factorixClient } from '@moxxylabs/factorix-plugin-sdk/testing'
import { describe, expect, it } from 'vitest'
import { digestPlugin } from './plugin'
import { AGENT, fakeWorld, ticket } from './testing'

const MEMBER = { account: { id: 'account-2', name: 'Mo', role: 'member' } }
const SCHEDULE = { intent: 'schedule', enabled: 'on', days: 'daily', time: '17:00', timezone: 'Europe/Warsaw', agentId: AGENT.id }

function setup() {
  const world = fakeWorld()
  const client = factorixClient(digestPlugin(world.deps))
  const open = async (context = {}, query: Record<string, string> = {}) => {
    const response = await client.openPage('digest', context, { query })
    return { response, html: await response.text() }
  }
  const post = (form: Record<string, string>, context = {}) => client.openPage('digest', context, { form })
  return { world, client, open, post }
}

describe('the digest page', () => {
  it('describes itself as a sidebar page that reads activity and runs agents', async () => {
    expect(await setup().client.manifest()).toMatchObject({
      name: 'Digest',
      provides: [],
      permissions: ['activity:read', 'agents:run'],
      pages: [{ key: 'digest', label: 'Digest', path: '/pages/digest', placement: 'sidebar' }],
    })
  })

  it('shows a member the digests and nothing to change', async () => {
    const { world, open } = setup()
    const { response, html } = await open(MEMBER)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toMatch(/script-src 'nonce-[^']+'/)
    expect(html).toContain('No digest yet')
    expect(html).not.toContain('<form')
    expect(await world.store.schedule('org-1')).toMatchObject({ pluginId: 'plugin-1', enabled: false })
    expect(world.calls.map((call) => call.call)).toEqual([])
  })

  it('lets an admin set the schedule from the agents Factorix lists', async () => {
    const { world, open, post } = setup()
    const { html } = await open()
    expect(html).toContain('id="schedule" class="panel card">')
    expect(html).toContain(`<option value="${AGENT.id}">Eng One (claude-opus-5-5)</option>`)
    expect(html).not.toContain('agent-2')

    const saved = await post(SCHEDULE)
    expect(saved.status).toBe(303)
    const location = new URLSearchParams(String(saved.headers.get('location')).slice(1))
    expect(location.get('notice')).toBe('saved')
    expect(location.get('factorix')).toBeTruthy()
    expect(await world.store.schedule('org-1')).toMatchObject({ enabled: true, timezone: 'Europe/Warsaw', agentId: AGENT.id, pluginId: 'plugin-1' })
    expect((await open({}, { notice: 'saved' })).html).toContain('Every day at 17:00 (Europe/Warsaw), next on')

    const refused = await post({ ...SCHEDULE, time: 'noon' })
    expect(new URLSearchParams(String(refused.headers.get('location')).slice(1)).get('error')).toContain('HH:MM')
  })

  it('refuses a member who posts the form anyway', async () => {
    const { world, post } = setup()
    const response = await post(SCHEDULE, MEMBER)
    expect(response.headers.get('location')).toContain('error=Only+an+admin')
    expect(await world.store.schedule('org-1')).toBeNull()
  })

  it('writes now, waits for the run, and shows what the agent wrote, escaped', async () => {
    const { world, open, post } = setup()
    await post(SCHEDULE)
    const doing = ticket({ title: 'Fix <b>login</b>' })
    world.issues.push(doing)

    const written = await post({ intent: 'write' })
    const location = new URLSearchParams(String(written.headers.get('location')).slice(1))
    expect(location.get('notice')).toBe('started')
    const writing = await open({}, Object.fromEntries(location))
    expect(writing.html).toContain('The agent is writing this digest')
    expect(writing.html).toContain('href="https://factorix.test/runs/run-1" target="_blank"')
    expect(writing.html).toMatch(/data-writing="[0-9a-f-]{36}"/)
    expect(writing.html).toContain('Write now</button>')
    expect(writing.html).toMatch(/primary" disabled>Write now/)

    world.finish('run-1', {
      state: 'succeeded',
      output: {
        summary: 'Ada is on <script>alert(1)</script>.',
        members: [{ name: 'Ada', done: [], inProgress: [`${doing.identifier} moved to review`], next: [] }],
      },
    })
    const ready = await open()
    expect(ready.html).not.toContain('data-writing')
    expect(ready.html).toContain('Ada is on &lt;script&gt;alert(1)&lt;/script&gt;.')
    expect(ready.html).not.toContain('<script>alert(1)')
    expect(ready.html).toContain(`<a href="${doing.url}" target="_blank" rel="noreferrer">${doing.identifier}</a> moved to review`)
    const copies = JSON.parse(String(/<script type="application\/json" id="copies">(.*?)<\/script>/s.exec(ready.html)?.[1]))
    expect(copies[0].text).toContain(`• ${doing.identifier} moved to review`)
    expect(copies).toHaveLength(2)
  })

  it('says why a digest failed', async () => {
    const { world, open, post } = setup()
    await post(SCHEDULE)
    world.issues.push(ticket({}))
    await post({ intent: 'write' })
    world.finish('run-1', { state: 'failed', error: 'The model ran out of turns' })
    const { html } = await open()
    expect(html).toContain('The agent did not finish this digest.')
    expect(html).toContain('The model ran out of turns')
  })

  it('opens an older digest from the picker', async () => {
    const { world, open, post } = setup()
    await post(SCHEDULE)
    const first = new URLSearchParams(String((await post({ intent: 'write' })).headers.get('location')).slice(1)).get('digest')
    world.state.now = new Date('2026-11-19T16:00:00Z')
    await post({ intent: 'write' })
    const { html } = await open({}, { digest: String(first) })
    expect(html).toContain(`<option value="${first}" selected>`)
    expect(html).toContain('<h2>Wednesday, November 18</h2>')
  })

  it('asks for the page again once its link expired', async () => {
    const { post } = setup()
    const response = await post({ intent: 'write' }, { exp: Date.now() - 1 })
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('Open Digest again in the sidebar')
  })
})
