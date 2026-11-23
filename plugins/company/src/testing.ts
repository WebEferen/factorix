import { type Agent, FactorixError, factorix, type Member, type Run, type Ticket } from '@moxxy/factorix-plugin-sdk'
import { fakeFactorix } from '@moxxy/factorix-plugin-sdk/testing'
import type { Deps } from './engine'
import type { Definition, Process } from './model'
import { memoryStore } from './store'

export const ORG = 'org-1'
export const PLUGIN = 'plugin-1'
export const ADA: Member = { id: 'account-1', kind: 'person', name: 'Ada', handle: 'ada', role: 'admin', status: 'active' }
export const MO: Member = { id: 'account-2', kind: 'person', name: 'Mo', handle: 'mo', role: 'member', status: 'active' }
export const GONE: Member = { id: 'account-3', kind: 'person', name: 'Lee', handle: 'lee', role: 'member', status: 'disabled' }
export const BOT: Member = { id: 'agent-1', kind: 'agent', name: 'Ops One', handle: 'ops-1', role: 'member', status: 'active' }
export const AGENT: Agent = { id: BOT.id, handle: BOT.handle, name: BOT.name, status: 'active', runtime: 'claude', model: 'claude-opus-5-5' }
export const PROJECT = { id: 'project-1', name: 'Operations' }

/** A Factorix in memory: members, one agent, one project, and runs and tickets the test finishes by hand. */
export function fakeWorld(options: { now?: Date } = {}) {
  const runs = new Map<string, Run & { prompt: string }>()
  const tickets = new Map<string, Ticket & { description: string; agentId: string | null }>()
  const state = { now: options.now ?? new Date('2026-11-23T09:00:00Z'), busy: false, refuse: null as string | null, down: false }
  const reports: Record<string, unknown>[] = []
  const triggers: Record<string, unknown>[] = []
  const guard = (permission: string) => {
    if (state.refuse === permission) throw new FactorixError(403, `Company may not use ${permission} here`)
  }
  const fake = fakeFactorix({
    members: () => {
      guard('members:read')
      return [ADA, MO, GONE, BOT]
    },
    agents: () => [AGENT],
    projects: () => {
      guard('tickets:write')
      return [PROJECT]
    },
    runs: (body) => {
      guard('agents:run')
      if (state.busy) throw new FactorixError(409, 'Company already has 3 runs going. Wait for one to finish')
      const id = `run-${runs.size + 1}`
      const run = {
        id,
        state: 'queued',
        finished: false,
        agentId: String(body.agentId),
        output: null,
        error: null,
        url: `https://factorix.test/runs/${id}`,
        createdAt: state.now.toISOString(),
        finishedAt: null,
        prompt: String(body.prompt),
      }
      runs.set(id, run)
      return run
    },
    run: (body) => {
      const run = runs.get(String(body.runId))
      if (!run) throw new FactorixError(404, 'Run not found')
      return run
    },
    tickets: (body) => {
      guard('tickets:write')
      if (body.projectId !== PROJECT.id) throw new FactorixError(404, 'Project not found')
      const id = `ticket-${tickets.size + 1}`
      const ticket = {
        id,
        identifier: `OPS-${tickets.size + 1}`,
        title: String(body.title),
        url: `https://tracker.test/OPS-${tickets.size + 1}`,
        status: 'Todo',
        statusType: 'unstarted',
        closed: false,
        description: String(body.description ?? ''),
        agentId: body.agentId ? String(body.agentId) : null,
      }
      tickets.set(id, ticket)
      return ticket
    },
    ticket: (body) => {
      const ticket = tickets.get(String(body.ticketId))
      if (!ticket) throw new FactorixError(404, 'Ticket not found')
      return ticket
    },
    'workflow-steps': (body) => {
      if (state.down) throw new Error('Factorix is down')
      reports.push(body)
      return null
    },
    'workflow-triggers': (body) => {
      if (state.down) throw new Error('Factorix is down')
      triggers.push(body)
      return 1
    },
  })
  const store = memoryStore()
  const logs: string[] = []
  const deps: Deps = {
    store,
    factorix: (pluginId) => factorix({ url: 'https://factorix.test', secret: 'test-secret-0123456789', pluginId, fetch: fake.fetch }),
    now: () => state.now,
    log: (message) => logs.push(message),
  }
  const finishRun = (id: string, change: Partial<Run>) => {
    const run = runs.get(id)
    if (run) Object.assign(run, { finished: true, finishedAt: state.now.toISOString(), ...change })
  }
  const closeTicket = (id: string) => {
    const ticket = tickets.get(id)
    if (ticket) Object.assign(ticket, { status: 'Done', statusType: 'completed', closed: true })
  }
  const later = (minutes: number) => {
    state.now = new Date(state.now.getTime() + minutes * 60_000)
  }
  return { deps, store, runs, tickets, reports, triggers, state, calls: fake.calls, logs, finishRun, closeTicket, later }
}

let counter = 0
/** A published process in the store, owned by Ada. */
export async function published(world: ReturnType<typeof fakeWorld>, definition: Definition, fields: Partial<Process> = {}): Promise<Process> {
  counter += 1
  await world.store.rememberPlugin(ORG, PLUGIN)
  const process: Process = {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    orgId: ORG,
    name: 'Purchase request',
    description: '',
    ownerId: ADA.id,
    departmentId: null,
    draft: definition,
    published: definition,
    version: 1,
    archived: false,
    createdAt: world.state.now,
    updatedAt: world.state.now,
    ...fields,
  }
  await world.store.saveProcess(process)
  return process
}
