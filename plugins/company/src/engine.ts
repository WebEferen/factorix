import { randomUUID } from 'node:crypto'
import { type BlockAnswer, type BlockCall, type FactorixClient, FactorixError, type Member } from '@moxxy/factorix-plugin-sdk'
import {
  type Assignee,
  agentPrompt,
  type Case,
  fill,
  formLines,
  type Process,
  readForm,
  type Step,
  type StepOutput,
  stepOf,
  templateValues,
} from './model'
import type { CaseChange, Store } from './store'

export interface Deps {
  store: Store
  /** A client for Factorix that calls as the given plugin id. */
  factorix(pluginId: string): FactorixClient
  now?(): Date
  log?(message: string): void
}

export interface Actor {
  id: string
  name: string
  admin: boolean
}

/** Something the person asking can fix, said in words they can act on. */
export class CompanyError extends Error {}

const HOUR_MS = 3_600_000
/** How a case a workflow started names who asked for it. Nobody signs in as a workflow, so its steps go to the owner. */
const WORKFLOW_ACTOR = 'workflow:'
/** A step that asked Factorix for a run or a ticket and has neither this long after never got one, because the plugin stopped in between. */
const ENTERING_MS = 10 * 60_000
/** How long a step keeps asking while Factorix says the plugin has too many runs going. */
const BUSY_MS = 30 * 60_000
const MAX_OUTPUT = 20_000
const SYSTEM = 'Factorix'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500)
const nowOf = (deps: Deps) => deps.now?.() ?? new Date()

async function note(deps: Deps, item: Case, actor: string, text: string): Promise<void> {
  await deps.store.addEvent({ id: randomUUID(), caseId: item.id, orgId: item.orgId, at: nowOf(deps), actor, text })
}

/** Applies a change if the case is still where the caller saw it. Returns the case as it is now, or nothing when someone else moved it first. */
async function move(deps: Deps, item: Case, change: CaseChange): Promise<Case | null> {
  const now = nowOf(deps)
  return (await deps.store.updateCase(item, change, now)) ? { ...item, ...change, updatedAt: now } : null
}

const CLEARED: CaseChange = { assigneeId: null, assigneeName: null, ref: null, refUrl: null, dueAt: null, error: null }

async function fail(deps: Deps, item: Case, error: string): Promise<Case> {
  const moved = await move(deps, item, { status: 'failed', error })
  if (!moved) return item
  await note(deps, moved, SYSTEM, `Stopped: ${error}`)
  return moved
}

type Said = { actor: string; text: string }

/**
 * Leaves the current step with what it produced, and makes the next one current, or closes the case after the last.
 * `said` goes into the history first, so what ended the step reads before what followed from it.
 */
async function leave(deps: Deps, item: Case, output: StepOutput, said: Said, to?: { status: 'rejected' } | { stepId: string }): Promise<Case | null> {
  const outputs = item.current ? { ...item.outputs, [item.current]: output } : item.outputs
  const now = nowOf(deps)
  const steps = item.definition.steps
  const next =
    to && 'stepId' in to ? stepOf(item.definition, to.stepId) : to ? null : (steps[steps.findIndex((step) => step.id === item.current) + 1] ?? null)
  const status = to && 'status' in to ? to.status : 'completed'
  const moved = next
    ? await move(deps, item, { ...CLEARED, outputs, current: next.id, phase: 'pending', stepAt: now })
    : await move(deps, item, { ...CLEARED, outputs, status, current: null, phase: null, stepAt: null, finishedAt: now })
  if (!moved) return null
  await note(deps, moved, said.actor, said.text)
  if (!next) await note(deps, moved, SYSTEM, status === 'completed' ? 'Completed' : 'Closed as rejected')
  return moved
}

async function membersOf(deps: Deps, pluginId: string, orgId: string): Promise<Member[]> {
  try {
    return await deps.factorix(pluginId).members(orgId)
  } catch (error) {
    deps.log?.(`Could not read the members of ${orgId}: ${messageOf(error)}`)
    return []
  }
}

/** Who a step waits for. Anything that points nowhere falls back to the process's owner, and then to the organization's admins. */
async function resolve(deps: Deps, item: Case, assignee: Assignee, pluginId: string): Promise<{ id: string | null; name: string | null }> {
  const byWorkflow = item.requesterId.startsWith(WORKFLOW_ACTOR)
  if (assignee.kind === 'requester' && !byWorkflow) return { id: item.requesterId, name: item.requesterName }
  let id = assignee.kind === 'owner' || assignee.kind === 'requester' ? item.ownerId : assignee.kind === 'member' ? assignee.id : null
  if (assignee.kind === 'department') id = (await deps.store.departments(item.orgId)).find((d) => d.id === assignee.id)?.leadId ?? null
  const members = await membersOf(deps, pluginId, item.orgId)
  const active = (memberId: string | null) =>
    members.find((member) => member.id === memberId && member.kind === 'person' && member.status === 'active')
  // Without the member list there is no telling who left, so the step keeps who the process names.
  if (members.length === 0) return { id: id ?? item.ownerId, name: null }
  const found = active(id) ?? active(item.ownerId)
  return found ? { id: found.id, name: found.name } : { id: null, name: null }
}

