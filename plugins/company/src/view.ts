import type { Agent, Member, TicketProject } from '@moxxylabs/factorix-plugin-sdk'
import {
  type Assignee,
  type Case,
  type CaseEvent,
  type Department,
  FIELD_TYPES,
  type FormField,
  fill,
  type Placement,
  type Process,
  problemsOf,
  STEP_KINDS,
  STEP_RESULTS,
  type Step,
  stepOf,
  templateValues,
} from './model'
import { TEMPLATES } from './templates'

export const esc = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** What every view needs: the signed context to send back, and who is looking. */
export interface Shell {
  token: string
  exp: number
  nonce: string
  admin: boolean
  accountId: string
  now: Date
  notice: string | null
  error: string | null
}

export const VIEWS = [
  { key: 'work', label: 'My work' },
  { key: 'processes', label: 'Processes' },
  { key: 'cases', label: 'Cases' },
  { key: 'company', label: 'Company' },
] as const

export const NOTICES: Record<string, string> = {
  saved: 'Saved.',
  published: 'Published. New cases follow this version.',
  started: 'The case is on its way.',
  done: 'Done. The case moved on.',
  cancelled: 'The case is cancelled.',
  archived: 'The process is archived. Its open cases carry on.',
}

const href = (shell: Shell, view: string, params: Record<string, string> = {}) =>
  esc(`?${new URLSearchParams({ factorix: shell.token, view, ...params })}`)
const action = (shell: Shell) => `method="post" action="${esc(`?${new URLSearchParams({ factorix: shell.token })}`)}"`
const hidden = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join('')
const option = (value: string, label: string, selected: boolean) =>
  `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`
