import { factorixClient } from '@moxxy/factorix-plugin-sdk/testing'
import { describe, expect, it } from 'vitest'
import { companyPlugin } from './plugin'
import { ADA, BOT, fakeWorld, MO, ORG, PROJECT } from './testing'

const MEMBER = { account: { id: MO.id, name: MO.name, role: 'member' } }
const ADMIN = { account: { id: ADA.id, name: ADA.name, role: 'admin' } }

function setup() {
  const world = fakeWorld()
  const client = factorixClient(companyPlugin(world.deps))
  const open = async (query: Record<string, string> = {}, context: object = ADMIN) => {
    const response = await client.openPage('company', context, { query })
    return { response, html: await response.text() }
  }
  /** Posts a form and returns where the plugin sends the page next. */
  const post = async (form: Record<string, string>, context: object = ADMIN) => {
    const response = await client.openPage('company', context, { form })
    expect(response.status).toBe(303)
    const location = new URLSearchParams(String(response.headers.get('location')).slice(1))
    expect(location.get('factorix')).toBeTruthy()
    return Object.fromEntries([...location].filter(([key]) => key !== 'factorix'))
  }
  return { world, client, open, post }
}

describe('the company page', () => {
  it('describes itself as one sidebar page and one workflow block, with what it asks of Factorix', async () => {
    expect(await setup().client.manifest()).toMatchObject({
      name: 'Company',
      provides: [],
      permissions: ['members:read', 'agents:run', 'tickets:write', 'workflows:blocks'],
      pages: [{ key: 'company', label: 'Company', path: '/pages/company', placement: 'sidebar' }],
      blocks: [{ key: 'start_case', outputs: [{ id: 'completed' }, { id: 'rejected' }] }],
      triggers: [{ key: 'case_finished', fields: [{ key: 'process', dynamic: true }, { key: 'status' }] }],
    })
  })

  it('offers the published processes to the block', async () => {
    const { client, post } = setup()
    const id = String((await post({ intent: 'process.create', template: 'purchase' })).process)
    expect(await client.blockOptions('start_case', 'process')).toEqual([])
    await post({ intent: 'process.publish', process: id })
    expect(await client.blockOptions('start_case', 'process')).toEqual([{ value: id, label: 'Purchase request' }])
    expect(await client.blockOptions('case_finished', 'process')).toEqual([{ value: id, label: 'Purchase request' }])
  })

  it("opens on a person's own work, with a policy that runs only its own script", async () => {
    const { world, open } = setup()
    const { response, html } = await open({}, MEMBER)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toMatch(/script-src 'nonce-[^']+'/)
    expect(html).toContain('Nothing waits for you.')
    expect(await world.store.pluginOf(ORG)).toBe('plugin-1')
  })

  it('takes an admin from a starter to a published process, and a member through a case', async () => {
    const { world, open, post } = setup()
    expect((await open({ view: 'processes' })).html).toContain('No process yet')
    expect((await open({ view: 'processes' }, MEMBER)).html).not.toContain('New process')

    const created = await post({ intent: 'process.create', template: 'purchase' })
    expect(created).toMatchObject({ view: 'edit' })
    const id = String(created.process)
    const editor = (await open({ view: 'edit', process: id })).html
    expect(editor).toContain('Not published yet')
    expect(editor).toContain('{{form.amount}}')
    expect(editor).toContain(`<option value="member:${MO.id}">Mo</option>`)
    expect(editor).not.toContain('Lee')
    expect((await open({ view: 'processes' }, MEMBER)).html).toContain('No process yet')

    expect(await post({ intent: 'process.publish', process: id })).toMatchObject({ notice: 'published' })
    expect((await open({ view: 'processes' }, MEMBER)).html).toContain('Purchase request')
    expect((await open({ view: 'start', process: id }, MEMBER)).html).toContain('name="f_amount"')

    const missing = await post({ intent: 'case.start', process: id, f_item: 'A monitor', f_amount: 'lots' }, MEMBER)
    expect(missing).toMatchObject({ view: 'start', error: 'Cost must be a number. Fill in Why it is needed' })
    const started = await post({ intent: 'case.start', process: id, f_item: '<b>A monitor</b>', f_amount: '900', f_reason: 'Mine broke' }, MEMBER)
    expect(started).toMatchObject({ view: 'case', notice: 'started' })
    const caseId = String(started.id)

    const asMember = (await open({ view: 'case', id: caseId }, MEMBER)).html
    expect(asMember).toContain('Waits for Ada')
    expect(asMember).toContain('&lt;b&gt;A monitor&lt;/b&gt;')
    expect(asMember).not.toContain('<b>A monitor</b>')
    expect(asMember).not.toContain('value="approve"')
    expect(asMember).toContain('Cancel case')
    expect(await post({ intent: 'case.decide', id: caseId, decision: 'approve' }, MEMBER)).toMatchObject({
      view: 'case',
      error: 'This step is not waiting for you',
    })

    expect((await open({ view: 'work' })).html).toContain('Approve the purchase, waits for Ada')
    expect((await open({ view: 'case', id: caseId })).html).toContain('value="approve"')
    expect(await post({ intent: 'case.decide', id: caseId, decision: 'approve', note: 'Go' })).toMatchObject({ notice: 'done' })
    expect(await post({ intent: 'case.decide', id: caseId, decision: 'done', note: 'Order 77' }, MEMBER)).toMatchObject({ notice: 'done' })
    expect(await world.store.case(ORG, caseId)).toMatchObject({ status: 'completed' })
    const cases = (await open({ view: 'cases' })).html
    expect(cases).toContain('Completed 1')
    expect(cases).toContain('All 1')
  })

  it('builds a process in the editor: fields, steps, their order, and what stops publishing', async () => {
    const { world, open, post } = setup()
    const id = String((await post({ intent: 'process.create', name: 'Vendor check' })).process)
    await post({ intent: 'field.add', process: id, label: 'Vendor name', type: 'text' })
    await post({ intent: 'field.add', process: id, label: 'Risk', type: 'select' })
    await post({ intent: 'field.save', process: id, field: 'risk', label: 'Risk', type: 'select', options: 'Low, High, Low' })
    await post({ intent: 'step.add', process: id, kind: 'agent', name: 'Research the vendor' })
    await post({ intent: 'step.add', process: id, kind: 'ticket', name: 'File it' })
    await post({ intent: 'step.add', process: id, kind: 'approval', name: 'Sign off' })
    let draft = (await world.store.process(ORG, id))?.draft
    expect(draft?.form).toEqual([
      { key: 'vendor_name', label: 'Vendor name', type: 'text', required: true, options: [] },
      { key: 'risk', label: 'Risk', type: 'select', required: false, options: ['Low', 'High'] },
    ])
    const [research, file, sign] = draft?.steps ?? []
    expect(await post({ intent: 'process.publish', process: id })).toMatchObject({
      error: expect.stringContaining('Pick the agent of "Research the vendor"'),
    })

    const editor = (await open({ view: 'edit', process: id })).html
    expect(editor).toContain('Before it can be published')
    expect(editor).toContain(`<option value="${BOT.id}">Ops One (claude-opus-5-5)</option>`)
    expect(editor).toContain(`<option value="${PROJECT.id}">Operations</option>`)

    await post({
      intent: 'step.save',
      process: id,
      step: String(research?.id),
      name: 'Research',
      dueHours: '4',
      agentId: BOT.id,
      prompt: 'Look up {{form.vendor_name}}',
    })
    await post({
      intent: 'step.save',
      process: id,
      step: String(file?.id),
      name: 'File it',
      projectId: PROJECT.id,
      title: 'Vendor {{form.vendor_name}}',
      wait: 'on',
    })
    await post({
      intent: 'step.save',
      process: id,
      step: String(sign?.id),
      name: 'Sign off',
      assignee: `member:${MO.id}`,
      onReject: String(research?.id),
    })
    await post({ intent: 'step.up', process: id, step: String(sign?.id) })
    draft = (await world.store.process(ORG, id))?.draft
    expect(draft?.steps.map((step) => step.name)).toEqual(['Research', 'Sign off', 'File it'])
    expect(draft?.steps[0]).toMatchObject({ dueHours: 4, agentId: BOT.id, prompt: 'Look up {{form.vendor_name}}' })
    expect(draft?.steps[1]).toMatchObject({ assignee: { kind: 'member', id: MO.id }, onReject: research?.id })
    expect(draft?.steps[2]).toMatchObject({ wait: true, title: 'Vendor {{form.vendor_name}}' })

    await post({ intent: 'step.remove', process: id, step: String(research?.id) })
    expect((await world.store.process(ORG, id))?.draft.steps[0]).toMatchObject({ name: 'Sign off', onReject: 'end' })
    expect(await post({ intent: 'process.publish', process: id })).toMatchObject({ notice: 'published' })
    expect(await world.store.process(ORG, id)).toMatchObject({ version: 1 })

    expect(await post({ intent: 'process.save', process: id, name: 'Vendor check', ownerId: 'nobody' })).toMatchObject({
      error: 'That person is not in this organization',
    })
    expect(await post({ intent: 'process.archive', process: id })).toMatchObject({ view: 'processes', notice: 'archived' })
    expect((await open({ view: 'processes' })).html).toContain('No process yet')
  })

  it('keeps who is in which department, and lets only an admin change it', async () => {
    const { world, open, post } = setup()
    expect(await post({ intent: 'department.save', name: 'Ops' }, MEMBER)).toMatchObject({
      error: 'Only an admin of the organization can change this',
    })
    await post({ intent: 'department.save', name: 'Ops' })
    const [ops] = await world.store.departments(ORG)
    expect(await post({ intent: 'department.save', department: String(ops?.id), name: 'Operations', leadId: BOT.id })).toMatchObject({
      error: 'That person is not in this organization',
    })
    await post({ intent: 'department.save', department: String(ops?.id), name: 'Operations', leadId: MO.id })
    await post({ intent: 'member.place', member: BOT.id, departmentId: String(ops?.id), title: 'Invoice clerk' })
    expect(await post({ intent: 'member.place', member: 'stranger', departmentId: '' })).toMatchObject({
      error: 'That person is not in this organization',
    })

    const { html } = await open({ view: 'company' }, MEMBER)
    expect(html).toContain('Led by Mo')
    expect(html).toContain('Invoice clerk')
    expect(html).not.toContain('<form')
    await post({ intent: 'department.remove', department: String(ops?.id) })
    expect(await world.store.departments(ORG)).toEqual([])
  })

  it('says why a list is empty when the organization did not allow reading it', async () => {
    const { world, open, post } = setup()
    world.state.refuse = 'members:read'
    expect((await open({ view: 'company' })).html).toContain('Factorix did not list the people and agents')
    const id = String((await post({ intent: 'process.create', name: 'X' })).process)
    expect((await open({ view: 'edit', process: id })).html).toContain('Factorix did not list the people')
  })
})