/** Begins the current step: puts it in front of a person, or asks Factorix for the run or the ticket it needs. */
async function enter(deps: Deps, item: Case, step: Step, pluginId: string): Promise<Case> {
  const now = nowOf(deps)
  const dueAt = step.dueHours ? new Date(now.getTime() + step.dueHours * HOUR_MS) : null
  if (step.kind === 'task' || step.kind === 'approval') {
    const who = await resolve(deps, item, step.assignee, pluginId)
    const moved = await move(deps, item, { phase: 'todo', assigneeId: who.id, assigneeName: who.name, dueAt })
    if (!moved) return item
    await note(deps, moved, SYSTEM, `${step.name} waits for ${who.name ?? (who.id ? 'its assignee' : 'an admin')}`)
    return moved
  }

  // Claimed before Factorix is asked, so a step never asks twice.
  const claimed = await move(deps, item, { phase: 'entering', dueAt })
  if (!claimed) return item
  const fx = deps.factorix(pluginId)
  const values = templateValues(claimed)
  try {
    if (step.kind === 'agent') {
      const run = await fx.startRun(claimed.orgId, { agentId: step.agentId, prompt: agentPrompt(step.prompt, values) })
      const moved = await move(deps, claimed, { phase: 'waiting', ref: run.id, refUrl: run.url })
      if (moved) await note(deps, moved, SYSTEM, `${step.name}: handed to an agent`)
      return moved ?? claimed
    }
    const title = fill(step.title, values).trim().slice(0, 255) || claimed.title
    const ticket = await fx.createTicket(claimed.orgId, {
      projectId: step.projectId,
      title,
      description: fill(step.description, values),
      ...(step.agentId ? { agentId: step.agentId } : {}),
    })
    const said = { actor: SYSTEM, text: `${step.name}: created ticket ${ticket.identifier}` }
    const output = { ticket: ticket.identifier, url: ticket.url ?? '' }
    if (!step.wait) return (await leave(deps, claimed, output, said)) ?? claimed
    const moved = await move(deps, claimed, {
      phase: 'waiting',
      ref: ticket.id,
      refUrl: ticket.url,
      outputs: { ...claimed.outputs, [step.id]: output },
    })
    if (moved) await note(deps, moved, said.actor, said.text)
    return moved ?? claimed
  } catch (error) {
    const busy = error instanceof FactorixError && error.status === 409 && step.kind === 'agent'
    if (busy && now.getTime() - (claimed.stepAt ?? now).getTime() < BUSY_MS) return (await move(deps, claimed, { phase: 'pending' })) ?? claimed
    return fail(deps, claimed, messageOf(error))
  }
}

/** Takes a case as far as it goes by itself: through every step that needs no one, up to one that waits. */
export async function run(deps: Deps, item: Case): Promise<Case> {
  const pluginId = await deps.store.pluginOf(item.orgId)
  let current = item
  for (let turns = 0; current.status === 'running' && current.phase === 'pending' && turns <= current.definition.steps.length; turns += 1) {
    const step = stepOf(current.definition, current.current)
    if (!step || !pluginId) return fail(deps, current, step ? 'The plugin has not been opened in this organization' : 'The step no longer exists')
    const entered = await enter(deps, current, step, pluginId)
    // A busy Factorix leaves the step pending for the sweep.
    if (entered.current === current.current && entered.phase === 'pending') return entered
    current = entered
  }
  return current
}

export async function startCase(
  deps: Deps,
  process: Process,
  input: { title: string; values: Record<string, string> },
  actor: Actor,
  workflow: Case['workflow'] = null,
): Promise<Case> {
  const definition = process.published
  const first = definition?.steps[0]
  if (!definition || !first || process.archived) throw new CompanyError(`${process.name} is not published yet`)
  const now = nowOf(deps)
  const item = await deps.store.insertCase({
    id: randomUUID(),
    orgId: process.orgId,
    processId: process.id,
    processName: process.name,
    ownerId: process.ownerId,
    version: process.version,
    definition,
    title: input.title.trim().slice(0, 200) || process.name,
    status: 'running',
    data: input.values,
    outputs: {},
    requesterId: actor.id,
    requesterName: actor.name,
    current: first.id,
    phase: 'pending',
    assigneeId: null,
    assigneeName: null,
    ref: null,
    refUrl: null,
    stepAt: now,
    dueAt: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    workflow,
  })
  await note(deps, item, actor.name, 'Started the case')
  return run(deps, item)
}

