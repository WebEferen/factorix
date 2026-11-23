import type { Activity, ActivityIssue } from '@moxxy/factorix-plugin-sdk'

export interface DigestTicket {
  identifier: string
  title: string
  project: string
  status: string | null
  url: string | null
  /** What happened to it in the period: merged merge requests, and what agents reported. */
  notes: string[]
}

export interface DigestMemberFacts {
  name: string
  kind: 'human' | 'agent'
  done: DigestTicket[]
  inProgress: DigestTicket[]
  next: DigestTicket[]
}

export interface DigestFacts {
  members: DigestMemberFacts[]
}

const MAX_MEMBERS = 30
const MAX_PER_LIST = { done: 12, inProgress: 8, next: 5 }
const MAX_NOTES = 3
const MAX_NOTE_CHARS = 240
const MAX_TITLE_CHARS = 160
const IN_FACTORY = ['queued', 'active', 'waiting_human', 'awaiting_merge', 'failed']

type ListKey = keyof typeof MAX_PER_LIST

function listOf(issue: ActivityIssue, since: Date): ListKey | null {
  if (issue.statusType === 'completed' || issue.factoryState === 'done') return Date.parse(issue.updatedAt) >= since.getTime() ? 'done' : null
  if (issue.statusType === 'canceled' || issue.factoryState === 'cancelled') return null
  if (issue.statusType === 'started' || IN_FACTORY.includes(issue.factoryState)) return 'inProgress'
  return issue.statusType === 'unstarted' ? 'next' : null
}

const rank = (priority: number) => (priority === 0 ? 5 : priority)
const newest = (a: string, b: string) => Date.parse(b) - Date.parse(a)

/**
 * What each member finished since `since`, has in progress, and has waiting, most urgent first. A member is the person
 * a ticket is assigned to in the tracker, or the agent it is assigned to in Factorix, so a ticket with both shows under both.
 */
export function factsFrom(activity: Activity, since: Date): DigestFacts {
  const listed = [...activity.issues]
    .sort((a, b) => rank(a.priority) - rank(b.priority) || newest(a.updatedAt, b.updatedAt))
    .flatMap((issue) => {
      const list = listOf(issue, since)
      return list ? [{ issue, list }] : []
    })
  if (listed.length === 0) return { members: [] }

  const notes = new Map<string, string[]>()
  const note = (issueId: string, text: string) => {
    const existing = notes.get(issueId) ?? []
    if (existing.length < MAX_NOTES) notes.set(issueId, [...existing, text.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS)])
  }
  for (const merge of [...activity.merges].sort((a, b) => newest(a.mergedAt, b.mergedAt))) note(merge.issueId, `Merge request merged: ${merge.url}`)
  for (const report of [...activity.reports].sort((a, b) => newest(a.finishedAt, b.finishedAt)))
    note(report.issueId, `${report.agent} (${report.phase}): ${report.summary}`)

  const members = new Map<string, DigestMemberFacts>()
  const memberFor = (key: string, name: string, kind: DigestMemberFacts['kind']) => {
    const existing = members.get(key)
    if (existing) return existing
    const member: DigestMemberFacts = { name, kind, done: [], inProgress: [], next: [] }
    members.set(key, member)
    return member
  }
  for (const { issue, list } of listed) {
    const ticket: DigestTicket = {
      identifier: issue.identifier,
      title: issue.title.slice(0, MAX_TITLE_CHARS),
      project: issue.project,
      status: issue.status,
      url: issue.url,
      notes: [
        ...(list === 'inProgress' && issue.factoryState !== 'untracked' ? [`In the factory: ${issue.factoryState.replace('_', ' ')}`] : []),
        ...(notes.get(issue.id) ?? []),
      ],
    }
    const agent = issue.agent
    const assignee = issue.assignee?.name.trim()
    // An agent with its own tracker account is the assignee there too, and is one member, not two.
    const sameMember = agent && assignee && [agent.name, agent.handle].some((name) => name.toLowerCase() === assignee.toLowerCase())
    const owners = [
      ...(assignee && !sameMember ? [memberFor(`human:${issue.assignee?.id ?? assignee}`, assignee, 'human')] : []),
      ...(agent ? [memberFor(`agent:${agent.id}`, agent.name, 'agent')] : []),
    ]
    for (const owner of owners) if (owner[list].length < MAX_PER_LIST[list]) owner[list].push(ticket)
  }

  const sorted = [...members.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'human' ? -1 : 1))
  // The agent's answer is matched to a member by name, so two members cannot share one.
  const taken = new Set<string>()
  for (const member of sorted) {
    const base = member.name
    for (let n = 2; taken.has(member.name.toLowerCase()); n++) member.name = member.kind === 'agent' && n === 2 ? `${base} (agent)` : `${base} (${n})`
    taken.add(member.name.toLowerCase())
  }
  return { members: sorted.slice(0, MAX_MEMBERS) }
}

/** Where each ticket the digest was written from lives, by identifier. Only web addresses, since they become links. */
export function linksOf(facts: DigestFacts): Record<string, string> {
  const links: Record<string, string> = {}
  for (const member of facts.members)
    for (const ticket of [...member.done, ...member.inProgress, ...member.next])
      if (ticket.url && /^https?:\/\//.test(ticket.url)) links[ticket.identifier] = ticket.url
  return links
}
