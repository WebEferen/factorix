import { randomUUID } from 'node:crypto'
import { migrateDown, migrateUp } from '@moxxylabs/factorix-plugin-sdk'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import type { Case, Process } from './model'
import { MIGRATIONS, pgStore, type Store } from './store'
import { TEMPLATES } from './templates'

// The integration project's setup provides it. A plugin never imports Factorix's packages, so the type is declared here.
declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
  }
}

const NAME = `company_store_${randomUUID().slice(0, 8)}`
const NOW = new Date('2026-11-23T09:00:00Z')
const definition = TEMPLATES[0]?.definition as Process['draft']

describe('the Postgres store', () => {
  let admin: pg.Client
  let pool: pg.Pool
  let store: Store

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: inject('databaseUrl') })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${NAME}`)
    const url = new URL(inject('databaseUrl'))
    url.pathname = `/${NAME}`
    pool = new pg.Pool({ connectionString: url.toString() })
    const client = await pool.connect()
    expect(await migrateUp(client, MIGRATIONS)).toEqual(['0001_company'])
    client.release()
    store = pgStore(pool)
  })
  afterAll(async () => {
    await pool?.end()
    await admin?.query(`DROP DATABASE IF EXISTS ${NAME}`)
    await admin?.end()
  })

  const process = (orgId: string, fields: Partial<Process> = {}): Process => ({
    id: randomUUID(),
    orgId,
    name: 'Purchase request',
    description: '',
    ownerId: 'ada',
    departmentId: null,
    draft: definition,
    published: null,
    version: 0,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  })
  const newCase = (item: Process, fields: Partial<Case> = {}): Omit<Case, 'number'> => ({
    id: randomUUID(),
    orgId: item.orgId,
    processId: item.id,
    processName: item.name,
    ownerId: item.ownerId,
    version: 1,
    definition,
    title: 'A monitor',
    status: 'running',
    data: { item: 'A monitor' },
    outputs: {},
    requesterId: 'mo',
    requesterName: 'Mo',
    current: 'approve',
    phase: 'pending',
    assigneeId: null,
    assigneeName: null,
    ref: null,
    refUrl: null,
    stepAt: NOW,
    dueAt: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: null,
    ...fields,
  })

  it('keeps departments, placements, and processes inside their organization', async () => {
    const [a, b] = [randomUUID(), randomUUID()]
    const ops = { id: randomUUID(), orgId: a, name: 'Ops', leadId: 'mo' }
    await store.saveDepartment(ops)
    await store.saveDepartment({ ...ops, orgId: b, name: 'Stolen' })
    expect(await store.departments(a)).toEqual([ops])
    expect(await store.departments(b)).toEqual([])

    await store.savePlacement({ orgId: a, memberId: 'bot', departmentId: ops.id, title: 'Clerk' })
    await store.savePlacement({ orgId: a, memberId: 'bot', departmentId: ops.id, title: 'Invoice clerk' })
    expect(await store.placements(a)).toEqual([{ orgId: a, memberId: 'bot', departmentId: ops.id, title: 'Invoice clerk' }])

    const saved = process(a, { departmentId: ops.id })
    await store.saveProcess(saved)
    await store.saveProcess({ ...saved, published: definition, version: 1 })
    await store.saveProcess({ ...saved, orgId: b, name: 'Stolen' })
    expect(await store.process(a, saved.id)).toMatchObject({ name: 'Purchase request', version: 1, published: definition, departmentId: ops.id })
    expect(await store.process(b, saved.id)).toBeNull()
    expect(await store.process(a, 'not-an-id')).toBeNull()

    await store.removeDepartment(b, ops.id)
    expect(await store.departments(a)).toHaveLength(1)
    await store.removeDepartment(a, ops.id)
    expect(await store.placements(a)).toEqual([{ orgId: a, memberId: 'bot', departmentId: null, title: 'Invoice clerk' }])
    expect(await store.process(a, saved.id)).toMatchObject({ departmentId: null })
    await store.saveProcess({ ...saved, departmentId: null, archived: true })
    expect(await store.processes(a)).toEqual([])
  })

  it('numbers cases per organization and moves one only from where the caller saw it', async () => {
    const orgId = randomUUID()
    const item = process(orgId)
    await store.saveProcess(item)
    await expect(store.insertCase(newCase(item))).rejects.toThrow('has not opened the plugin')
    await store.rememberPlugin(orgId, 'plugin-1')
    await store.rememberPlugin(orgId, 'plugin-2')
    expect(await store.pluginOf(orgId)).toBe('plugin-2')

    const first = await store.insertCase(newCase(item))
    const second = await store.insertCase(newCase(item, { requesterId: 'ada' }))
    expect([first.number, second.number]).toEqual([1, 2])
    expect(first).toMatchObject({ definition, data: { item: 'A monitor' }, stepAt: NOW, phase: 'pending' })
    expect((await store.unsettled()).map((row) => row.id)).toEqual(expect.arrayContaining([first.id, second.id]))

    const later = new Date('2026-11-23T10:00:00Z')
    expect(await store.updateCase(first, { phase: 'todo', assigneeId: 'ada', assigneeName: 'Ada', dueAt: later }, later)).toBe(true)
    expect(await store.updateCase(first, { phase: 'waiting' }, later)).toBe(false)
    const todo = await store.case(orgId, first.id)
    expect(todo).toMatchObject({ phase: 'todo', assigneeId: 'ada', dueAt: later, updatedAt: later })
    expect((await store.cases(orgId, { assigneeId: 'ada', limit: 10 })).map((row) => row.id)).toEqual([first.id])
    expect((await store.cases(orgId, { requesterId: 'ada', limit: 10 })).map((row) => row.id)).toEqual([second.id])
    expect(await store.cases(orgId, { unassigned: true, limit: 10 })).toEqual([])
    expect((await store.unsettled()).map((row) => row.id)).not.toContain(first.id)

    const done = { status: 'completed' as const, current: null, phase: null, outputs: { approve: { decision: 'approved' } }, finishedAt: later }
    expect(await store.updateCase(todo as Case, done, later)).toBe(true)
    expect(await store.case(orgId, first.id)).toMatchObject({ status: 'completed', current: null, phase: null, outputs: done.outputs })
    expect(await store.counts(orgId)).toEqual({ completed: 1, running: 1 })
    expect((await store.cases(orgId, { status: 'completed', limit: 10 })).map((row) => row.number)).toEqual([1])
    expect(await store.case(randomUUID(), first.id)).toBeNull()

    await store.addEvent({ id: randomUUID(), caseId: first.id, orgId, at: NOW, actor: 'Mo', text: 'Started the case' })
    await store.addEvent({ id: randomUUID(), caseId: first.id, orgId, at: later, actor: 'Ada', text: 'Approved' })
    expect((await store.events(orgId, first.id)).map((event) => event.text)).toEqual(['Started the case', 'Approved'])
    expect(await store.events(randomUUID(), first.id)).toEqual([])
  })

  it('rolls its tables back', async () => {
    const client = await pool.connect()
    expect(await migrateDown(client, MIGRATIONS)).toEqual(['0001_company'])
    expect(await migrateUp(client, MIGRATIONS)).toEqual(['0001_company'])
    client.release()
  })
})
