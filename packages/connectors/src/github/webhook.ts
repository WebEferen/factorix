import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { ScmWebhookCodec, ScmWebhookEvent } from '../scm'
import type { Headers } from '../tracker'
import { mapCheckConclusion, mapCommitState, mapIssueComment, mapReview, mapReviewComment } from './client'

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name]
  return Array.isArray(value) ? value[0] : value
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

const PULL_ACTIONS: Record<string, 'mr.opened' | 'mr.updated'> = {
  opened: 'mr.opened',
  reopened: 'mr.opened',
  ready_for_review: 'mr.opened',
  synchronize: 'mr.updated',
  edited: 'mr.updated',
}

// biome-ignore lint/suspicious/noExplicitAny: GitHub webhook bodies, read field by field
type Loose = Record<string, any>

export const githubWebhookCodec: ScmWebhookCodec = {
  deliveryId(headers, rawBody) {
    return header(headers, 'x-github-delivery') ?? createHash('sha256').update(rawBody).digest('hex')
  },

  verify(rawBody, headers, secret) {
    const signature = header(headers, 'x-hub-signature-256')
    if (!signature || !secret) return false
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
    return timingSafeEqual(digest(signature), digest(expected))
  },

  parse(headers, payload): ScmWebhookEvent {
    const body = payload as Loose
    const event = header(headers, 'x-github-event')
    const repoId = String(body.repository?.id)
    if (event === 'pull_request') {
      const pull = body.pull_request as Loose
      const kind = body.action === 'closed' ? (pull.merged ? 'mr.merged' : 'mr.closed') : PULL_ACTIONS[body.action as string]
      if (!kind) return { kind: 'ignored', reason: `pull request action ${body.action}` }
      return { kind, repoId, iid: pull.number, url: pull.html_url ?? null, sourceBranch: pull.head?.ref ?? null, sha: pull.head?.sha ?? null }
    }
    if (event === 'pull_request_review') {
      const review = body.review as Loose
      const pull = body.pull_request as Loose
      if (body.action !== 'submitted' && body.action !== 'edited') return { kind: 'ignored', reason: `review action ${body.action}` }
      // A review's own text is a comment to answer. Its inline comments arrive as their own events.
      if (String(review.body ?? '').trim())
        return { kind: 'mr.note', repoId, iid: pull.number, discussionId: `v${review.id}`, note: mapReview(review) }
      if (String(review.state).toLowerCase() !== 'approved') return { kind: 'ignored', reason: `review ${review.state} without text` }
      return {
        kind: 'mr.approved',
        repoId,
        iid: pull.number,
        url: pull.html_url ?? null,
        sourceBranch: pull.head?.ref ?? null,
        sha: pull.head?.sha ?? null,
      }
    }
    if (event === 'pull_request_review_comment') {
      const comment = body.comment as Loose
      if (body.action !== 'created' && body.action !== 'edited') return { kind: 'ignored', reason: `review comment action ${body.action}` }
      return {
        kind: 'mr.note',
        repoId,
        iid: body.pull_request.number,
        discussionId: `r${comment.in_reply_to_id ?? comment.id}`,
        note: mapReviewComment(comment),
      }
    }
    if (event === 'issue_comment') {
      if (!body.issue?.pull_request) return { kind: 'ignored', reason: 'comment on an issue' }
      if (body.action !== 'created' && body.action !== 'edited') return { kind: 'ignored', reason: `comment action ${body.action}` }
      return { kind: 'mr.note', repoId, iid: body.issue.number, discussionId: `c${body.comment.id}`, note: mapIssueComment(body.comment) }
    }
    if (event === 'check_suite') {
      const suite = body.check_suite as Loose
      if (body.action !== 'completed') return { kind: 'ignored', reason: `check suite action ${body.action}` }
      return {
        kind: 'pipeline',
        repoId,
        iid: suite.pull_requests?.[0]?.number ?? null,
        ref: suite.head_branch ?? null,
        sha: suite.head_sha ?? null,
        status: mapCheckConclusion(suite.conclusion),
        pipelineId: String(suite.id),
      }
    }
    if (event === 'status') {
      return {
        kind: 'pipeline',
        repoId,
        iid: null,
        ref: body.branches?.[0]?.name ?? null,
        sha: body.sha ?? null,
        status: mapCommitState(body.state),
        pipelineId: String(body.id),
      }
    }
    return { kind: 'ignored', reason: `unhandled event ${event}` }
  },
}
