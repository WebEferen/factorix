import type { Activity, ActivityIssue } from '@moxxylabs/factorix-plugin-sdk'
import { describe, expect, it } from 'vitest'
import { factsFrom, linksOf } from './facts'

const SINCE = new Date('2026-11-17T16:00:00Z')
const RECENT = '2026-11-18T10:00:00Z'
const ENGINEER = { id: 'agent-1', handle: 'engineer-1', name: 'Eng One' }

let counter = 0
function issue(fields: Partial<ActivityIssue>): ActivityIssue {
  counter += 1
  return {
    id: `issue-${counter}`,
    identifier: `ENG-${counter}`,
    title: `Ticket ${counter}`,
    url: `https://linear.app/acme/issue/ENG-${counter}`,
    project: 'Platform',
    priority: 0,
    status: 'Todo',
    statusType: 'unstarted',
    factoryState: 'untracked',
    assignee: null,
    agent: null,
    updatedAt: RECENT,
    ...fields,
  }
}
const activity = (issues: ActivityIssue[], extra: Partial<Activity> = {}): Activity => ({
  issues,
  merges: [],
  reports: [],
  truncated: false,
  ...extra,
})
const ids = (list: { identifier: string }[]) => list.map((ticket) => ticket.identifier)
const ada = { id: 'u-ada', name: 'Ada' }
const bo = { id: 'u-bo', name: 'Bo' }

describe('factsFrom', () => {
  it('sorts what each member finished, is doing, and has waiting', () => {
    const done = issue({ assignee: ada, statusType: 'completed', status: 'Done' })
    const doing = issue({ assignee: ada, statusType: 'started', status: 'In Progress', agent: ENGINEER, factoryState: 'active' })
    const waiting = issue({ assignee: bo, statusType: 'unstarted' })
    const old = issue({ assignee: bo, statusType: 'completed', updatedAt: '2026-11-15T10:00:00Z' })
    const dropped = issue({ assignee: bo, statusType: 'canceled' })
    const backlog = issue({ assignee: bo, statusType: 'backlog' })
    const facts = factsFrom(activity([done, doing, waiting, old, dropped, backlog]), SINCE)

    expect(facts.members.map((member) => [member.name, member.kind])).toEqual([
      ['Ada', 'human'],
      ['Bo', 'human'],
      ['Eng One', 'agent'],
    ])
    const [first, second, third] = facts.members
    expect(ids(first?.done ?? [])).toEqual([done.identifier])
    expect(ids(first?.inProgress ?? [])).toEqual([doing.identifier])
    expect(ids(second?.next ?? [])).toEqual([waiting.identifier])
    expect(second?.done).toEqual([])
    expect(ids(third?.inProgress ?? [])).toEqual([doing.identifier])
    expect(third?.inProgress[0]?.notes).toEqual(['In the factory: active'])
  })

  it('counts a ticket the factory finished as done, and one it is working on as in progress', () => {
    const merged = issue({ agent: ENGINEER, statusType: 'started', factoryState: 'done' })
    const queued = issue({ agent: ENGINEER, statusType: 'unstarted', factoryState: 'queued' })
    const [engineer] = factsFrom(activity([merged, queued]), SINCE).members
    expect(ids(engineer?.done ?? [])).toEqual([merged.identifier])
    expect(ids(engineer?.inProgress ?? [])).toEqual([queued.identifier])
  })

  it('treats an agent that is its own tracker assignee as one member', () => {
    const own = issue({ assignee: { id: 'u-eng', name: 'engineer-1' }, agent: ENGINEER, statusType: 'started' })
    expect(factsFrom(activity([own]), SINCE).members.map((member) => member.name)).toEqual(['Eng One'])
  })

  it('keeps two members with one name apart, since the answer is matched by name', () => {
    const facts = factsFrom(
      activity([
        issue({ assignee: { id: 'u-1', name: 'Eng One' }, statusType: 'started' }),
        issue({ agent: ENGINEER, statusType: 'started' }),
        issue({ assignee: { id: 'u-2', name: 'eng one' }, statusType: 'started' }),
      ]),
      SINCE,
    )
    expect(facts.members.map((member) => member.name)).toEqual(['eng one', 'Eng One (2)', 'Eng One (agent)'])
  })

  it('puts the most urgent first and keeps each list short', () => {
    const tickets = Array.from({ length: 8 }, (_, index) => issue({ assignee: bo, priority: index % 4, updatedAt: `2026-11-18T0${index}:00:00Z` }))
    const [member] = factsFrom(activity(tickets), SINCE).members
    expect(member?.next).toHaveLength(5)
    expect(ids(member?.next ?? [])).toEqual([5, 1, 6, 2, 7].map((index) => tickets[index]?.identifier))
  })

  it('notes merges and what agents reported, newest first, and links only web addresses', () => {
    const shipped = issue({ assignee: ada, statusType: 'completed', title: 'x'.repeat(300) })
    const local = issue({ assignee: ada, statusType: 'started', url: 'javascript:alert(1)' })
    const facts = factsFrom(
      activity([shipped, local], {
        merges: [{ issueId: shipped.id, url: 'https://gitlab.com/g/r/-/merge_requests/1', mergedAt: '2026-11-18T09:00:00Z' }],
        reports: [
          { issueId: shipped.id, agent: 'reviewer-1', phase: 'review', summary: 'Looks   good', finishedAt: '2026-11-18T08:00:00Z' },
          { issueId: shipped.id, agent: 'engineer-1', phase: 'implement', summary: 'Built it', finishedAt: '2026-11-18T07:00:00Z' },
          { issueId: shipped.id, agent: 'engineer-1', phase: 'implement', summary: 'Too many', finishedAt: '2026-11-18T06:00:00Z' },
        ],
      }),
      SINCE,
    )
    const ticket = facts.members[0]?.done[0]
    expect(ticket?.title).toHaveLength(160)
    expect(ticket?.notes).toEqual([
      'Merge request merged: https://gitlab.com/g/r/-/merge_requests/1',
      'reviewer-1 (review): Looks good',
      'engineer-1 (implement): Built it',
    ])
    expect(linksOf(facts)).toEqual({ [shipped.identifier]: shipped.url })
  })

  it('has no members when nobody had anything', () => {
    expect(factsFrom(activity([issue({ statusType: 'started' })]), SINCE)).toEqual({ members: [] })
  })
})