/** How a closed case ends the workflow step that started it. A failed case is not closed: an admin can start its step again. */
function ending(item: Case): { handle: string; output: Record<string, string> } | { error: string } | null {
  if (item.status === 'completed' || item.status === 'rejected')
    return { handle: item.status, output: { case: `#${item.number}`, status: item.status } }
  if (item.status === 'cancelled') return { error: `Case #${item.number} was cancelled` }
  return null
}

/** The block a workflow runs to start a case. Its step waits until the case closes, unless the case closed right away. */
export async function startForWorkflow(deps: Deps, call: BlockCall): Promise<BlockAnswer> {
  await deps.store.rememberPlugin(call.org.id, call.plugin.id)
  const process = await deps.store.process(call.org.id, call.config.process ?? '')
  if (!process) throw new CompanyError('The process this block starts is gone. Pick another one')
  const lines = formLines(call.config.form ?? '')
  const { values, problems } = readForm(process.published?.form ?? [], (key) => lines[key] ?? '')
  if (problems.length > 0) throw new CompanyError(problems.join('. '))
  const actor = { id: `${WORKFLOW_ACTOR}${call.run.workflowId}`, name: call.run.workflowName, admin: false }
  const item = await startCase(deps, process, { title: call.config.title ?? '', values }, actor, { runId: call.run.id, nodeId: call.nodeId })
  const end = ending(item)
  if (!end) return { wait: true, output: { case: `#${item.number}` } }
  await deps.store.markReported(item.orgId, item.id, nowOf(deps))
  if ('error' in end) throw new CompanyError(end.error)
  return end
}

/** The trigger a closed case fires, unless a workflow started it: that workflow hears of it through its own step. */
export const CASE_FINISHED = 'case_finished'

/**
 * Tells Factorix how a closed case closed: the workflow step that started it, or else the workflows built on
 * `case_finished`. The sweep tries again until Factorix has heard it.
 */
export async function report(deps: Deps, item: Case): Promise<void> {
  const end = ending(item)
  const pluginId = end ? await deps.store.pluginOf(item.orgId) : null
  if (!end || !pluginId) return
  try {
    if (item.workflow) await deps.factorix(pluginId).finishStep(item.orgId, { ...item.workflow, ...end })
    else
      await deps.factorix(pluginId).fireTrigger(item.orgId, {
        trigger: CASE_FINISHED,
        eventId: `case-${item.id}`,
        data: {
          process: item.processId,
          status: item.status,
          case: `#${item.number}`,
          title: item.title,
          processName: item.processName,
          requester: item.requesterName,
        },
      })
  } catch (error) {
    // The step ended already (409), as after a week without word, or Factorix no longer lets the plugin reach it.
    if (!(error instanceof FactorixError && [403, 404, 409].includes(error.status))) {
      deps.log?.(`Could not tell the workflow of case ${item.id}: ${messageOf(error)}`)
      return
    }
  }
  await deps.store.markReported(item.orgId, item.id, nowOf(deps))
}

/** True for whoever may act on the step a case waits at: its assignee, or an admin. */
export const mayAct = (item: Case, actor: Actor) =>
  item.status === 'running' && item.phase === 'todo' && (actor.admin || item.assigneeId === actor.id)

const GONE = 'Someone else just changed this case. Open it again to see where it is'

/** A person finishes the step a case waits at: done for a task, approve or reject for an approval. */
export async function decide(deps: Deps, item: Case, actor: Actor, input: { decision: string; note: string }): Promise<Case> {
  const step = stepOf(item.definition, item.current)
  if (!step || !mayAct(item, actor) || (step.kind !== 'task' && step.kind !== 'approval')) throw new CompanyError('This step is not waiting for you')
  const text = input.note.trim().slice(0, 2000)
  const by = actor.name
  let moved: Case | null
  if (step.kind === 'task') {
    moved = await leave(deps, item, { note: text, by }, { actor: by, text: `${step.name}: done${text ? `. ${text}` : ''}` })
  } else if (input.decision === 'reject') {
    if (!text) throw new CompanyError('Say why you reject it')
    const back = step.onReject !== 'end' && stepOf(item.definition, step.onReject)
    const said = { actor: by, text: `${step.name}: rejected. ${text}` }
    moved = await leave(deps, item, { decision: 'rejected', note: text, by }, said, back ? { stepId: back.id } : { status: 'rejected' })
  } else if (input.decision === 'approve') {
    moved = await leave(deps, item, { decision: 'approved', note: text, by }, { actor: by, text: `${step.name}: approved${text ? `. ${text}` : ''}` })
  } else throw new CompanyError('Approve or reject')
  if (!moved) throw new CompanyError(GONE)
  const after = await run(deps, moved)
  await report(deps, after)
  return after
}

