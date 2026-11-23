import { createHmac, timingSafeEqual } from 'node:crypto'

/** Slack signs each request with the app's signing secret; an old timestamp is refused so a captured request cannot be replayed. */
const MAX_AGE_SECONDS = 300

export type SlackEvent =
  | { kind: 'challenge'; challenge: string }
  | {
      kind: 'message' | 'mention'
      id: string
      channel: string
      /** `im` for a direct message to the app, as Slack names it. */
      channelType: string
      user: string
      text: string
      ts: string
      thread: string
    }
  | { kind: 'ignored' }

type Headers = Record<string, string | string[] | undefined>

const header = (headers: Headers, name: string) => [headers[name]].flat()[0]

export function verifySlackRequest(rawBody: Buffer, headers: Headers, signingSecret: string, now = Date.now()): boolean {
  const timestamp = header(headers, 'x-slack-request-timestamp')
  const signature = header(headers, 'x-slack-signature')
  if (!signingSecret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_AGE_SECONDS) return false
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:`).update(rawBody).digest('hex')}`
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Reads what Slack sent. Messages from bots are ignored, Factorix's own included, so a workflow that posts to a channel
 * cannot start itself again. So are edits, deletions, and joins.
 */
export function parseSlackEvent(payload: unknown): SlackEvent {
  const raw = (payload ?? {}) as Record<string, unknown>
  if (raw.type === 'url_verification' && typeof raw.challenge === 'string') return { kind: 'challenge', challenge: raw.challenge }
  if (raw.type !== 'event_callback' || typeof raw.event_id !== 'string') return { kind: 'ignored' }
  const event = (raw.event ?? {}) as Record<string, unknown>
  const kind = event.type === 'app_mention' ? 'mention' : event.type === 'message' ? 'message' : null
  if (!kind || event.bot_id || typeof event.user !== 'string' || typeof event.channel !== 'string' || typeof event.ts !== 'string') {
    return { kind: 'ignored' }
  }
  if (kind === 'message' && event.subtype !== undefined && event.subtype !== 'thread_broadcast' && event.subtype !== 'file_share') {
    return { kind: 'ignored' }
  }
  let text = typeof event.text === 'string' ? event.text : ''
  const app = ((raw.authorizations ?? []) as { user_id?: unknown }[])[0]?.user_id
  if (kind === 'mention' && typeof app === 'string') text = text.replaceAll(`<@${app}>`, '').trim()
  const thread = typeof event.thread_ts === 'string' ? event.thread_ts : event.ts
  // A mention carries no channel type, and only a direct message has an id starting with D.
  const channelType = typeof event.channel_type === 'string' ? event.channel_type : event.channel.startsWith('D') ? 'im' : 'channel'
  return { kind, id: raw.event_id, channel: event.channel, channelType, user: event.user, text: text.slice(0, 4000), ts: event.ts, thread }
}
