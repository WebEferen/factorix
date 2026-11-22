import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { PageContext } from './types.js'

export const SIGNATURE_HEADER = 'x-factorix-signature'
export const TIMESTAMP_HEADER = 'x-factorix-timestamp'
export const DELIVERY_HEADER = 'x-factorix-delivery'
const TOLERANCE_MS = 5 * 60_000

const digest = (value: string) => createHash('sha256').update(value).digest()
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b))

export function sign(secret: string, timestamp: string, body: string | Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')}`
}

/** The timestamp is signed with the body, so a captured request stops working after a few minutes. */
export function verify(
  secret: string,
  timestamp: string | null | undefined,
  signature: string | null | undefined,
  body: string | Uint8Array,
  now = Date.now(),
): boolean {
  if (!secret || !timestamp || !signature) return false
  const sent = Number(timestamp)
  if (!Number.isFinite(sent) || Math.abs(now - sent) > TOLERANCE_MS) return false
  return same(signature, sign(secret, timestamp, body))
}

/** Reads the `factorix` parameter of a page address. Returns nothing for a forged or expired one. */
export function readPageToken(secret: string, token: string | null | undefined, now = Date.now()): PageContext | null {
  const [payload, signature] = (token ?? '').split('.')
  if (!secret || !payload || !signature) return null
  if (!same(signature, createHmac('sha256', secret).update(payload).digest('hex'))) return null
  try {
    const context = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PageContext
    return typeof context.exp === 'number' && context.exp > now ? context : null
  } catch {
    return null
  }
}

export function signPageToken(secret: string, context: PageContext): string {
  const payload = Buffer.from(JSON.stringify(context)).toString('base64url')
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`
}
