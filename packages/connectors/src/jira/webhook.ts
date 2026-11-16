import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Headers, TrackerWebhookCodec, TrackerWebhookEvent } from '../tracker'
import { mapJiraComment, mapJiraIssue } from './client'

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

// biome-ignore lint/suspicious/noExplicitAny: Jira webhook bodies, read field by field
type Loose = Record<string, any>

/** Jira signs a webhook only when it was given a secret, which Cloud supports and Data Center does not. */
export const jiraWebhookCodec: TrackerWebhookCodec = {
  deliveryId(headers, rawBody) {
    return header(headers, 'x-atlassian-webhook-identifier') ?? createHash('sha256').update(rawBody).digest('hex')
  },

  verify(rawBody, headers, secret) {
    const signature = header(headers, 'x-hub-signature')
    if (!signature || !secret) return false
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
    return timingSafeEqual(digest(signature), digest(expected))
  },

  parse(payload): TrackerWebhookEvent {
    const body = payload as Loose
    const event = String(body.webhookEvent ?? '')
    if (event === 'jira:issue_created' || event === 'jira:issue_updated') {
      if (!body.issue?.fields) return { kind: 'ignored', reason: 'issue without fields' }
      const moved = ((body.changelog?.items as Loose[]) ?? []).find((item) => item.field === 'status')
      return { kind: 'issue.upserted', issue: mapJiraIssue(body.issue), ...(moved?.from ? { previousStateId: String(moved.from) } : {}) }
    }
    if (event === 'jira:issue_deleted' && body.issue?.id) return { kind: 'issue.removed', issueId: String(body.issue.id) }
    if ((event === 'comment_created' || event === 'comment_updated') && body.comment && body.issue?.id) {
      return {
        kind: 'comment.upserted',
        comment: mapJiraComment(body.comment, String(body.issue.id)),
        action: event === 'comment_created' ? 'create' : 'update',
      }
    }
    return { kind: 'ignored', reason: `unhandled event ${event}` }
  },
}