/** A link is only a link when it goes to the web. Ticket addresses come from trackers. */
const safeUrl = (url: string | null | undefined) => (url && /^https?:\/\//i.test(url) ? url : null)
const outside = (url: string | null | undefined, label: string) => {
  const safe = safeUrl(url)
  return safe ? `<a href="${esc(safe)}" target="_blank" rel="noreferrer">${esc(label)}</a>` : esc(label)
}
const moment = (at: Date) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(
    at,
  )
const when = (at: Date) => `<time datetime="${at.toISOString()}">${esc(moment(at))} UTC</time>`

const STATUS_LABELS: Record<Case['status'], string> = {
  running: 'Running',
  completed: 'Completed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  failed: 'Stopped',
}
const badge = (status: Case['status']) => `<span class="badge ${status}">${STATUS_LABELS[status]}</span>`
const overdue = (item: Case, now: Date) => item.status === 'running' && item.dueAt !== null && item.dueAt < now

const STYLE = `
:root { --surface: #fff; --ink: #000000de; --ink-2: #5f5f5f; --ink-3: #8a8f94; --divider: #e0e5eb; --link: #0069d1; --soft: #f3f4f6;
  --danger-ink: #c10007; --danger-soft: #ffe9e9; --success-soft: #ecfccb; --success-ink: #3f6212; --warn-soft: #fef3c7; --warn-ink: #92400e; color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root { --surface: #1d1d1f; --ink: #cfd2d5; --ink-2: #979a9d; --ink-3: #6f7276; --divider: #323840; --link: #5aabff; --soft: #26272a;
    --danger-ink: #ff8a8d; --danger-soft: #3a1c1e; --success-soft: #24300f; --success-ink: #a3e635; --warn-soft: #3a2e12; --warn-ink: #fbbf24; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--ink); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif; }
a { color: inherit; text-underline-offset: 2px; }
a:hover { color: var(--link); }
nav { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 24px; border-bottom: 1px solid var(--divider); }
nav a { padding: 5px 12px; border-radius: 6px; text-decoration: none; color: var(--ink-2); font-size: 13px; }
nav a.on { background: var(--soft); color: var(--ink); font-weight: 600; }
main { max-width: 860px; margin: 0 auto; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
h1 { margin: 0; font-size: 20px; font-weight: 600; }
h2 { margin: 0; font-size: 15px; font-weight: 600; }
h3 { margin: 0; font-size: 14px; font-weight: 600; }
p { margin: 0; }
.muted { color: var(--ink-2); font-size: 12px; }
.pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.head > :first-child { flex: 1; min-width: 0; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.grow { flex: 1; min-width: 0; }
.card { border: 1px solid var(--divider); border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.list { border: 1px solid var(--divider); border-radius: 8px; }
.list > * { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--divider); text-decoration: none; }
.list > :first-child { border-top: 0; }
.list > a:hover { background: var(--soft); color: inherit; }
.button { font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--divider); background: var(--surface); color: var(--ink); cursor: pointer; text-decoration: none; display: inline-block; }
.button:hover { background: var(--soft); color: var(--ink); }
.button.primary { background: var(--ink); color: var(--surface); border-color: var(--ink); }
.button.danger { color: var(--danger-ink); }
.button:disabled { opacity: .5; cursor: default; }
.badge { font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px; background: var(--soft); color: var(--ink-2); white-space: nowrap; }
.badge.completed { background: var(--success-soft); color: var(--success-ink); }
.badge.rejected, .badge.failed, .badge.late { background: var(--danger-soft); color: var(--danger-ink); }
.badge.draft { background: var(--warn-soft); color: var(--warn-ink); }
.banner { padding: 8px 12px; border-radius: 6px; font-size: 13px; }
.banner.ok { background: var(--success-soft); color: var(--success-ink); }
.banner.bad { background: var(--danger-soft); color: var(--danger-ink); }
.banner.warn { background: var(--warn-soft); color: var(--warn-ink); }
form.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
form.inline { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ink-2); }
label.check { flex-direction: row; align-items: center; gap: 8px; color: var(--ink); font-size: 13px; }
.wide { grid-column: 1 / -1; }
.end { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; }
input, select, textarea { font: inherit; font-size: 13px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--divider); background: var(--surface); color: var(--ink); min-width: 0; }
textarea { min-height: 72px; resize: vertical; }
dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
dt { color: var(--ink-2); font-size: 12px; }
dd { margin: 0; }
ol.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
ol.steps > li { border: 1px solid var(--divider); border-radius: 8px; padding: 12px 16px; display: flex; flex-direction: column; gap: 6px; }
ol.steps > li.now { border-color: var(--ink-2); }
ol.steps > li.later { color: var(--ink-3); }
code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--soft); padding: 1px 4px; border-radius: 4px; }
.empty { text-align: center; padding: 40px 24px; color: var(--ink-2); }
.spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--divider); border-top-color: var(--ink-2); border-radius: 999px; animation: spin 1s linear infinite; vertical-align: -2px; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 560px) { nav, main { padding-left: 16px; padding-right: 16px; } form.fields { grid-template-columns: 1fr; } }
`

/**
 * Keeps the page working past the few minutes one opening lasts: it asks the Factorix window around it for a fresh
 * signed context and puts that into every link and form. A page that waits for an agent reloads itself meanwhile.
 */
const SCRIPT = `
let token = document.body.dataset.token
const expOf = (value) => { try { return JSON.parse(atob(value.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).exp } catch { return 0 } }
function apply(next) {
  token = next
  for (const node of document.querySelectorAll('a[href*="factorix="], form[action*="factorix="]')) {
    const attribute = node.tagName === 'A' ? 'href' : 'action'
    const url = new URL(node.getAttribute(attribute), location.href)
    url.searchParams.set('factorix', next)
    node.setAttribute(attribute, url.search)
  }
  for (const input of document.querySelectorAll('input[name="factorix"]')) input.value = next
}
function ask() { if (window.parent !== window) window.parent.postMessage({ type: 'factorix:token' }, '*') }
function plan() { setTimeout(ask, Math.max(5000, expOf(token) - Date.now() - 60000)) }
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || !event.data || event.data.type !== 'factorix:token' || typeof event.data.token !== 'string') return
  if (expOf(event.data.token) <= expOf(token)) return
  apply(event.data.token)
  plan()
})
plan()
if (document.body.dataset.waiting) setTimeout(() => {
  if (expOf(token) < Date.now() + 5000) return
  const url = new URL(location.href)
  url.searchParams.set('factorix', token)
  url.searchParams.delete('notice')
  location.replace(url)
}, 8000)
`

export function page(shell: Shell, view: string, body: string, options: { waiting?: boolean } = {}): string {
  const tabs = VIEWS.map((tab) => `<a href="${href(shell, tab.key)}"${tab.key === view ? ' class="on"' : ''}>${tab.label}</a>`).join('')
  const banners = [
    shell.notice ? `<div class="banner ok">${esc(shell.notice)}</div>` : '',
    shell.error ? `<div class="banner bad">${esc(shell.error)}</div>` : '',
  ].join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Company</title>
<style nonce="${shell.nonce}">${STYLE}</style>
</head>
<body data-token="${esc(shell.token)}"${options.waiting ? ' data-waiting="1"' : ''}>
<nav>${tabs}</nav>
<main>${banners}${body}</main>
<script nonce="${shell.nonce}">${SCRIPT}</script>
</body>
</html>`
}

function caseRow(shell: Shell, item: Case): string {
  const step = stepOf(item.definition, item.current)
  const where =
    item.status !== 'running' || !step
      ? ''
      : item.phase === 'todo'
        ? `${esc(step.name)}, waits for ${esc(item.assigneeName ?? (item.assigneeId ? 'its assignee' : 'an admin'))}`
        : `${esc(step.name)}, in progress`
  return `<a href="${href(shell, 'case', { id: item.id })}"><span class="muted">#${item.number}</span>
  <span class="grow"><b>${esc(item.title)}</b><br><span class="muted">${esc(item.processName)}${where ? ` · ${where}` : ''}</span></span>
  ${overdue(item, shell.now) ? '<span class="badge late">Overdue</span>' : ''}${badge(item.status)}</a>`
}

const caseList = (shell: Shell, cases: Case[], empty: string) =>
  cases.length > 0 ? `<div class="list">${cases.map((item) => caseRow(shell, item)).join('')}</div>` : `<p class="muted">${esc(empty)}</p>`

export function workView(shell: Shell, data: { mine: Case[]; unassigned: Case[]; requested: Case[] }): string {
  return `<section class="card"><h2>Waiting for you</h2>${caseList(shell, data.mine, 'Nothing waits for you.')}</section>
${shell.admin && data.unassigned.length > 0 ? `<section class="card"><h2>Waiting with nobody on it</h2><p class="muted">The step names someone who is no longer here. As an admin you can do it.</p>${caseList(shell, data.unassigned, '')}</section>` : ''}
<section class="card"><h2>Cases you started</h2>${caseList(shell, data.requested, 'You have not started a case yet. Pick a process under Processes.')}</section>`
}

export function processesView(shell: Shell, processes: Process[]): string {
  const visible = processes.filter((process) => shell.admin || process.published)
  const cards = visible
    .map((process) => {
      const state = !process.published
        ? '<span class="badge draft">Draft</span>'
        : JSON.stringify(process.draft) !== JSON.stringify(process.published)
          ? `<span class="badge">v${process.version}</span>${shell.admin ? '<span class="badge draft">Unpublished changes</span>' : ''}`
          : `<span class="badge">v${process.version}</span>`
      return `<div class="card"><div class="head"><div><h2>${esc(process.name)}</h2>${process.description ? `<p class="muted">${esc(process.description)}</p>` : ''}</div>${state}
  ${shell.admin ? `<a class="button" href="${href(shell, 'edit', { process: process.id })}">Edit</a>` : ''}
  ${process.published ? `<a class="button primary" href="${href(shell, 'start', { process: process.id })}">Start</a>` : ''}</div></div>`
    })
    .join('')
  const empty = `<div class="empty"><h2>No process yet</h2><p>A process is a form and the steps a case goes through: tasks for people, approvals, work for agents, and tickets.${
    shell.admin ? ' Make one below, or begin with a starter.' : ' An admin sets them up.'
  }</p></div>`
  const admin = shell.admin
    ? `<section class="card"><h2>New process</h2>
<form class="inline" ${action(shell)}>${hidden({ intent: 'process.create' })}<label class="grow">Name<input name="name" required maxlength="120" placeholder="Vendor onboarding"></label><button class="button primary">Create</button></form>
<p class="muted">Or begin with a starter and change it:</p>
<div class="row">${TEMPLATES.map((template) => `<form ${action(shell)}>${hidden({ intent: 'process.create', template: template.key })}<button class="button" title="${esc(template.description)}">${esc(template.name)}</button></form>`).join('')}</div></section>`
    : ''
  return `${visible.length > 0 ? cards : empty}${admin}`
}

function fieldInput(field: FormField, value: string): string {
  const name = `f_${field.key}`
  const required = field.required ? ' required' : ''
  const label = `${esc(field.label)}${field.required ? '' : ' (optional)'}`
  if (field.type === 'longtext')
    return `<label class="wide">${label}<textarea name="${name}" maxlength="4000"${required}>${esc(value)}</textarea></label>`
  if (field.type === 'select')
    return `<label>${label}<select name="${name}"${required}><option value="">Pick one</option>${field.options.map((item) => option(item, item, item === value)).join('')}</select></label>`
  const type = field.type === 'number' ? 'number" step="any' : field.type === 'date' ? 'date' : 'text'
  return `<label>${label}<input type="${type}" name="${name}" maxlength="4000" value="${esc(value)}"${required}></label>`
}

export function startView(shell: Shell, process: Process, values: Record<string, string> = {}): string {
  const form = process.published?.form ?? []
  return `<div class="head"><div><h1>${esc(process.name)}</h1>${process.description ? `<p class="muted">${esc(process.description)}</p>` : ''}</div></div>
<form class="fields card" ${action(shell)}>${hidden({ intent: 'case.start', process: process.id })}
<label class="wide">Title of this case (optional)<input name="title" maxlength="200" placeholder="${esc(process.name)}"></label>
${form.map((field) => fieldInput(field, values[field.key] ?? '')).join('')}
<div class="end"><a class="button" href="${href(shell, 'processes')}">Back</a><button class="button primary">Start</button></div></form>`
}

function outputOf(step: Step, item: Case): string {
  const output = item.outputs[step.id]
  if (!output) return ''
  if (step.kind === 'agent')
    return `<p class="pre">${esc(output.answer ?? '')}</p>${output.url ? `<p class="muted">${outside(output.url, 'The run')}</p>` : ''}`
  if (step.kind === 'ticket') return `<p>${outside(output.url, output.ticket ?? 'Ticket')}${output.status ? `, ${esc(output.status)}` : ''}</p>`
  const verdict = output.decision ? `${output.decision === 'approved' ? 'Approved' : 'Rejected'} by ${output.by ?? ''}` : `Done by ${output.by ?? ''}`
  return `<p class="muted">${esc(verdict)}</p>${output.note ? `<p class="pre">${esc(output.note)}</p>` : ''}`
}

export function caseView(shell: Shell, data: { item: Case; events: CaseEvent[]; mayAct: boolean; mayCancel: boolean }): string {
  const { item } = data
  const values = templateValues(item)
  const at = item.definition.steps.findIndex((step) => step.id === item.current)
  const closed = item.status === 'completed' || item.status === 'rejected'
  const steps = item.definition.steps
    .map((step, index) => {
      const now = step.id === item.current && (item.status === 'running' || item.status === 'failed')
      const later = !closed && at >= 0 && index > at
      const title = `<div class="row"><h3 class="grow">${index + 1}. ${esc(step.name)}</h3><span class="muted">${STEP_KINDS[step.kind]}</span></div>`
      if (!now) return `<li${later ? ' class="later"' : ''}>${title}${later ? '' : outputOf(step, item)}</li>`
      const instructions = step.kind === 'task' || step.kind === 'approval' ? fill(step.instructions, values) : ''
      const due = item.dueAt ? `<span class="${overdue(item, shell.now) ? 'badge late' : 'muted'}">Due ${when(item.dueAt)}</span>` : ''
      let state = ''
      if (item.status === 'failed') state = `<p class="banner bad">${esc(item.error ?? 'This step stopped.')}</p>`
      else if (item.phase === 'todo')
        state = `<p class="muted">Waits for ${esc(item.assigneeName ?? (item.assigneeId ? 'its assignee' : 'an admin'))}${due ? ` · ${due}` : ''}</p>`
      else
        state = `<p class="muted"><span class="spinner"></span> ${step.kind === 'agent' ? `An agent is working on it. ${outside(item.refUrl, 'Open the run')}` : step.kind === 'ticket' ? `Waits for ${outside(item.refUrl, item.outputs[step.id]?.ticket ?? 'the ticket')} to close` : 'Starting'} ${due}</p>`
      const form =
        data.mayAct && item.phase === 'todo'
          ? `<form class="fields" ${action(shell)}>${hidden({ intent: 'case.decide', id: item.id })}
<label class="wide">Note${step.kind === 'approval' ? ' (needed to reject)' : ' (optional)'}<textarea name="note" maxlength="2000"></textarea></label>
<div class="end">${
              step.kind === 'approval'
                ? '<button class="button danger" name="decision" value="reject">Reject</button><button class="button primary" name="decision" value="approve">Approve</button>'
                : '<button class="button primary" name="decision" value="done">Mark as done</button>'
            }</div></form>`
          : ''
      return `<li class="now">${title}${instructions.trim() ? `<p class="pre">${esc(instructions)}</p>` : ''}${state}${form}</li>`
    })
    .join('')
  const fields = item.definition.form
    .filter((field) => item.data[field.key])
    .map((field) => `<dt>${esc(field.label)}</dt><dd class="pre">${esc(item.data[field.key] ?? '')}</dd>`)
    .join('')
  const controls = [
    shell.admin && item.status === 'failed'
      ? `<form ${action(shell)}>${hidden({ intent: 'case.retry', id: item.id })}<button class="button">Try the step again</button></form>`
      : '',
    data.mayCancel && (item.status === 'running' || item.status === 'failed')
      ? `<form ${action(shell)}>${hidden({ intent: 'case.cancel', id: item.id })}<button class="button danger">Cancel case</button></form>`
      : '',
  ].join('')
  return `<div class="head"><div><h1><span class="muted">#${item.number}</span> ${esc(item.title)}</h1>
<p class="muted">${esc(item.processName)} v${item.version} · started by ${esc(item.requesterName)} on ${when(item.createdAt)}</p></div>${badge(item.status)}${controls}</div>
${fields ? `<section class="card"><dl>${fields}</dl></section>` : ''}
<ol class="steps">${steps}</ol>
<section class="card"><h2>History</h2>${data.events.map((event) => `<p><span class="muted">${when(event.at)} · ${esc(event.actor)}</span><br><span class="pre">${esc(event.text)}</span></p>`).join('')}</section>`
}

export function casesView(shell: Shell, data: { cases: Case[]; counts: Record<string, number>; status: string }): string {
  const total = Object.values(data.counts).reduce((sum, count) => sum + count, 0)
  const late = data.cases.filter((item) => overdue(item, shell.now)).length
  const filters = [
    ['', `All ${total}`] as const,
    ...(Object.keys(STATUS_LABELS) as Case['status'][]).map((status) => [status, `${STATUS_LABELS[status]} ${data.counts[status] ?? 0}`] as const),
  ]
    .map(
      ([status, label]) =>
        `<a class="button${status === data.status ? ' primary' : ''}" href="${href(shell, 'cases', status ? { status } : {})}">${esc(label)}</a>`,
    )
    .join('')
  return `<div class="head"><h1>Cases</h1>${late > 0 ? `<span class="badge late">${late} overdue</span>` : ''}</div><div class="row">${filters}</div>
${caseList(shell, data.cases, 'No case here.')}`
}

const assigneeValue = (assignee: Assignee) =>
  assignee.kind === 'member' || assignee.kind === 'department' ? `${assignee.kind}:${assignee.id}` : assignee.kind

export interface EditData {
  process: Process
  people: Member[]
  agents: Agent[]
  projects: TicketProject[]
  departments: Department[]
  /** What Factorix refused while the lists above were read, so an empty list explains itself. */
  warnings: string[]
}

function stepCard(shell: Shell, data: EditData, step: Step, index: number): string {
  const { process, people, agents, projects, departments } = data
  const steps = process.draft.steps
  const base = { process: process.id, step: step.id }
  const who =
    step.kind === 'task' || step.kind === 'approval'
      ? `<label>Who does it<select name="assignee">${option('requester', 'Whoever started the case', step.assignee.kind === 'requester')}${option('owner', 'The owner of the process', step.assignee.kind === 'owner')}
${departments.map((d) => option(`department:${d.id}`, `Lead of ${d.name}`, assigneeValue(step.assignee) === `department:${d.id}`)).join('')}
${people.map((m) => option(`member:${m.id}`, m.name, assigneeValue(step.assignee) === `member:${m.id}`)).join('')}</select></label>`
      : ''
  const agentOptions = (selected: string | null, none: string) =>
    `${option('', none, !selected)}${agents
      .filter((agent) => agent.status === 'active' || agent.id === selected)
      .map((agent) => option(agent.id, `${agent.name} (${agent.model ?? agent.runtime})`, agent.id === selected))
      .join('')}`
  let body = ''
  if (step.kind === 'task' || step.kind === 'approval')
    body = `${who}<label class="wide">What they see<textarea name="instructions" maxlength="4000">${esc(step.instructions)}</textarea></label>`
  if (step.kind === 'approval')
    body += `<label>When rejected<select name="onReject">${option('end', 'Close the case as rejected', step.onReject === 'end')}${steps
      .slice(0, index)
      .map((earlier, at) => option(earlier.id, `Go back to ${at + 1}. ${earlier.name}`, step.onReject === earlier.id))
      .join('')}</select></label>`
  if (step.kind === 'agent')
    body = `<label>Agent<select name="agentId">${agentOptions(step.agentId, 'Pick an agent')}</select></label>
<label class="wide">What to ask the agent. It gets no repository, and uses the integrations it has in Factorix.<textarea name="prompt" maxlength="4000">${esc(step.prompt)}</textarea></label>`
  if (step.kind === 'ticket')
    body = `<label>Project<select name="projectId">${option('', 'Pick a project', !step.projectId)}${projects.map((p) => option(p.id, p.name, p.id === step.projectId)).join('')}</select></label>
<label>Hand to agent<select name="agentId">${agentOptions(step.agentId, 'Nobody, only create it')}</select></label>
<label class="wide">Ticket title<input name="title" maxlength="255" value="${esc(step.title)}"></label>
<label class="wide">Ticket description<textarea name="description" maxlength="4000">${esc(step.description)}</textarea></label>
<label class="check wide"><input type="checkbox" name="wait"${step.wait ? ' checked' : ''}> Hold the case until the ticket is closed</label>`
  const results = STEP_RESULTS[step.kind].map((key) => `<code>{{steps.${esc(step.id)}.${key}}}</code>`).join(' ')
  const move = (intent: string, label: string, disabled: boolean) =>
    `<button class="button" formnovalidate name="intent" value="${intent}"${disabled ? ' disabled' : ''}>${label}</button>`
  return `<li><form class="fields" ${action(shell)}>${hidden(base)}
<label>Step ${index + 1}, ${STEP_KINDS[step.kind].toLowerCase()}<input name="name" required maxlength="120" value="${esc(step.name)}"></label>
<label>Due after (hours, optional)<input type="number" name="dueHours" min="1" max="8760" value="${step.dueHours ?? ''}"></label>
${body}
<p class="muted wide">Later steps can use: ${results}</p>
<div class="end">${move('step.up', 'Up', index === 0)}${move('step.down', 'Down', index === steps.length - 1)}
<button class="button danger" formnovalidate name="intent" value="step.remove">Remove</button><button class="button primary" name="intent" value="step.save">Save step</button></div></form></li>`
}

export function editView(shell: Shell, data: EditData): string {
  const { process, people, departments } = data
  const draft = process.draft
  const problems = problemsOf(draft)
  const changed = JSON.stringify(draft) !== JSON.stringify(process.published)
  const state = !process.published
    ? 'Not published yet, so nobody can start it.'
    : changed
      ? `Version ${process.version} is live. The changes below are not.`
      : `Version ${process.version} is live.`
  const fields = draft.form
    .map(
      (field) => `<form class="inline" ${action(shell)}>${hidden({ process: process.id, field: field.key })}
<label class="grow">Label<input name="label" required maxlength="80" value="${esc(field.label)}"></label>
<label>Kind<select name="type">${(Object.keys(FIELD_TYPES) as (keyof typeof FIELD_TYPES)[]).map((type) => option(type, FIELD_TYPES[type], type === field.type)).join('')}</select></label>
<label class="grow">Choices, separated by commas<input name="options" maxlength="1000" value="${esc(field.options.join(', '))}"></label>
<label class="check"><input type="checkbox" name="required"${field.required ? ' checked' : ''}> Required</label>
<code>{{form.${esc(field.key)}}}</code>
<button class="button danger" formnovalidate name="intent" value="field.remove">Remove</button><button class="button" name="intent" value="field.save">Save</button></form>`,
    )
    .join('')
  return `<div class="head"><div><h1>${esc(process.name)}</h1><p class="muted">${esc(state)}</p></div>
<a class="button" href="${href(shell, 'processes')}">Back</a>
<form ${action(shell)}>${hidden({ intent: 'process.archive', process: process.id })}<button class="button danger">Archive</button></form>
<form ${action(shell)}>${hidden({ intent: 'process.publish', process: process.id })}<button class="button primary"${problems.length > 0 || !changed ? ' disabled' : ''}>Publish</button></form></div>
${problems.length > 0 ? `<div class="banner warn">Before it can be published: ${esc(problems.join('. '))}.</div>` : ''}
${data.warnings.map((warning) => `<div class="banner warn">${esc(warning)}</div>`).join('')}
<section class="card"><h2>About</h2>
<form class="fields" ${action(shell)}>${hidden({ intent: 'process.save', process: process.id })}
<label>Name<input name="name" required maxlength="120" value="${esc(process.name)}"></label>
<label>Owner, who gets what nobody else can take<select name="ownerId">${option('', 'Nobody, admins take it', !process.ownerId)}${people.map((m) => option(m.id, m.name, m.id === process.ownerId)).join('')}</select></label>
<label>Department<select name="departmentId">${option('', 'None', !process.departmentId)}${departments.map((d) => option(d.id, d.name, d.id === process.departmentId)).join('')}</select></label>
<label class="wide">What it is for<textarea name="description" maxlength="500">${esc(process.description)}</textarea></label>
<div class="end"><button class="button">Save</button></div></form></section>
<section class="card"><h2>Form</h2><p class="muted">What someone fills in to start a case. Steps use the answers as the placeholders shown.</p>
${fields}
<form class="inline" ${action(shell)}>${hidden({ intent: 'field.add', process: process.id })}
<label class="grow">New field<input name="label" required maxlength="80" placeholder="Start date"></label>
<label>Kind<select name="type">${(Object.keys(FIELD_TYPES) as (keyof typeof FIELD_TYPES)[]).map((type) => option(type, FIELD_TYPES[type], type === 'text')).join('')}</select></label>
<button class="button">Add field</button></form></section>
<section class="card"><h2>Steps</h2><p class="muted">A case goes through them from top to bottom. Text can also use <code>{{requester.name}}</code> and <code>{{case.title}}</code>.</p>
<ol class="steps">${draft.steps.map((step, index) => stepCard(shell, data, step, index)).join('')}</ol>
<form class="inline" ${action(shell)}>${hidden({ intent: 'step.add', process: process.id })}
<label>Kind<select name="kind">${(Object.keys(STEP_KINDS) as (keyof typeof STEP_KINDS)[]).map((kind) => option(kind, STEP_KINDS[kind], kind === 'task')).join('')}</select></label>
<label class="grow">Name<input name="name" required maxlength="120" placeholder="Review the request"></label>
<button class="button">Add step</button></form></section>`
}

export function companyView(
  shell: Shell,
  data: { departments: Department[]; placements: Placement[]; members: Member[]; warning: string | null },
): string {
  const { departments, members } = data
  const placementOf = new Map(data.placements.map((placement) => [placement.memberId, placement]))
  const nameOf = new Map(members.map((member) => [member.id, member.name]))
  const people = members.filter((member) => member.kind === 'person')
  const line = (member: Member) => {
    const placement = placementOf.get(member.id)
    const text = `<span class="grow"><b>${esc(member.name)}</b> <span class="muted">${member.kind === 'agent' ? 'Agent' : esc(member.role)}${placement?.title ? ` · ${esc(placement.title)}` : ''}${member.status === 'active' ? '' : ' · disabled'}</span></span>`
    if (!shell.admin) return `<div>${text}</div>`
    return `<form ${action(shell)}>${hidden({ intent: 'member.place', member: member.id })}${text}
<input name="title" maxlength="80" placeholder="Title" value="${esc(placement?.title ?? '')}" aria-label="Title of ${esc(member.name)}">
<select name="departmentId" aria-label="Department of ${esc(member.name)}">${option('', 'No department', !placement?.departmentId)}${departments.map((d) => option(d.id, d.name, d.id === placement?.departmentId)).join('')}</select>
<button class="button">Save</button></form>`
  }
  const group = (title: string, lead: string, list: Member[], controls = '') =>
    `<section class="card"><div class="head"><div><h2>${esc(title)}</h2>${lead ? `<p class="muted">${esc(lead)}</p>` : ''}</div>${controls}</div>
${list.length > 0 ? `<div class="list">${list.map(line).join('')}</div>` : '<p class="muted">Nobody here yet.</p>'}</section>`
  const sections = departments
    .map((department) => {
      const controls = shell.admin
        ? `<form class="inline" ${action(shell)}>${hidden({ department: department.id })}
<input name="name" required maxlength="80" value="${esc(department.name)}" aria-label="Name">
<select name="leadId" aria-label="Lead">${option('', 'No lead', !department.leadId)}${people.map((m) => option(m.id, m.name, m.id === department.leadId)).join('')}</select>
<button class="button" name="intent" value="department.save">Save</button><button class="button danger" formnovalidate name="intent" value="department.remove">Remove</button></form>`
        : ''
      const lead = department.leadId ? `Led by ${nameOf.get(department.leadId) ?? 'someone who left'}` : 'No lead'
      return group(
        department.name,
        lead,
        members.filter((member) => placementOf.get(member.id)?.departmentId === department.id),
        controls,
      )
    })
    .join('')
  const known = new Set(departments.map((department) => department.id))
  const rest = members.filter((member) => !known.has(placementOf.get(member.id)?.departmentId ?? ''))
  const add = shell.admin
    ? `<section class="card"><h2>New department</h2><form class="inline" ${action(shell)}>${hidden({ intent: 'department.save' })}
<label class="grow">Name<input name="name" required maxlength="80" placeholder="Operations"></label><button class="button primary">Add</button></form></section>`
    : ''
  return `<div class="head"><div><h1>Company</h1><p class="muted">Who is where. A step can wait for the lead of a department, and agents sit in departments next to people.</p></div></div>
${data.warning ? `<div class="banner warn">${esc(data.warning)}</div>` : ''}${sections}${rest.length > 0 || departments.length === 0 ? group(departments.length > 0 ? 'No department' : 'Everyone', '', rest) : ''}${add}`
}
