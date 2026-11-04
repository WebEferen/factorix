import { createHash } from 'node:crypto'
import { LinearWebhookClient } from '@linear/sdk/webhooks'
import type { Headers, TrackerComment, TrackerIssue, TrackerLabel, TrackerStateType, TrackerWebhookCodec, TrackerWebhookEvent } from '../tracker'

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

interface IssueData {
  id: string
  identifier: string
  title: string
  description?: string | null
  url?: string | null
  priority?: number | null
  teamId: string
  projectId?: string | null
  stateId: string
  state?: { id: string; name: string; type: string } | null
  assigneeId?: string | null
  assignee?: { id: string; name?: string | null } | null
  creatorId?: string | null
  creator?: { id: string; name?: string | null } | null
  labels?: { id: string; name: string; parentId?: string | null }[] | null
  createdAt?: string | null
  updatedAt: string
  archivedAt?: string | null
}

interface CommentData {
  id: string
  body: string
  issueId?: string | null
  userId?: string | null
  user?: { id: string; name?: string | null } | null
  createdAt: string
}

interface Envelope {
  action?: string
  type?: string
  data?: unknown
  updatedFrom?: { stateId?: string; labelIds?: string[] } | null
}

function mapIssue(data: IssueData): TrackerIssue {
  return {
    id: data.id,
    identifier: data.identifier,
    title: data.title,
    description: data.description ?? null,
    url: data.url ?? null,
    priority: data.priority ?? 0,
    teamId: data.teamId,
    projectId: data.projectId ?? null,
    stateId: data.stateId,
    stateName: data.state?.name ?? '',
    stateType: (data.state?.type ?? 'unstarted') as TrackerStateType,
    assigneeId: data.assigneeId ?? null,
    assigneeName: data.assignee?.name ?? null,
    creatorId: data.creatorId ?? null,
    creatorName: data.creator?.name ?? null,
    labels: (data.labels ?? []).map((label): TrackerLabel => ({ id: label.id, name: label.name, parentId: label.parentId ?? null })),
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt,
    archivedAt: data.archivedAt ?? null,
  }
}

export const linearWebhookCodec: TrackerWebhookCodec = {
  deliveryId(headers, rawBody) {
    return header(headers, 'linear-delivery') ?? createHash('sha256').update(rawBody).digest('hex')
  },

  verify(rawBody, headers, secret) {
    const signature = header(headers, 'linear-signature')
    if (!signature || !secret) return false
    try {
      return new LinearWebhookClient(secret).verify(rawBody, signature)
    } catch {
      return false
    }
  },

  parse(payload): TrackerWebhookEvent {
    const envelope = payload as Envelope
    if (envelope.type === 'Issue') {
      const data = envelope.data as IssueData
      if (envelope.action === 'remove') return { kind: 'issue.removed', issueId: data.id }
      return {
        kind: 'issue.upserted',
        issue: mapIssue(data),
        previousStateId: envelope.updatedFrom?.stateId,
        previousLabelIds: envelope.updatedFrom?.labelIds,
      }
    }
    if (envelope.type === 'Comment') {
      const data = envelope.data as CommentData
      if (!data.issueId) return { kind: 'ignored', reason: 'comment is not on an issue' }
      if (envelope.action !== 'create' && envelope.action !== 'update') return { kind: 'ignored', reason: `comment ${envelope.action}` }
      const comment: TrackerComment = {
        id: data.id,
        issueId: data.issueId,
        body: data.body,
        authorId: data.userId ?? null,
        authorName: data.user?.name ?? null,
        createdAt: data.createdAt,
      }
      return { kind: 'comment.upserted', comment, action: envelope.action }
    }
    return { kind: 'ignored', reason: `unhandled type ${envelope.type}` }
  },
}
