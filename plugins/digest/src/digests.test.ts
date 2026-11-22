import { describe, expect, it } from 'vitest'
import { NOTHING } from './content'
import { DigestError, saveSchedule, scheduleOf, startDigest, sweep } from './digests'
import { DEFAULT_SCHEDULE, type Schedule } from './store'
import { AGENT, fakeWorld, ticket } from './testing'

const schedule = (fields: Partial<Schedule> = {}): Schedule => ({
  ...DEFAULT_SCHEDULE,
  orgId: 'org-1',
  pluginId: 'plugin-1',
  agentId: AGENT.id,
  ...fields,
})

describe('writing a digest', () => {
  it('asks no agent on a day with nothing to report', async () => {
    const world = fakeWorld()
    const digest = await startDigest(world.deps, schedule())
    expect(digest).toMatchObject({ status: 'ready', runId: null, content: { summary: NOTHING, members: [] } })
    expect(world.runs.size).toBe(0)
  })

  it('hands the agent the facts, then keeps what it wrote as far as the facts go', async () => {
    const world = fakeWorld()
    await world.store.saveSchedule(schedule())
    const doing = ticket({ title: 'Fix the login' })
    world.issues.push(doing)
    const digest = await startDigest(world.deps, schedule())
    expect(digest).toMatchObject({ status: 'writing', runId: 'run-1', runUrl: 'https://factorix.test/runs/run-1' })
    expect(digest.periodStart.toISOString()).toBe('2026-11-17T16:00:00.000Z')
    const run = world.runs.get('run-1')
    expect(run).toMatchObject({ agentId: AGENT.id, outputSchema: { type: 'object' } })
    expect(run?.prompt).toContain(`"identifier":"${doing.identifier}"`)
    await expect(startDigest(world.deps, schedule())).rejects.toThrow(DigestError)

    world.finish('run-1', {
      state: 'succeeded',
      output: {
        summary: 'One moving.',
        members: [
          { name: 'Ada', done: [], inProgress: [`${doing.identifier} in review`], next: [] },
          { name: 'Mallory', done: ['made up'], inProgress: [], next: [] },
        ],
      },
    })
    await sweep(world.deps)
    expect(world.store.rows[0]).toMatchObject({
      status: 'ready',
      content: { summary: 'One moving.', members: [{ name: 'Ada', kind: 'human', inProgress: [`${doing.identifier} in review`] }] },
    })
  })

  it('shows a run that failed, and starts the next one where the last written one ended', async () => {
    const world = fakeWorld()
    await world.store.saveSchedule(schedule())
    world.issues.push(ticket({}))
    const first = await startDigest(world.deps, schedule())
    world.finish(String(first.runId), { state: 'succeeded', output: { summary: 'ok', members: [] } })
    await sweep(world.deps)
    world.state.now = new Date('2026-11-19T16:00:00Z')
    const second = await startDigest(world.deps, schedule())
    expect(second.periodStart).toEqual(first.periodEnd)
    world.finish(String(second.runId), { state: 'failed', error: 'boom' })
    await sweep(world.deps)
    expect(world.store.rows.find((row) => row.id === second.id)).toMatchObject({ status: 'failed', error: 'boom' })
    world.state.now = new Date('2026-11-20T16:00:00Z')
    expect((await startDigest(world.deps, schedule())).periodStart).toEqual(first.periodEnd)
  })

  it('keeps what Factorix refused on the digest, so the page says why', async () => {
    const world = fakeWorld()
    world.state.refused = true
    expect(await startDigest(world.deps, schedule())).toMatchObject({ status: 'failed', error: expect.stringContaining('may not read activity') })
  })

  it('needs an agent', async () => {
    await expect(startDigest(fakeWorld().deps, schedule({ agentId: null }))).rejects.toThrow('Pick the agent')
  })
})

describe('the schedule', () => {
  it('checks what an admin saved and sets the next time', async () => {
    const world = fakeWorld()
    const current = await scheduleOf(world.store, 'org-1', 'plugin-1')
    const input = { enabled: true, days: 'daily', time: '17:00', timezone: 'Europe/Warsaw', agentId: AGENT.id }
    await expect(saveSchedule(world.deps, current, { ...input, agentId: null }, [AGENT])).rejects.toThrow('Pick the agent')
    await expect(saveSchedule(world.deps, current, { ...input, time: '5pm' }, [AGENT])).rejects.toThrow('HH:MM')
    await expect(saveSchedule(world.deps, current, { ...input, timezone: 'Mars' }, [AGENT])).rejects.toThrow('time zone')
    await expect(saveSchedule(world.deps, current, { ...input, agentId: 'agent-9' }, [AGENT])).rejects.toThrow('does not exist')
    const saved = await saveSchedule(world.deps, current, input, [AGENT])
    expect(saved.nextAt?.toISOString()).toBe('2026-11-19T16:00:00.000Z')
    expect(await world.store.schedule('org-1')).toMatchObject({ enabled: true, pluginId: 'plugin-1', agentId: AGENT.id })
    expect((await saveSchedule(world.deps, saved, { ...input, enabled: false }, [AGENT])).nextAt).toBeNull()
  })

  it('writes a due digest once, however often the sweep runs', async () => {
    const world = fakeWorld()
    world.issues.push(ticket({}))
    await world.store.saveSchedule(schedule({ enabled: true, days: 'daily', nextAt: new Date('2026-11-18T15:59:00Z') }))
    await Promise.all([sweep(world.deps), sweep(world.deps)])
    await sweep(world.deps)
    expect(world.runs.size).toBe(1)
    expect((await world.store.schedule('org-1'))?.nextAt?.toISOString()).toBe('2026-11-18T17:00:00.000Z')
  })

  it('turns itself off for an organization that turned the plugin off', async () => {
    const world = fakeWorld()
    world.state.turnedOff = true
    await world.store.saveSchedule(schedule({ enabled: true, nextAt: new Date('2026-11-18T15:00:00Z') }))
    await sweep(world.deps)
    expect(await world.store.schedule('org-1')).toMatchObject({ enabled: false, nextAt: null })
    expect(world.store.rows).toEqual([])
  })
})
