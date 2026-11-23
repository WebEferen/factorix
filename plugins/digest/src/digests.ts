import { randomUUID } from 'node:crypto'
import { type Agent, type FactorixClient, FactorixError } from '@moxxy/factorix-plugin-sdk'
import { contentFrom, digestPrompt, NOTHING, OUTPUT_SCHEMA } from './content'
import { type DigestFacts, factsFrom } from './facts'
import { type Days, isTimezone, nextScheduleTime, TIME } from './schedule'
import { DEFAULT_SCHEDULE, type Digest, type DigestChange, type Schedule, type Store } from './store'

export interface Deps {
  store: Store
  /** A client for Factorix that calls as the given plugin id. */
  factorix(pluginId: string): FactorixClient
  now?(): Date
  log?(message: string): void
}

const DAY_MS = 86_400_000
/** How far back a digest reaches when the one before it is older than this, or there is none. */
const MAX_PERIOD_MS = 7 * DAY_MS
/** A digest that has no run this long after it was made never got one, because the plugin stopped in between. */
const STARTING_MS = 10 * 60_000

/** Something the person asking can fix, said in words they can act on. */
export class DigestError extends Error {}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500)
/** Factorix answers 404 for an organization that turned the plugin off. */
export const turnedOff = (error: unknown) => error instanceof FactorixError && error.status === 404

export async function scheduleOf(store: Store, orgId: string, pluginId: string): Promise<Schedule> {
  return (await store.schedule(orgId)) ?? { ...DEFAULT_SCHEDULE, orgId, pluginId }
}

/**
 * Reads what happened since the digest before this one and asks the schedule's agent to write it up, in a run with no
 * ticket and no repository. With nothing to report there is no run. What goes wrong on Factorix's side is kept on a
 * failed digest, so the page says why. Throws a `DigestError`, or a 404 when the organization turned the plugin off.
 */
export async function startDigest(deps: Deps, schedule: Schedule): Promise<Digest> {
  const { store } = deps
  const now = deps.now?.() ?? new Date()
  const agentId = schedule.agentId
  if (!agentId) throw new DigestError('Pick the agent that writes the digest first')
  const [latest] = await store.digests(schedule.orgId, 1)
  if (latest?.status === 'writing') throw new DigestError('A digest is being written already')

  // A digest that failed covered nothing, so the next one starts where the last written one ended.
  const written = await store.lastWritten(schedule.orgId)
  const since = written && written.periodEnd.getTime() > now.getTime() - MAX_PERIOD_MS ? written.periodEnd : new Date(now.getTime() - DAY_MS)
  const record = async (fields: Pick<Digest, 'status' | 'facts'> & Partial<Digest>) => {
    const digest: Digest = {
      id: randomUUID(),
      orgId: schedule.orgId,
      runId: null,
      runUrl: null,
      periodStart: since,
      periodEnd: now,
      content: null,
      error: null,
      createdAt: now,
      ...fields,
    }
    await store.insertDigest(digest)
    return digest
  }

  const fx = deps.factorix(schedule.pluginId)
  let facts: DigestFacts
  try {
    facts = factsFrom(await fx.activity(schedule.orgId, since), since)
  } catch (error) {
    if (turnedOff(error)) throw error
    return record({ status: 'failed', facts: { members: [] }, error: messageOf(error) })
  }
  if (facts.members.length === 0) return record({ status: 'ready', facts, content: { summary: NOTHING, members: [] } })

  const digest = await record({ status: 'writing', facts })
  let change: DigestChange
  try {
    const run = await fx.startRun(schedule.orgId, { agentId, prompt: digestPrompt(facts), outputSchema: OUTPUT_SCHEMA })
    change = { runId: run.id, runUrl: run.url }
  } catch (error) {
    change = { status: 'failed', error: messageOf(error) }
  }
  await store.updateDigest(digest.id, change)
  return { ...digest, ...change }
}

