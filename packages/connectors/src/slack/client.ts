import { type NotificationChannel, type NotificationConnector, type NotificationMessage, RetryLaterError } from '../notifier'
import { markdownToSlack } from './markup'

const API_URL = 'https://slack.com/api'
const SECTION_LIMIT = 2900
const MAX_SECTIONS = 20

const HELP: Record<string, string> = {
  invalid_auth: 'Slack rejected the token.',
  account_inactive: 'This Slack token belongs to a deactivated app or user.',
  token_revoked: 'This Slack token was revoked.',
  missing_scope: 'The Slack app is missing a scope. It needs chat:write, chat:write.public, channels:read, and groups:read.',
  not_in_channel: 'The Slack app is not in this channel. Invite it, or add the chat:write.public scope for public channels.',
  channel_not_found: 'Slack cannot find this channel. Private channels need the app invited first.',
  is_archived: 'This Slack channel is archived.',
}

interface SlackResponse {
  ok: boolean
  error?: string
  response_metadata?: { next_cursor?: string }
  [key: string]: unknown
}

export function slackSections(text: string): string[] {
  const sections: string[] = []
  let rest = text
  while (rest.length > 0 && sections.length < MAX_SECTIONS) {
    if (rest.length <= SECTION_LIMIT) {
      sections.push(rest)
      break
    }
    const breakAt = rest.lastIndexOf('\n', SECTION_LIMIT)
    const end = breakAt > SECTION_LIMIT / 2 ? breakAt : SECTION_LIMIT
    sections.push(rest.slice(0, end))
    rest = rest.slice(end).trimStart()
  }
  return sections
}

export class SlackConnector implements NotificationConnector {
  readonly kind = 'slack' as const
  private readonly token: string
  private readonly fetch: typeof fetch

  constructor(options: { token: string; fetch?: typeof fetch }) {
    this.token = options.token
    this.fetch = options.fetch ?? fetch
  }

  private async call(method: string, body: Record<string, unknown>): Promise<SlackResponse> {
    const response = await this.fetch(`${API_URL}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after') ?? 30)
      throw new RetryLaterError('Slack asked to slow down', (Number.isFinite(seconds) ? seconds : 30) * 1000)
    }
    if (!response.ok) throw new Error(`Slack returned ${response.status}`)
    const data = (await response.json()) as SlackResponse
    if (!data.ok) throw new Error(HELP[data.error ?? ''] ?? `Slack refused the request: ${data.error ?? 'unknown error'}`)
    return data
  }

  async viewer(): Promise<{ name: string }> {
    const data = await this.call('auth.test', {})
    return { name: `${String(data.user ?? 'app')} in ${String(data.team ?? 'Slack')}` }
  }

  async listChannels(): Promise<NotificationChannel[]> {
    const channels: NotificationChannel[] = []
    let cursor: string | undefined
    do {
      const data = await this.call('conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor })
      for (const channel of data.channels as { id: string; name: string; is_private?: boolean }[]) {
        channels.push({ id: channel.id, name: channel.name, private: Boolean(channel.is_private) })
      }
      cursor = data.response_metadata?.next_cursor || undefined
    } while (cursor && channels.length < 5000)
    return channels.sort((a, b) => a.name.localeCompare(b.name))
  }

  async send(message: NotificationMessage): Promise<{ id: string; url: string | null }> {
    const text = markdownToSlack(message.markdown)
    const data = await this.call('chat.postMessage', {
      channel: message.channelId,
      text: text.slice(0, SECTION_LIMIT),
      blocks: slackSections(text).map((section) => ({ type: 'section', text: { type: 'mrkdwn', text: section } })),
      unfurl_links: false,
      unfurl_media: false,
    })
    const id = String(data.ts)
    const permalink = await this.call('chat.getPermalink', { channel: data.channel ?? message.channelId, message_ts: id }).catch(() => null)
    return { id, url: permalink ? String(permalink.permalink) : null }
  }
}
