import { createHash } from 'node:crypto'
import { linearMarkup } from '../linear/markup'
import type { SourceMarkup, TrackerSource } from '../source'
import type { Headers, TrackerComment, TrackerIssue, TrackerWebhookCodec, TrackerWebhookEvent } from '../tracker'
import { PLUGIN_DELIVERY_HEADER, PLUGIN_SIGNATURE_HEADER, PLUGIN_TIMESTAMP_HEADER, verifyPlugin } from './protocol'

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** A plugin sends events already in Factorix's own shape, as `{ event }`, signed like the calls it receives. */
export const pluginWebhookCodec: TrackerWebhookCodec = {
  deliveryId(headers, rawBody) {
    return header(headers, PLUGIN_DELIVERY_HEADER)?.slice(0, 200) || createHash('sha256').update(rawBody).digest('hex')
  },

  verify(rawBody, headers, secret) {
    return verifyPlugin(secret, header(headers, PLUGIN_TIMESTAMP_HEADER), header(headers, PLUGIN_SIGNATURE_HEADER), rawBody)
  },

  parse(payload): TrackerWebhookEvent {
    const event = ((payload as { event?: unknown } | null)?.event ?? {}) as Record<string, unknown>
    if (event.kind === 'issue.removed' && isText(event.issueId)) return { kind: 'issue.removed', issueId: event.issueId }
    if (event.kind === 'issue.upserted' && isText((event.issue as TrackerIssue | undefined)?.id)) {
      // Only the id is trusted. With no status name the caller reads the issue from the plugin, the same way a poll would.
      const issue = event.issue as TrackerIssue
      return {
        kind: 'issue.upserted',
        issue: { ...issue, identifier: '', stateName: '' },
        ...(isText(event.previousStateId) ? { previousStateId: event.previousStateId } : {}),
      }
    }
    const comment = event.comment as TrackerComment | undefined
    if (event.kind === 'comment.upserted' && isText(comment?.id) && isText(comment?.issueId) && typeof comment?.body === 'string') {
      return {
        kind: 'comment.upserted',
        comment: {
          id: comment.id,
          issueId: comment.issueId,
          body: comment.body,
          authorId: isText(comment.authorId) ? comment.authorId : null,
          authorName: isText(comment.authorName) ? comment.authorName : null,
          createdAt: isText(comment.createdAt) ? comment.createdAt : new Date().toISOString(),
        },
        action: event.action === 'update' ? 'update' : 'create',
      }
    }
    return { kind: 'ignored', reason: `unhandled event ${String(event.kind)}` }
  },
}

/** A plugin's text is Markdown, and its issues are named like Linear's, as ABC-12. */
export const pluginMarkup: SourceMarkup = {
  isMediaUrl: () => false,
  toMarkdown: (text) => text,
  linkReferences: linearMarkup.linkReferences,
  issueReferences: linearMarkup.issueReferences,
}

export const pluginSource: TrackerSource = {
  markup: pluginMarkup,
  issueFilters: [
    { key: 'title', label: 'Title', kind: 'text' },
    { key: 'status', label: 'Status', kind: 'multi' },
    { key: 'priority', label: 'Priority', kind: 'multi' },
    { key: 'assignee', label: 'Assignee', kind: 'multi' },
    { key: 'author', label: 'Creator', kind: 'multi' },
    { key: 'label', label: 'Label', kind: 'multi' },
  ],
  issueSorts: [
    { key: 'updated', label: 'Updated', asc: 'Oldest first', desc: 'Newest first' },
    { key: 'created', label: 'Created', asc: 'Oldest first', desc: 'Newest first' },
    { key: 'priority', label: 'Priority', asc: 'Highest first', desc: 'Lowest first' },
    { key: 'status', label: 'Status', asc: 'Not started first', desc: 'Finished first' },
    { key: 'title', label: 'Title', asc: 'A to Z', desc: 'Z to A' },
    { key: 'identifier', label: 'Number', asc: 'Lowest first', desc: 'Highest first' },
  ],
  priorityLabels: { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' },
  egressHosts: () => [],
}
