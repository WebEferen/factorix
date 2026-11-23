import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseSlackEvent, verifySlackRequest } from './events'

const NOW = 1_795_000_000_000
const sign = (body: string, secret = 'shh', at = NOW / 1000) => ({
  'x-slack-request-timestamp': String(at),
  'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${at}:${body}`).digest('hex')}`,
})

describe('a Slack request', () => {
  it('is accepted only signed with the secret, and recently', () => {
    const body = '{"type":"event_callback"}'
    expect(verifySlackRequest(Buffer.from(body), sign(body), 'shh', NOW)).toBe(true)
    expect(verifySlackRequest(Buffer.from(body), sign(body, 'other'), 'shh', NOW)).toBe(false)
    expect(verifySlackRequest(Buffer.from(`${body} `), sign(body), 'shh', NOW)).toBe(false)
    expect(verifySlackRequest(Buffer.from(body), sign(body, 'shh', NOW / 1000 - 600), 'shh', NOW)).toBe(false)
    expect(verifySlackRequest(Buffer.from(body), sign(body), '', NOW)).toBe(false)
  })
})

describe('a Slack event', () => {
  const callback = (event: Record<string, unknown>) => ({
    type: 'event_callback',
    event_id: 'Ev1',
    authorizations: [{ user_id: 'UAPP' }],
    event: { channel: 'C1', user: 'U1', ts: '1.1', ...event },
  })

  it('answers the URL check, and reads a message and a mention', () => {
    expect(parseSlackEvent({ type: 'url_verification', challenge: 'abc' })).toEqual({ kind: 'challenge', challenge: 'abc' })
    expect(parseSlackEvent(callback({ type: 'message', text: 'Deploy', thread_ts: '0.9' }))).toEqual({
      kind: 'message',
      id: 'Ev1',
      channel: 'C1',
      channelType: 'channel',
      user: 'U1',
      text: 'Deploy',
      ts: '1.1',
      thread: '0.9',
    })
    expect(parseSlackEvent(callback({ type: 'app_mention', text: '<@UAPP> what broke?' }))).toMatchObject({
      kind: 'mention',
      text: 'what broke?',
      thread: '1.1',
    })
  })

  it('tells a direct message to the app from a channel', () => {
    expect(parseSlackEvent(callback({ type: 'message', channel: 'D9', channel_type: 'im', text: 'hi' }))).toMatchObject({ channelType: 'im' })
    expect(parseSlackEvent(callback({ type: 'message', channel: 'G2', channel_type: 'group', text: 'hi' }))).toMatchObject({ channelType: 'group' })
    expect(parseSlackEvent(callback({ type: 'app_mention', channel: 'D9', text: 'hi' }))).toMatchObject({ channelType: 'im' })
  })

  it('ignores bots, edits, and anything else', () => {
    expect(parseSlackEvent(callback({ type: 'message', text: 'x', bot_id: 'B1' }))).toEqual({ kind: 'ignored' })
    expect(parseSlackEvent(callback({ type: 'message', subtype: 'message_changed' }))).toEqual({ kind: 'ignored' })
    expect(parseSlackEvent(callback({ type: 'reaction_added' }))).toEqual({ kind: 'ignored' })
    expect(parseSlackEvent({ type: 'app_rate_limited' })).toEqual({ kind: 'ignored' })
  })
})
