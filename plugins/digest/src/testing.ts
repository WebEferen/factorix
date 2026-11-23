import { type ActivityIssue, FactorixError, factorix, type Run } from '@moxxy/factorix-plugin-sdk'
import { fakeFactorix } from '@moxxy/factorix-plugin-sdk/testing'
import type { Deps } from './digests'
import { memoryStore } from './store'

export const AGENT = { id: 'agent-1', handle: 'engineer-1', name: 'Eng One', status: 'active', runtime: 'claude', model: 'claude-opus-5-5' }

/** A Factorix in memory: tickets to read, one agent, and runs the test finishes by hand. */
export function fakeWorld(options: { now?: Date } = {}) {
  const issues: ActivityIssue[] = []
  const runs = new Map<string, Run & { prompt: string; outputSchema: unknown }>()
  const state = { turnedOff: false, refused: false, now: options.now ?? new Date('2026-11-18T16:00:00Z') }
  const guard = () => {
    if (state.turnedOff) throw new FactorixError(404, 'Digest is not turned on for this organization')
  }
  const fake = fakeFactorix({
    activity: () => {
      guard()
      if (state.refused) throw new FactorixError(403, 'Digest may not read activity. An admin allows it under Settings, Plugins')
      return { issues, merges: [], reports: [], truncated: false }
    },
    agents: () => {
      guard()
      return [AGENT, { ...AGENT, id: 'agent-2', handle: 'off-1', name: 'Off', status: 'disabled' }]
    },
    runs: (body) => {
      guard()
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
        outputSchema: body.outputSchema,
      }
      runs.set(id, run)
      return run
    },
    run: (body) => {
      const run = runs.get(String(body.runId))
      if (!run) throw new FactorixError(404, 'Run not found')
      return run
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
  const finish = (id: string, change: Partial<Run>) => {
    const run = runs.get(id)
    if (run) Object.assign(run, { finished: true, finishedAt: state.now.toISOString(), ...change })
  }
  return { deps, store, issues, runs, state, calls: fake.calls, logs, finish }
}

let counter = 0
export function ticket(fields: Partial<ActivityIssue>): ActivityIssue {
  counter += 1
  return {
    id: `issue-${counter}`,
    identifier: `ENG-${counter}`,
    title: `Ticket ${counter}`,
    url: `https://linear.app/acme/issue/ENG-${counter}`,
    project: 'Platform',
    priority: 0,
    status: 'In Progress',
    statusType: 'started',
    factoryState: 'untracked',
    assignee: { id: 'u-ada', name: 'Ada' },
    agent: null,
    updatedAt: '2026-11-18T10:00:00Z',
    ...fields,
  }
}
