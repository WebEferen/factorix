import { createHash, timingSafeEqual } from 'node:crypto'
import type { ScmWebhookCodec, ScmWebhookEvent } from '../scm'
import type { Headers } from '../tracker'
import { mapCiStatus } from './client'

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name]
  return Array.isArray(value) ? value[0] : value
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

const MR_ACTIONS: Record<string, 'mr.opened' | 'mr.updated' | 'mr.merged' | 'mr.closed' | 'mr.approved'> = {
  open: 'mr.opened',
  reopen: 'mr.opened',
  update: 'mr.updated',
  merge: 'mr.merged',
  close: 'mr.closed',
  approved: 'mr.approved',
  approval: 'mr.approved',
}

// biome-ignore lint/suspicious/noExplicitAny: GitLab webhook bodies, read field by field
type Loose = Record<string, any>

export const gitlabWebhookCodec: ScmWebhookCodec = {
  deliveryId(headers, rawBody) {
    return header(headers, 'x-gitlab-event-uuid') ?? header(headers, 'idempotency-key') ?? createHash('sha256').update(rawBody).digest('hex')
  },

  verify(_rawBody, headers, secret) {
    const token = header(headers, 'x-gitlab-token')
    if (!token || !secret) return false
    return timingSafeEqual(digest(token), digest(secret))
  },

  parse(headers, payload): ScmWebhookEvent {
    const body = payload as Loose
    const attributes = (body.object_attributes ?? {}) as Loose
    const event = header(headers, 'x-gitlab-event')
    if (event === 'Merge Request Hook' || body.object_kind === 'merge_request') {
      const kind = MR_ACTIONS[attributes.action as string]
      if (!kind) return { kind: 'ignored', reason: `merge request action ${attributes.action}` }
      return {
        kind,
        repoId: String(body.project?.id ?? attributes.target_project_id),
        iid: attributes.iid,
        url: attributes.url ?? null,
        sourceBranch: attributes.source_branch ?? null,
        sha: attributes.last_commit?.id ?? null,
      }
    }
    if (event === 'Note Hook' || body.object_kind === 'note') {
      if (attributes.noteable_type !== 'MergeRequest' || !body.merge_request)
        return { kind: 'ignored', reason: `note on ${attributes.noteable_type}` }
      const position = attributes.position as Loose | undefined
      return {
        kind: 'mr.note',
        repoId: String(body.project_id ?? body.project?.id),
        iid: body.merge_request.iid,
        discussionId: attributes.discussion_id ?? '',
        note: {
          id: String(attributes.id),
          body: attributes.note ?? '',
          author: body.user?.username ?? 'unknown',
          system: Boolean(attributes.system),
          path: position?.new_path ?? position?.old_path ?? null,
          line: position?.new_line ?? position?.old_line ?? null,
          createdAt: attributes.created_at ?? new Date().toISOString(),
          resolvable: Boolean(attributes.resolvable ?? position),
          resolved: Boolean(attributes.resolved_at),
        },
      }
    }
    if (event === 'Pipeline Hook' || body.object_kind === 'pipeline') {
      return {
        kind: 'pipeline',
        repoId: String(body.project?.id),
        iid: body.merge_request?.iid ?? null,
        ref: attributes.ref ?? null,
        sha: attributes.sha ?? null,
        status: mapCiStatus(attributes.status),
        pipelineId: String(attributes.id),
      }
    }
    return { kind: 'ignored', reason: `unhandled event ${event}` }
  },
}
