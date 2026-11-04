export interface NotificationChannel {
  id: string
  name: string
  private: boolean
}

export interface NotificationMessage {
  channelId: string
  /** Portable Markdown, as the tracker dialects convert to. Each connector writes its own dialect from it. */
  markdown: string
}

/** Outbound only, so a new channel is this interface plus an entry in `NOTIFICATION_SOURCES`. */
export interface NotificationConnector {
  readonly kind: NotificationKind
  viewer(): Promise<{ name: string }>
  listChannels(): Promise<NotificationChannel[]>
  send(message: NotificationMessage): Promise<{ id: string; url: string | null }>
}

export type NotificationKind = 'slack'

/** The channel asked to come back later, so sending again cannot deliver twice. */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message)
  }
}
