import { describe, expect, it } from 'vitest'
import { type Days, isTimezone, nextScheduleTime } from './schedule'

const next = (days: string, time: string, timezone: string, after: string) =>
  nextScheduleTime({ days: days as Days, time, timezone }, new Date(after))?.toISOString() ?? null

describe('nextScheduleTime', () => {
  it('finds the next time of day in the schedule’s time zone', () => {
    expect(next('daily', '02:00', 'UTC', '2026-11-16T01:00:00Z')).toBe('2026-11-16T02:00:00.000Z')
    expect(next('daily', '02:00', 'UTC', '2026-11-16T02:00:00Z')).toBe('2026-11-17T02:00:00.000Z')
    expect(next('daily', '17:00', 'Europe/Warsaw', '2026-11-16T12:00:00Z')).toBe('2026-11-16T16:00:00.000Z')
    expect(next('daily', '09:00', 'Pacific/Auckland', '2026-11-16T12:00:00Z')).toBe('2026-11-16T20:00:00.000Z')
  })

  it('skips the weekend for weekdays, counted where the team lives', () => {
    // 2026-11-13 is a Friday.
    expect(next('weekdays', '18:00', 'UTC', '2026-11-13T19:00:00Z')).toBe('2026-11-16T18:00:00.000Z')
    expect(next('daily', '18:00', 'UTC', '2026-11-13T19:00:00Z')).toBe('2026-11-14T18:00:00.000Z')
    expect(next('weekdays', '08:00', 'Asia/Tokyo', '2026-11-13T19:00:00Z')).toBe('2026-11-15T23:00:00.000Z')
  })

  it('follows the clock through a change of time', () => {
    expect(next('daily', '08:00', 'Europe/Warsaw', '2026-03-28T12:00:00Z')).toBe('2026-03-29T06:00:00.000Z')
    expect(next('daily', '08:00', 'Europe/Warsaw', '2026-10-24T12:00:00Z')).toBe('2026-10-25T07:00:00.000Z')
    expect(next('daily', '02:30', 'Europe/Warsaw', '2026-03-28T12:00:00Z')).toBe('2026-03-29T01:30:00.000Z')
  })

  it('refuses a schedule that names no time', () => {
    expect(next('daily', '25:00', 'UTC', '2026-11-16T01:00:00Z')).toBeNull()
    expect(next('daily', '5pm', 'UTC', '2026-11-16T01:00:00Z')).toBeNull()
    expect(next('daily', '02:00', 'Mars/Olympus', '2026-11-16T01:00:00Z')).toBeNull()
    expect(next('sometimes', '02:00', 'UTC', '2026-11-16T01:00:00Z')).toBeNull()
    expect(isTimezone('Europe/Warsaw')).toBe(true)
    expect(isTimezone('')).toBe(false)
  })
})
