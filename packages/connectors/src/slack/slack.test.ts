import { describe, expect, it, vi } from 'vitest'
import { RetryLaterError } from '../notifier'
import { SlackConnector, slackSections } from './client'
import { markdownToSlack } from './markup'

function reply(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, ...init })
}

function connector(handler: (method: string, body: Record<string, unknown>) => Response) {
  const calls: { method: string; body: Record<string, unknown>; auth: string | null }[] = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop() as string
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ method, body, auth: new Headers(init?.headers).get('authorization') })
    return handler(method, body)
  })
  return { slack: new SlackConnector({ token: 'xoxb-1', fetch: fetchMock as typeof fetch }), calls }
}

describe('markdownToSlack', () => {
  it.each([
    ['**bold**', '*bold*'],
    ['some *italic* text', 'some _italic_ text'],
    ['~~gone~~', '~gone~'],
    ['[Open](https://x.test/a)', '<https://x.test/a|Open>'],
    ['# Title', '*Title*'],
    ['- one', '• one'],
    ['`**code**`', '`**code**`'],
  ])('%s becomes %s', (markdown, slack) => {
    expect(markdownToSlack(markdown)).toBe(slack)
  })

  it('leaves fenced code alone', () => {
    expect(markdownToSlack('```\n**a**\n```')).toBe('```\n**a**\n```')
  })

  it('cannot be made to mention a channel or a person', () => {
    expect(markdownToSlack('<!channel> <@U123> <https://evil.test|Login>')).toBe('&lt;!channel&gt; &lt;@U123&gt; &lt;https://evil.test|Login&gt;')
  })

  it('shows escaped ticket text literally, with no link', () => {
    expect(markdownToSlack('\\[click\\]\\(http://evil\\) \\<\\!channel\\> a\\_b')).toBe('[click](http://evil) &lt;!channel&gt; a_b')
  })

  it('cannot forge a held character to smuggle a mention through', () => {
    expect(markdownToSlack('\uE00160\uE001!channel\uE00162\uE001')).toBe('60!channel62')
  })

  it('does not link anything but http', () => {
    expect(markdownToSlack('[x](javascript:alert)')).toBe('[x](javascript:alert)')
  })
})

describe('slackSections', () => {
  it('splits long text on line breaks and caps how much it sends', () => {
    const line = `${'x'.repeat(1000)}\n`
    const sections = slackSections(line.repeat(5))
    expect(sections.every((section) => section.length <= 2900)).toBe(true)
    expect(sections.join('\n').replace(/\n+/g, '\n').trim()).toBe(line.repeat(5).trim())
    expect(slackSections('y'.repeat(200_000))).toHaveLength(20)
  })
})

describe('SlackConnector', () => {
  it('sends the token only in the header and posts Slack markup', async () => {
    const { slack, calls } = connector((method) =>
      method === 'chat.postMessage' ? reply({ ok: true, ts: '1.2', channel: 'C1' }) : reply({ ok: true, permalink: 'https://slack.test/p/1' }),
    )
    expect(await slack.send({ channelId: 'C1', markdown: '**Hi** <!here>' })).toEqual({ id: '1.2', url: 'https://slack.test/p/1' })
    expect(calls[0]?.auth).toBe('Bearer xoxb-1')
    expect(JSON.stringify(calls[0]?.body)).not.toContain('xoxb-1')
    expect(calls[0]?.body).toMatchObject({ channel: 'C1', text: '*Hi* &lt;!here&gt;', unfurl_links: false })
  })

  it('still reports a message as sent when the permalink lookup fails', async () => {
    const { slack } = connector((method) => (method === 'chat.postMessage' ? reply({ ok: true, ts: '1.2' }) : reply({ ok: false, error: 'nope' })))
    expect(await slack.send({ channelId: 'C1', markdown: 'x' })).toEqual({ id: '1.2', url: null })
  })

  it('reads every page of channels, sorted', async () => {
    const { slack, calls } = connector((_, body) =>
      body.cursor
        ? reply({ ok: true, channels: [{ id: 'C2', name: 'alerts', is_private: true }] })
        : reply({ ok: true, channels: [{ id: 'C1', name: 'general' }], response_metadata: { next_cursor: 'next' } }),
    )
    expect(await slack.listChannels()).toEqual([
      { id: 'C2', name: 'alerts', private: true },
      { id: 'C1', name: 'general', private: false },
    ])
    expect(calls).toHaveLength(2)
  })

  it('turns a rate limit into a retry with the delay Slack asked for', async () => {
    const { slack } = connector(() => new Response('', { status: 429, headers: { 'retry-after': '7' } }))
    const error = await slack.send({ channelId: 'C1', markdown: 'x' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RetryLaterError)
    expect((error as RetryLaterError).retryAfterMs).toBe(7000)
  })

  it('explains the errors people can act on', async () => {
    const { slack } = connector(() => reply({ ok: false, error: 'not_in_channel' }))
    await expect(slack.send({ channelId: 'C1', markdown: 'x' })).rejects.toThrow(/Invite it/)
  })
})
