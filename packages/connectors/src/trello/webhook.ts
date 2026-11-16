import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Headers, TrackerIssue, TrackerWebhookCodec, TrackerWebhookEvent } from '../tracker'
import { mapTrelloComment } from './client'

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

// biome-ignore lint/suspicious/noExplicitAny: Trello webhook bodies, read field by field
type Loose = Record<string, any>

const CARD_ACTIONS = new Set([
  'createCard',
  'copyCard',
  'updateCard',
  'moveCardToBoard',
  'convertToCardFromCheckItem',
  'addLabelToCard',
  'removeLabelFromCard',
  'addMemberToCard',
  'removeMemberFromCard',
])

export const trelloWebhookCodec: TrackerWebhookCodec = {
  deliveryId(_headers, rawBody) {
    try {
      const id = (JSON.parse(rawBody.toString('utf8')) as Loose).action?.id
      if (typeof id === 'string') return id
    } catch {}
    return createHash('sha256').update(rawBody).digest('hex')
  },

  /** Trello signs the body followed by the address it called, with the API secret that belongs to the key. */
  verify(rawBody, headers, secret, callbackUrl) {
    const signature = header(headers, 'x-trello-webhook')
    if (!signature || !secret || !callbackUrl) return false
    const expected = createHmac('sha1', secret)
      .update(Buffer.concat([rawBody, Buffer.from(callbackUrl)]))
      .digest('base64')
    return timingSafeEqual(digest(signature), digest(expected))
  },

  parse(payload): TrackerWebhookEvent {
    const action = (payload as Loose).action as Loose | undefined
    const data = (action?.data ?? {}) as Loose
    const type = String(action?.type ?? '')
    if (!data.card?.id) return { kind: 'ignored', reason: `unhandled action ${type}` }
    if (type === 'deleteCard') return { kind: 'issue.removed', issueId: data.card.id }
    if (type === 'commentCard') return { kind: 'comment.upserted', comment: mapTrelloComment(action as Loose), action: 'create' }
    if (type === 'updateComment') {
      return {
        kind: 'comment.upserted',
        comment: { ...mapTrelloComment(action as Loose), id: data.action?.id ?? action?.id, body: data.action?.text ?? '' },
        action: 'update',
      }
    }
    if (!CARD_ACTIONS.has(type)) return { kind: 'ignored', reason: `unhandled action ${type}` }
    // An action names the card and what changed, not the card itself. An empty status tells the caller to read the rest.
    const issue: TrackerIssue = {
      id: data.card.id,
      identifier: '',
      title: data.card.name ?? '',
      description: null,
      url: null,
      priority: 0,
      teamId: data.board?.id ?? '',
      projectId: null,
      stateId: data.listAfter?.id ?? data.list?.id ?? data.card.idList ?? '',
      stateName: '',
      stateType: 'unstarted',
      assigneeId: null,
      assigneeName: null,
      creatorId: null,
      creatorName: null,
      labels: [],
      createdAt: null,
      updatedAt: action?.date ?? new Date().toISOString(),
      archivedAt: null,
    }
    return { kind: 'issue.upserted', issue, ...(data.listBefore?.id ? { previousStateId: data.listBefore.id } : {}) }
  },
}