/** Reads the run or the ticket a case waits for, and moves the case on once that finished. */
export async function poll(deps: Deps, item: Case): Promise<Case> {
  if (item.status !== 'running') return item
  const step = stepOf(item.definition, item.current)
  const now = nowOf(deps)
  if (item.phase === 'pending') return run(deps, item)
  if (item.phase === 'entering') return now.getTime() - item.updatedAt.getTime() > ENTERING_MS ? fail(deps, item, 'The step never started') : item
  if (item.phase !== 'waiting' || !step || !item.ref) return item
  const pluginId = await deps.store.pluginOf(item.orgId)
  if (!pluginId) return item
  const fx = deps.factorix(pluginId)
  let moved: Case | null = null
  try {
    if (step.kind === 'agent') {
      const result = await fx.getRun(item.orgId, item.ref)
      if (!result.finished) return item
      if (result.state !== 'succeeded') return fail(deps, item, result.error ?? `The agent's run ended ${result.state}`)
      const answer = (result.output as { answer?: unknown } | null)?.answer
      const text = typeof answer === 'string' ? answer : JSON.stringify(result.output ?? '')
      moved = await leave(
        deps,
        item,
        { answer: text.slice(0, MAX_OUTPUT), url: result.url },
        { actor: SYSTEM, text: `${step.name}: the agent finished` },
      )
    } else if (step.kind === 'ticket') {
      const ticket = await fx.getTicket(item.orgId, item.ref)
      if (!ticket.closed) return item
      const said = { actor: SYSTEM, text: `${step.name}: ticket ${ticket.identifier} closed as ${ticket.status ?? 'done'}` }
      moved = await leave(deps, item, { ...item.outputs[step.id], status: ticket.status ?? '' }, said)
    }
  } catch (error) {
    // Factorix answers 404 for a run or a ticket it no longer has, and for an organization that turned the plugin off.
    if (error instanceof FactorixError && error.status === 404) return fail(deps, item, 'Factorix no longer has what this step waits for')
    throw error
  }
  return moved ? run(deps, moved) : item
}

export async function cancelCase(deps: Deps, item: Case, actor: Actor): Promise<Case> {
  if (!actor.admin && actor.id !== item.requesterId) throw new CompanyError('Only whoever started the case, or an admin, can cancel it')
  if (item.status !== 'running' && item.status !== 'failed') throw new CompanyError('This case is already closed')
  const moved = await move(deps, item, { ...CLEARED, status: 'cancelled', phase: null, finishedAt: nowOf(deps) })
  if (!moved) throw new CompanyError(GONE)
  await note(deps, moved, actor.name, 'Cancelled the case')
  await report(deps, moved)
  return moved
}

/** Starts a failed case's step again, once whatever stopped it is fixed. */
export async function retryCase(deps: Deps, item: Case, actor: Actor): Promise<Case> {
  if (!actor.admin) throw new CompanyError('Only an admin can start a failed step again')
  if (item.status !== 'failed' || !item.current) throw new CompanyError('This case did not fail')
  const moved = await move(deps, item, { ...CLEARED, status: 'running', phase: 'pending', stepAt: nowOf(deps) })
  if (!moved) throw new CompanyError(GONE)
  await note(deps, moved, actor.name, 'Started the step again')
  return run(deps, moved)
}

/** Checks the cases of one organization that wait for Factorix, so a page shows a finished run without waiting for the sweep. */
export async function refreshOrg(deps: Deps, orgId: string): Promise<void> {
  for (const item of await deps.store.cases(orgId, { status: 'running', limit: 200 })) {
    if (item.phase === 'todo') continue
    await poll(deps, item).catch((error) => deps.log?.(`Could not check case ${item.id}: ${messageOf(error)}`))
  }
}

/** Moves on every case that waits for a run or a ticket that finished, and starts the steps that were held back. */
export async function sweep(deps: Deps): Promise<void> {
  for (const item of await deps.store.unsettled())
    await poll(deps, item).catch((error) => deps.log?.(`Could not check case ${item.id}: ${messageOf(error)}`))
  for (const item of await deps.store.unreported()) await report(deps, item)
}