/** Reads a digest's run, and once it finished keeps what the agent wrote, as far as it matches the facts it was given. */
export async function checkDigest(deps: Deps, digest: Digest, pluginId: string): Promise<Digest> {
  if (digest.status !== 'writing') return digest
  const now = deps.now?.() ?? new Date()
  let change: DigestChange | null = null
  if (!digest.runId) {
    if (now.getTime() - digest.createdAt.getTime() > STARTING_MS) change = { status: 'failed', error: 'The run never started' }
  } else {
    try {
      const run = await deps.factorix(pluginId).getRun(digest.orgId, digest.runId)
      if (run.state === 'succeeded') {
        const content = contentFrom(run.output, digest.facts)
        change = content ? { status: 'ready', content } : { status: 'failed', error: 'The agent finished without a digest' }
      } else if (run.finished) change = { status: 'failed', error: run.error ?? `The run ended ${run.state}` }
    } catch (error) {
      if (!(error instanceof FactorixError && error.status === 404)) throw error
      change = { status: 'failed', error: 'Factorix no longer has the run' }
    }
  }
  if (!change) return digest
  await deps.store.updateDigest(digest.id, change)
  return { ...digest, ...change }
}

/** Checks every digest of one organization that is being written. A run Factorix cannot answer for stays as it is. */
export async function refreshOrg(deps: Deps, orgId: string, pluginId: string): Promise<void> {
  for (const digest of await deps.store.writing(orgId))
    await checkDigest(deps, digest, pluginId).catch((error) => deps.log?.(`Could not check digest ${digest.id}: ${messageOf(error)}`))
}

/**
 * Writes the digest of every organization whose time has come, and picks up the runs that finished. A time missed
 * while the plugin was down is written once, late.
 */
export async function sweep(deps: Deps): Promise<void> {
  const { store } = deps
  const now = deps.now?.() ?? new Date()
  for (const schedule of await store.dueSchedules(now)) {
    if (!schedule.nextAt || !(await store.claim(schedule.orgId, schedule.nextAt, nextScheduleTime(schedule, now)))) continue
    try {
      await startDigest(deps, schedule)
    } catch (error) {
      if (turnedOff(error)) {
        await store.saveSchedule({ ...schedule, enabled: false, nextAt: null })
        deps.log?.(`Organization ${schedule.orgId} turned the plugin off, so its schedule is off too`)
      } else deps.log?.(`Skipped the digest of ${schedule.orgId}: ${messageOf(error)}`)
    }
  }
  const pluginIds = new Map<string, string | null>()
  for (const digest of await store.writing()) {
    if (!pluginIds.has(digest.orgId)) pluginIds.set(digest.orgId, (await store.schedule(digest.orgId))?.pluginId ?? null)
    const pluginId = pluginIds.get(digest.orgId)
    if (pluginId) await checkDigest(deps, digest, pluginId).catch((error) => deps.log?.(`Could not check digest ${digest.id}: ${messageOf(error)}`))
  }
}

export interface ScheduleInput {
  enabled: boolean
  days: string
  time: string
  timezone: string
  agentId: string | null
}

/** Saves when the digest is written and by which agent, checked against the agents Factorix has. */
export async function saveSchedule(deps: Deps, current: Schedule, input: ScheduleInput, agents: Agent[]): Promise<Schedule> {
  if (input.days !== 'daily' && input.days !== 'weekdays') throw new DigestError('Pick the days')
  if (!TIME.test(input.time)) throw new DigestError('Use 24-hour time, as HH:MM')
  if (!isTimezone(input.timezone)) throw new DigestError('That is not a time zone, try one like Europe/Warsaw')
  if (input.agentId && !agents.some((agent) => agent.id === input.agentId)) throw new DigestError('That agent does not exist')
  if (input.enabled && !input.agentId) throw new DigestError('Pick the agent that writes the digest')
  const schedule: Schedule = {
    ...current,
    enabled: input.enabled,
    days: input.days as Days,
    time: input.time,
    timezone: input.timezone,
    agentId: input.agentId,
    nextAt: null,
  }
  schedule.nextAt = input.enabled ? nextScheduleTime(schedule, deps.now?.() ?? new Date()) : null
  await deps.store.saveSchedule(schedule)
  return schedule
}
