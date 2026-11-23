import { describe, expect, it } from 'vitest'
import { plugin } from '../examples/memory-tracker.js'
import { type Migration, migrateDown, migrateUp, type SqlClient } from './migrations.js'
import { createHandler, definePlugin, FactorixError, factorix } from './plugin.js'
import { sign, verify } from './signing.js'
import { checkTracker, factorixClient, fakeFactorix } from './testing.js'

describe('a plugin', () => {
  const client = factorixClient(plugin)

  it('describes itself in a manifest', async () => {
    expect(await client.manifest()).toMatchObject({
      protocol: 1,
      name: 'Memory tracker',
      provides: ['tracker'],
      permissions: [],
      connection: { fields: [{ key: 'owner' }] },
      settings: { fields: [{ key: 'greeting' }] },
      pages: [{ key: 'board', label: 'Demo board', path: '/pages/board', placement: 'sidebar' }],
    })
  })

  it('serves a tracker that does everything Factorix asks of one', async () => {
    await checkTracker(client.tracker({ config: { owner: 'Sam' } }))
    expect((await client.tracker({ config: { owner: 'Sam' } }).viewer()).name).toBe('Sam')
    expect(await client.tracker().listProjects('demo')).toEqual([])
  })

  it('refuses a call that is unsigned, stale, or signed with another secret', async () => {
    const body = JSON.stringify({ protocol: 1, method: 'manifest', params: [], connection: null })
    const send = (timestamp: string, signature: string) =>
      client.handler(
        new Request('http://plugin.test/factorix', {
          method: 'POST',
          headers: { 'x-factorix-timestamp': timestamp, 'x-factorix-signature': signature },
          body,
        }),
      )
    const fresh = String(Date.now())
    const old = String(Date.now() - 10 * 60_000)
    expect((await send(fresh, sign('test-secret-0123456789', fresh, body))).status).toBe(200)
    expect((await send(fresh, sign('another-secret-0123456', fresh, body))).status).toBe(401)
    expect((await send(old, sign('test-secret-0123456789', old, body))).status).toBe(401)
    expect((await send(fresh, '')).status).toBe(401)
    expect(verify('s'.repeat(16), fresh, sign('s'.repeat(16), fresh, body), `${body} `)).toBe(false)
  })

  it('only runs methods of the tracker contract', async () => {
    await expect((client.tracker() as never as { constructor(): Promise<unknown> }).constructor()).rejects.toThrow('Unknown method')
  })

  it('serves a page only to an address Factorix signed for that page', async () => {
    const page = await client.openPage('board', { settings: { greeting: 'Hi <b>' }, account: { id: 'a', name: 'Kim', role: 'member' } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Hi &#60;b&#62;, Kim')
    expect((await client.handler(new Request('http://plugin.test/factorix/pages/board'))).status).toBe(401)
    expect((await client.handler(new Request('http://plugin.test/factorix/pages/board?factorix=abc.def'))).status).toBe(401)
    expect((await client.openPage('board', { exp: Date.now() - 1 })).status).toBe(401)
    expect((await client.openPage('board', { page: 'another' })).status).toBe(401)
  })

  it('needs something to offer and a real secret', () => {
    expect(() => definePlugin({ name: 'Empty', version: '1' })).toThrow('a tracker, a page, or a block')
    expect(() => createHandler(plugin, { secret: 'short' })).toThrow('16 characters')
  })
})

describe('a page with a form', () => {
  const seen: { method: string; role: string; plugin: string; note: string }[] = []
  const forms = definePlugin({
    name: 'Forms',
    version: '1',
    permissions: ['agents:run', 'activity:read', 'agents:run'],
    pages: [
      { key: 'notes', label: 'Notes', render: (context) => `plugin ${context.plugin.id}` },
      {
        key: 'admin',
        label: 'Admin',
        placement: 'settings',
        render: () => 'admin page',
        async action(context, request, token) {
          const form = await request.formData()
          seen.push({ method: request.method, role: context.account.role, plugin: context.plugin.id, note: String(form.get('note')) })
          return new Response(null, { status: 303, headers: { location: `?factorix=${token}` } })
        },
      },
    ],
  })
  const client = factorixClient(forms)

  it('asks for each permission once', () => {
    expect(forms.manifest.permissions).toEqual(['agents:run', 'activity:read'])
  })

  it('tells a page which plugin it is', async () => {
    expect(await (await client.openPage('notes')).text()).toBe('plugin plugin-1')
  })

  it('hands a form post to the page action, signed the same way, and nowhere else', async () => {
    const posted = await client.openPage('admin', { account: { id: 'a', name: 'Kim', role: 'member' } }, { form: { note: 'hello' } })
    expect(posted.status).toBe(303)
    expect(posted.headers.get('location')).toMatch(/^\?factorix=/)
    expect(seen).toEqual([{ method: 'POST', role: 'member', plugin: 'plugin-1', note: 'hello' }])
    expect((await client.openPage('notes', {}, { form: { note: 'x' } })).status).toBe(404)
    const expired = await client.openPage('admin', { exp: Date.now() - 1 }, { form: { note: 'late' } })
    expect(expired.status).toBe(401)
    expect(await expired.text()).toContain('Open Admin again under Integrations, Plugins')
    expect(seen).toHaveLength(1)
  })
})

describe('a plugin with workflow blocks', () => {
  const seen: unknown[] = []
  const blocks = definePlugin({
    name: 'Blocks',
    version: '1',
    blocks: [
      {
        key: 'post',
        title: 'Post a message',
        description: 'Posts to a channel.',
        fields: [
          { key: 'channel', label: 'Channel', kind: 'select', dynamic: true, required: true },
          { key: 'text', label: 'Text', kind: 'template' },
        ],
        outputs: [
          { id: 'sent', label: 'Sent' },
          { id: 'skipped', label: 'Skipped' },
        ],
        provides: [{ key: 'ts', label: 'Message' }],
        run(call) {
          seen.push(call)
          return call.config.text ? { handle: 'sent', output: { ts: '1.2' } } : { handle: 'skipped' }
        },
        options: ({ field, org }) => [{ value: `${org.id}-${field}`, label: '#general' }],
      },
      { key: 'approve', title: 'Wait for approval', description: 'Holds the step.', run: () => ({ wait: true }) },
    ],
    triggers: [
      {
        key: 'posted',
        title: 'Message posted',
        description: 'Someone posted.',
        fields: [{ key: 'channel', label: 'Channel', kind: 'select', dynamic: true }],
        provides: [{ key: 'text', label: 'Text' }],
        options: () => [{ value: 'C1', label: '#ops' }],
      },
    ],
  })
  const client = factorixClient(blocks)

  it('lists its blocks in the manifest and asks for the permission they need', async () => {
    const manifest = await client.manifest()
    expect(manifest.permissions).toEqual(['workflows:blocks'])
    expect(manifest.blocks.map((block) => [block.key, block.outputs.map((output) => output.id)])).toEqual([
      ['post', ['sent', 'skipped']],
      ['approve', ['next']],
    ])
    expect(manifest.blocks[0]).not.toHaveProperty('run')
    expect(manifest.triggers).toEqual([
      {
        key: 'posted',
        title: 'Message posted',
        description: 'Someone posted.',
        fields: [{ key: 'channel', label: 'Channel', kind: 'select', dynamic: true }],
        provides: [{ key: 'text', label: 'Text' }],
      },
    ])
    expect(await client.blockOptions('posted', 'channel')).toEqual([{ value: 'C1', label: '#ops' }])
  })

  it('refuses a trigger that shares a block key or has a field it cannot compare', () => {
    const run = () => ({})
    const trigger = { key: 'post', title: 'x', description: 'x' }
    expect(() => definePlugin({ name: 'Bad', version: '1', blocks: [{ ...trigger, run }], triggers: [trigger] })).toThrow('share the key')
    expect(() =>
      definePlugin({ name: 'Bad', version: '1', triggers: [{ ...trigger, fields: [{ key: 'x', label: 'X', kind: 'template' }] }] }),
    ).toThrow('text or select')
  })

  it('fires a trigger', async () => {
    const fake = fakeFactorix({ 'workflow-triggers': () => 2 })
    const fx = factorix({ url: 'https://fx.test', secret: 'test-secret-0123456789', pluginId: 'plugin-1', fetch: fake.fetch })
    expect(await fx.fireTrigger('org-1', { trigger: 'posted', data: { text: 'Hi' }, eventId: 'e1' })).toBe(2)
    expect(fake.calls[0]?.body).toEqual({ orgId: 'org-1', trigger: 'posted', data: { text: 'Hi' }, eventId: 'e1' })
  })

  it('runs a block with what the workflow gave it, and lists the choices of a dynamic field', async () => {
    expect(await client.runBlock('post', { config: { text: 'Hi' } })).toEqual({ handle: 'sent', output: { ts: '1.2' } })
    expect(await client.runBlock('post')).toEqual({ handle: 'skipped' })
    expect(await client.runBlock('approve')).toEqual({ wait: true })
    expect(seen[0]).toMatchObject({ block: 'post', nodeId: 'post-1', run: { id: 'run-1' }, config: { text: 'Hi' } })
    expect(await client.blockOptions('post', 'channel')).toEqual([{ value: 'org-1-channel', label: '#general' }])
    await expect(client.blockOptions('approve', 'x')).rejects.toThrow('lists no choices')
    await expect(client.runBlock('missing')).rejects.toThrow('no block missing')
  })

  it('refuses a block key Factorix would not take', () => {
    const run = () => ({})
    expect(() => definePlugin({ name: 'Bad', version: '1', blocks: [{ key: 'Post', title: 'x', description: 'x', run }] })).toThrow('lowercase')
    expect(() =>
      definePlugin({
        name: 'Bad',
        version: '1',
        blocks: [{ key: 'post', title: 'x', description: 'x', outputs: [{ id: 'failed', label: 'x' }], run }],
      }),
    ).toThrow('every block has')
  })

  it('finishes a held step', async () => {
    const fake = fakeFactorix({ 'workflow-steps': () => null })
    const fx = factorix({ url: 'https://fx.test', secret: 'test-secret-0123456789', pluginId: 'plugin-1', fetch: fake.fetch })
    await fx.finishStep('org-1', { runId: 'run-1', nodeId: 'approve-1', handle: 'next', output: { by: 'Kim' } })
    expect(fake.calls).toEqual([
      {
        call: 'workflow-steps',
        pluginId: 'plugin-1',
        body: { orgId: 'org-1', runId: 'run-1', nodeId: 'approve-1', handle: 'next', output: { by: 'Kim' } },
      },
    ])
  })
})

describe('calling Factorix', () => {
  const run = { id: 'run-1', state: 'queued', finished: false, agentId: 'agent-1', output: null, error: null, url: 'https://fx.test/runs/run-1' }
  const fake = fakeFactorix({
    activity: (body) => ({ issues: [], merges: [], reports: [], truncated: false, since: body.since }),
    agents: () => [{ id: 'agent-1', handle: 'eng', name: 'Eng', status: 'active', runtime: 'claude', model: null }],
    runs: (body) => ({ ...run, prompt: body.prompt }),
    run: (body) => {
      if (body.runId !== 'run-1') throw new FactorixError(404, 'Run not found')
      return { ...run, state: 'succeeded', finished: true, output: { answer: 'yes' } }
    },
    settings: () => {
      throw new FactorixError(403, 'Not allowed')
    },
    members: () => [{ id: 'account-1', kind: 'person', name: 'Sam', handle: 'sam', role: 'admin', status: 'active' }],
    projects: () => [{ id: 'project-1', name: 'Office' }],
    tickets: (body) => ({
      id: 'ticket-1',
      identifier: 'OFF-1',
      title: body.title,
      url: null,
      status: 'Todo',
      statusType: 'unstarted',
      closed: false,
    }),
    ticket: (body) => {
      if (body.ticketId !== 'ticket-1') throw new FactorixError(404, 'Ticket not found')
      return { id: 'ticket-1', identifier: 'OFF-1', title: 'Order a laptop', url: null, status: 'Done', statusType: 'completed', closed: true }
    },
  })
  const fx = factorix({ url: 'https://fx.test/', secret: 'test-secret-0123456789', pluginId: 'plugin-1', fetch: fake.fetch })

  it('signs each call for one organization and reads the answer', async () => {
    expect(await fx.activity('org-1', new Date('2026-11-17T10:00:00Z'))).toMatchObject({ since: '2026-11-17T10:00:00.000Z' })
    expect((await fx.agents('org-1'))[0]?.handle).toBe('eng')
    expect(await fx.startRun('org-1', { agentId: 'agent-1', prompt: 'Say yes', outputSchema: { type: 'object' } })).toMatchObject({ id: 'run-1' })
    expect((await fx.getRun('org-1', 'run-1')).output).toEqual({ answer: 'yes' })
    expect(fake.calls.map((call) => [call.call, call.pluginId, call.body.orgId])).toEqual([
      ['activity', 'plugin-1', 'org-1'],
      ['agents', 'plugin-1', 'org-1'],
      ['runs', 'plugin-1', 'org-1'],
      ['run', 'plugin-1', 'org-1'],
    ])
    expect(fake.calls[2]?.body).toMatchObject({ agentId: 'agent-1', prompt: 'Say yes', outputSchema: { type: 'object' } })
  })

  it('reads members and projects, and creates and reads a ticket', async () => {
    const before = fake.calls.length
    expect((await fx.members('org-1'))[0]).toMatchObject({ kind: 'person', handle: 'sam' })
    expect(await fx.projects('org-1')).toEqual([{ id: 'project-1', name: 'Office' }])
    expect(await fx.createTicket('org-1', { projectId: 'project-1', title: 'Order a laptop' })).toMatchObject({ identifier: 'OFF-1', closed: false })
    expect(await fx.getTicket('org-1', 'ticket-1')).toMatchObject({ status: 'Done', closed: true })
    await expect(fx.getTicket('org-1', 'ticket-2')).rejects.toMatchObject({ status: 404 })
    expect(fake.calls.slice(before).map((call) => call.call)).toEqual(['members', 'projects', 'tickets', 'ticket', 'ticket'])
    expect(fake.calls[before + 2]?.body).toMatchObject({ orgId: 'org-1', projectId: 'project-1', title: 'Order a laptop' })
  })

  it('says what Factorix refused, with its status', async () => {
    const refused = await fx.settings('org-1').catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(FactorixError)
    expect(refused).toMatchObject({ status: 403, message: 'Factorix answered 403: Not allowed' })
    await expect(fx.getRun('org-1', 'run-2')).rejects.toMatchObject({ status: 404 })
    const forged = factorix({ url: 'https://fx.test', secret: 'another-secret-0123456', pluginId: 'p', fetch: fake.fetch })
    await expect(forged.agents('org-1')).rejects.toMatchObject({ status: 401 })
  })

  it('needs the plugin id for anything but events', async () => {
    const anonymous = factorix({ url: 'https://fx.test', secret: 'test-secret-0123456789', fetch: fake.fetch })
    await expect(anonymous.agents('org-1')).rejects.toThrow('context.plugin.id')
  })
})

describe('migrations', () => {
  function fakeDb() {
    const applied: string[] = []
    const log: string[] = []
    const db: SqlClient = {
      async query(sql, params) {
        log.push(sql)
        if (sql.startsWith('SELECT id FROM')) return { rows: [...applied].sort().map((id) => ({ id })) }
        if (sql.startsWith('INSERT INTO plugin_migrations')) applied.push(String(params?.[0]))
        if (sql.startsWith('DELETE FROM plugin_migrations')) applied.splice(applied.indexOf(String(params?.[0])), 1)
        if (sql === 'boom') throw new Error('syntax error')
        return { rows: [] }
      },
    }
    return { db, applied, log }
  }
  const migrations: Migration[] = [
    { id: '0002_cards', up: 'CREATE TABLE cards ()', down: 'DROP TABLE cards' },
    { id: '0001_boards', up: 'CREATE TABLE boards ()', down: 'DROP TABLE boards' },
  ]

  it('runs what is new in order, once, and rolls back newest first', async () => {
    const { db, applied, log } = fakeDb()
    expect(await migrateUp(db, migrations)).toEqual(['0001_boards', '0002_cards'])
    expect(await migrateUp(db, migrations)).toEqual([])
    expect(log.indexOf('CREATE TABLE boards ()')).toBeLessThan(log.indexOf('CREATE TABLE cards ()'))
    expect(await migrateDown(db, migrations)).toEqual(['0002_cards'])
    expect(applied).toEqual(['0001_boards'])
    expect(log.at(-1)).toContain('pg_advisory_unlock')
  })

  it('rolls a failed migration back and says which one it was', async () => {
    const { db, applied, log } = fakeDb()
    await expect(migrateUp(db, [...migrations, { id: '0003_bad', up: 'boom', down: '' }])).rejects.toThrow('Migration 0003_bad failed: syntax error')
    expect(applied).toEqual(['0001_boards', '0002_cards'])
    expect(log.slice(-2)).toEqual(['ROLLBACK', 'SELECT pg_advisory_unlock(hashtext($1))'])
  })
})
