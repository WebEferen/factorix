export type Days = 'daily' | 'weekdays'

export interface ScheduleTime {
  days: Days
  /** 24-hour, as 17:00. */
  time: string
  /** An IANA zone, as Europe/Warsaw. */
  timezone: string
}

export const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const DAY_MS = 86_400_000

export function isTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone.length > 0 && zone.length <= 64
  } catch {
    return false
  }
}

function zoneOffsetMs(timezone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at)
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value)
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - Math.floor(at / 1000) * 1000
}

/**
 * The first time after `after` that the digest is written, or null when the schedule makes no sense. A time that a
 * clock change skips comes an hour later that day, and one that happens twice comes once.
 */
export function nextScheduleTime(schedule: ScheduleTime, after: Date): Date | null {
  const time = TIME.exec(schedule.time.trim())
  if (!time || !isTimezone(schedule.timezone) || (schedule.days !== 'daily' && schedule.days !== 'weekdays')) return null
  for (let ahead = -1; ahead <= 8; ahead++) {
    const probe = after.getTime() + ahead * DAY_MS
    const local = new Date(probe + zoneOffsetMs(schedule.timezone, probe))
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Number(time[1]), Number(time[2]))
    const weekday = new Date(wall).getUTCDay()
    if (schedule.days === 'weekdays' && (weekday === 0 || weekday === 6)) continue
    const guess = wall - zoneOffsetMs(schedule.timezone, wall)
    const at = wall - zoneOffsetMs(schedule.timezone, guess)
    if (at > after.getTime()) return new Date(at)
  }
  return null
}
