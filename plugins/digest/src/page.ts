import type { Agent } from '@moxxy/factorix-plugin-sdk'
import type { DigestMemberContent } from './content'
import { digestCopy, escapeHtml as esc, lineHtml, SECTIONS } from './copy'
import { linksOf } from './facts'
import type { Digest, Schedule } from './store'

export interface PageView {
  token: string
  /** When the page's token stops working, so a page waiting for a digest stops reloading before then. */
  exp: number
  nonce: string
  admin: boolean
  schedule: Schedule
  digests: Digest[]
  selected: Digest | null
  /** The organization's agents, for an admin's schedule form. */
  agents: Agent[] | null
  agentsError: string | null
  notice: string | null
  error: string | null
}

export const NOTICES: Record<string, string> = {
  saved: 'Digest schedule saved.',
  off: 'The daily digest is off.',
  started: 'The agent is writing the digest.',
  nothing: 'Nothing was finished, in progress, or waiting since the last digest, so no agent was asked.',
}

const DAYS = [
  { value: 'weekdays', label: 'Monday to Friday' },
  { value: 'daily', label: 'Every day' },
]

function format(at: Date, timezone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...options }).format(at)
  } catch {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(at)
  }
}
const dayOf = (digest: Digest, timezone: string) => format(digest.periodEnd, timezone, { weekday: 'long', day: 'numeric', month: 'long' })
const momentOf = (at: Date, timezone: string) =>
  format(at, timezone, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

function scheduleLine(schedule: Schedule): string {
  if (!schedule.enabled) return 'The daily digest is off.'
  const days = schedule.days === 'weekdays' ? 'Monday to Friday' : 'Every day'
  const next = schedule.nextAt ? `, next on ${momentOf(schedule.nextAt, schedule.timezone)}` : ''
  return `${days} at ${schedule.time} (${schedule.timezone})${next}.`
}

const initials = (name: string) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?'

const STYLE = `
:root { --canvas: #fcfcfc; --surface: #fff; --ink: #000000de; --ink-2: #5f5f5f; --ink-3: #8a8f94; --divider: #e0e5eb; --link: #0069d1;
  --soft: #f3f4f6; --danger-ink: #c10007; --danger-soft: #ffe9e9; --success-soft: #ecfccb; --success-ink: #3f6212; color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root { --canvas: #171718; --surface: #1d1d1f; --ink: #cfd2d5; --ink-2: #979a9d; --ink-3: #6f7276; --divider: #323840; --link: #5aabff;
    --soft: #26272a; --danger-ink: #ff8a8d; --danger-soft: #3a1c1e; --success-soft: #24300f; --success-ink: #a3e635; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--ink); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif; }
a { color: inherit; text-underline-offset: 2px; }
a:hover { color: var(--link); }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 24px; border-bottom: 1px solid var(--divider); }
.bar > div:first-child { flex: 1; min-width: 0; }
h1 { margin: 0; font-size: 15px; font-weight: 600; }
h2 { margin: 0; font-size: 20px; font-weight: 600; }
h3 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muted { color: var(--ink-2); margin: 0; font-size: 12px; }
.actions { display: flex; gap: 8px; }
.button { font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--divider); background: var(--surface); color: var(--ink); cursor: pointer; }
.button:hover { background: var(--soft); }
.button.primary { background: var(--ink); color: var(--surface); border-color: var(--ink); }
.button.ghost { border-color: transparent; padding: 3px 8px; color: var(--ink-2); }
.button:disabled { opacity: .5; cursor: default; }
main { max-width: 760px; margin: 0 auto; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.head > div { flex: 1; min-width: 0; }
.card { border: 1px solid var(--divider); border-radius: 8px; padding: 16px; background: var(--surface); }
.card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.avatar { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 999px; background: var(--soft); color: var(--ink-2); font-size: 11px; font-weight: 600; flex: none; }
.avatar.agent { border-radius: 6px; }
.kind { font-size: 11px; color: var(--ink-3); }
.label { font-size: 12px; font-weight: 600; color: var(--ink-2); margin: 12px 0 4px; }
ul { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }
.summary { display: flex; align-items: flex-start; gap: 12px; }
.summary p { margin: 0; flex: 1; }
.banner { margin: 16px 24px 0; padding: 8px 12px; border-radius: 6px; font-size: 13px; }
.banner.ok { background: var(--success-soft); color: var(--success-ink); }
.banner.bad { background: var(--danger-soft); color: var(--danger-ink); }
.error-text { color: var(--danger-ink); margin: 8px 0 0; }
.panel { margin: 16px 24px 0; }
.panel form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.panel label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ink-2); }
.panel .wide { grid-column: 1 / -1; }
.panel .check { flex-direction: row; align-items: center; gap: 8px; color: var(--ink); font-size: 13px; }
.panel .end { grid-column: 1 / -1; display: flex; justify-content: flex-end; }
input, select { font: inherit; font-size: 13px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--divider); background: var(--surface); color: var(--ink); }
.empty { text-align: center; padding: 48px 24px; color: var(--ink-2); }
.empty h2 { color: var(--ink); font-size: 16px; margin-bottom: 4px; }
.spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--divider); border-top-color: var(--ink-2); border-radius: 999px; animation: spin 1s linear infinite; margin-right: 8px; vertical-align: -2px; }
@keyframes spin { to { transform: rotate(360deg); } }
.offscreen { position: fixed; left: -10000px; top: 0; }
[hidden] { display: none !important; }
@media (max-width: 560px) { .bar, main { padding-left: 16px; padding-right: 16px; } .panel, .banner { margin-left: 16px; margin-right: 16px; } .panel form { grid-template-columns: 1fr; } }
`

const SCRIPT = `
const copies = JSON.parse(document.getElementById('copies')?.textContent || '[]')
async function copy(item) {
  try {
    if (window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([item.html], { type: 'text/html' }), 'text/plain': new Blob([item.text], { type: 'text/plain' }) })])
    } else await navigator.clipboard.writeText(item.text)
    return true
  } catch {
    const holder = document.createElement('div')
    holder.className = 'offscreen'
    holder.innerHTML = item.html
    document.body.append(holder)
    const range = document.createRange()
    range.selectNodeContents(holder)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    const done = document.execCommand('copy')
    selection.removeAllRanges()
    holder.remove()
    return done
  }
}
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy]')
  if (button) {
    const label = button.textContent
    button.textContent = (await copy(copies[Number(button.dataset.copy)])) ? 'Copied' : 'Could not copy'
    setTimeout(() => { button.textContent = label }, 1500)
  }
  const toggle = event.target.closest('[data-toggle]')
  if (toggle) { const panel = document.getElementById(toggle.dataset.toggle); panel.hidden = !panel.hidden }
})
document.querySelector('[data-picker]')?.addEventListener('change', (event) => event.target.form.submit())
const zone = document.querySelector('[data-default-zone]')
if (zone) zone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || zone.value
const body = document.body.dataset
if (body.writing) {
  if (Date.now() < Number(body.exp) - 10000) {
    setTimeout(() => location.replace('?' + new URLSearchParams({ factorix: body.token, digest: body.writing })), 5000)
  } else document.getElementById('stale').hidden = false
}
`

/** JSON inside a script block, with every character that could end the block escaped. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

function memberCard(member: DigestMemberContent, links: Record<string, string>, copyIndex: number): string {
  const sections = SECTIONS.filter((section) => member[section.key].length > 0)
    .map(
      (section) =>
        `<div class="label">${section.label}</div><ul>${member[section.key].map((line) => `<li>${lineHtml(line, links)}</li>`).join('')}</ul>`,
    )
    .join('')
  return `<article class="card">
  <div class="card-head">
    <span class="avatar${member.kind === 'agent' ? ' agent' : ''}">${esc(initials(member.name))}</span>
    <h3>${esc(member.name)}</h3>${member.kind === 'agent' ? '<span class="kind">Agent</span>' : ''}
    <button type="button" class="button ghost" data-copy="${copyIndex}">Copy</button>
  </div>
  ${sections}
</article>`
}

function digestSection(view: PageView, digest: Digest, copies: { html: string; text: string }[]): string {
  const { timezone } = view.schedule
  const run = digest.runUrl ? `<a href="${esc(digest.runUrl)}" target="_blank" rel="noreferrer">the run</a>` : 'the run'
  const picker =
    view.digests.length > 1
      ? `<form method="get" class="picker"><input type="hidden" name="factorix" value="${esc(view.token)}">
  <select name="digest" data-picker aria-label="Pick a digest">${view.digests
    .map((item) => `<option value="${esc(item.id)}"${item.id === digest.id ? ' selected' : ''}>${esc(momentOf(item.periodEnd, timezone))}</option>`)
    .join('')}</select><noscript><button class="button">Show</button></noscript></form>`
      : ''
  const head = `<div class="head"><div><h2>${esc(dayOf(digest, timezone))}</h2>
  <p class="muted">From ${esc(momentOf(digest.periodStart, timezone))} to ${esc(momentOf(digest.periodEnd, timezone))} (${esc(timezone)})</p></div>${picker}</div>`

  if (digest.status === 'writing')
    return `${head}<div class="card muted"><span class="spinner"></span>The agent is writing this digest. It shows up here when ${run} finishes.<span id="stale" hidden> Open Digest again in the sidebar to see it once it is done.</span></div>`
  if (digest.status === 'failed' || !digest.content)
    return `${head}<div class="card">The agent did not finish this digest.${digest.error ? `<p class="error-text">${esc(digest.error)}</p>` : ''}${
      digest.runUrl ? `<p class="muted">Open ${run} to see why.</p>` : ''
    }</div>`

  const content = digest.content
  const links = linksOf(digest.facts)
  const title = `Daily digest, ${dayOf(digest, timezone)}`
  const all = copies.push(digestCopy(content, links, title)) - 1
  const cards = content.members.map((member) => memberCard(member, links, copies.push(digestCopy(content, links, title, member)) - 1)).join('')
  const copyAll = content.members.length > 0 ? `<button type="button" class="button" data-copy="${all}">Copy all</button>` : ''
  return `${head}<div class="summary"><p>${esc(content.summary)}</p>${copyAll}</div>${cards}`
}

function schedulePanel(view: PageView): string {
  const { schedule } = view
  const fresh = !schedule.agentId
  const agents = (view.agents ?? []).filter((agent) => agent.status === 'active' || agent.id === schedule.agentId)
  const agentField = view.agents
    ? `<select name="agentId"><option value="">Pick an agent</option>${agents
        .map(
          (agent) =>
            `<option value="${esc(agent.id)}"${agent.id === schedule.agentId ? ' selected' : ''}>${esc(agent.name)} (${esc(agent.model ?? agent.runtime)})</option>`,
        )
        .join('')}</select>`
    : `<p class="error-text">Factorix did not list the agents: ${esc(view.agentsError ?? 'no answer')}</p>`
  return `<section id="schedule" class="panel card"${fresh || view.error ? '' : ' hidden'}>
  <form method="post" action="?factorix=${esc(encodeURIComponent(view.token))}">
    <input type="hidden" name="intent" value="schedule">
    <label class="check wide"><input type="checkbox" name="enabled"${schedule.enabled ? ' checked' : ''}> Write a digest by itself</label>
    <label>Days<select name="days">${DAYS.map((day) => `<option value="${day.value}"${day.value === schedule.days ? ' selected' : ''}>${day.label}</option>`).join('')}</select></label>
    <label>Time<input type="time" name="time" required value="${esc(schedule.time)}"></label>
    <label class="wide">Time zone, as in Europe/Warsaw<input name="timezone" required value="${esc(schedule.timezone)}"${fresh ? ' data-default-zone' : ''}></label>
    <label class="wide">Written by. The agent reads what the team did and writes the digest. It gets no repository, and each digest is one run.${agentField}</label>
    <div class="end"><button class="button primary">Save</button></div>
  </form>
</section>`
}

export function renderPage(view: PageView): string {
  const copies: { html: string; text: string }[] = []
  const { schedule, selected } = view
  const writing = selected?.status === 'writing' || view.digests[0]?.status === 'writing'
  const actions = view.admin
    ? `<div class="actions"><button type="button" class="button" data-toggle="schedule">Schedule</button>${
        schedule.agentId
          ? `<form method="post" action="?factorix=${esc(encodeURIComponent(view.token))}"><input type="hidden" name="intent" value="write"><button class="button primary"${writing ? ' disabled' : ''}>Write now</button></form>`
          : ''
      }</div>`
    : ''
  const banners = [
    view.notice ? `<div class="banner ok">${esc(view.notice)}</div>` : '',
    view.error ? `<div class="banner bad">${esc(view.error)}</div>` : '',
  ].join('')
  const body = selected
    ? digestSection(view, selected, copies)
    : `<div class="empty"><h2>No digest yet</h2><p>Once a day an agent writes what each person and agent finished, what is in progress, and what comes next, ready to paste into a channel.${
        view.admin ? ' Set the schedule to start.' : ''
      }</p></div>`
  const data = [
    `data-token="${esc(view.token)}"`,
    `data-exp="${view.exp}"`,
    selected?.status === 'writing' ? `data-writing="${esc(selected.id)}"` : '',
  ].join(' ')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Digest</title>
<style nonce="${view.nonce}">${STYLE}</style>
</head>
<body ${data}>
<header class="bar"><div><h1>Digest</h1><p class="muted">${esc(scheduleLine(schedule))}</p></div>${actions}</header>
${banners}
${view.admin ? schedulePanel(view) : ''}
<main>${body}</main>
<script type="application/json" id="copies">${scriptJson(copies)}</script>
<script nonce="${view.nonce}">${SCRIPT}</script>
</body>
</html>`
}
