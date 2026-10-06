import { describe, expect, it } from 'vitest'
import { allowanceReadings, projectWindow, splitWindows, summarizeAllowanceWeeks, weekVerdict, type AllowanceReading } from './usage-weeks'
import { describeAccountLimits, recordAccountLimits, type AccountLimitRecord } from './usage-accounting'

const H = 3_600_000, D = 24 * H
const WEEK = 7 * D
const T0 = Date.parse('2026-09-07T09:00:00.000Z')
const reading = (at: number, usedPercent: number, resetsAt: number | null = T0 + WEEK, extra: Partial<AllowanceReading> = {}): AllowanceReading =>
  ({ provider: 'claude', bucket: 'seven_day', label: 'Weekly', scope: 'provider', at, usedPercent, resetsAt, windowMinutes: 10_080, ...extra })

describe('weekly allowance windows', () => {
  it('splits at the provider reset, not at calendar weeks, and keeps the last reading as the final figure', () => {
    const readings = [reading(T0 + D, 10), reading(T0 + 5 * D, 40), reading(T0 + WEEK - 2 * H, 62),
      reading(T0 + WEEK + H, 3, T0 + 2 * WEEK), reading(T0 + WEEK + 3 * D, 30, T0 + 2 * WEEK)]
    const weeks = summarizeAllowanceWeeks(readings, T0 + WEEK + 4 * D)
    expect(weeks.map(week => week.status)).toEqual(['current', 'closed'])
    const [current, closed] = weeks
    expect(closed).toMatchObject({ startsAt: new Date(T0).toISOString(), endsAt: new Date(T0 + WEEK).toISOString(), peakPercent: 62, finalPercent: 62, unusedPercent: 38, usedUp: false, coverage: 'complete', readings: 3 })
    expect(weekVerdict(closed!)).toBe('38% left unused')
    expect(current).toMatchObject({ startsAt: new Date(T0 + WEEK).toISOString(), finalPercent: 30, unusedPercent: null })
    // 30% after 3 days of a 7-day window: 70% at reset at the same pace.
    expect(current!.projection).toMatchObject({ percentAtReset: 70, usedUpAt: null })
  })

  it('says when a week was used up and that nothing was left', () => {
    const weeks = summarizeAllowanceWeeks([reading(T0 + D, 50), reading(T0 + 4 * D, 100), reading(T0 + 6 * D, 100)], T0 + WEEK + H)
    expect(weeks).toHaveLength(1)
    expect(weeks[0]).toMatchObject({ status: 'closed', usedUp: true, usedUpAt: new Date(T0 + 4 * D).toISOString(), unusedPercent: 0, peakPercent: 100, coverage: 'complete' })
    // Once used up nothing can rise further: a quiet last day before the reset is not partial data.
    expect(weekVerdict(weeks[0]!)).toMatch(/^Used up on /)
  })

  it('marks a week whose last reading is long before the reset as partial instead of guessing', () => {
    const [open, week] = summarizeAllowanceWeeks([reading(T0 + D, 20), reading(T0 + 3 * D, 45)], T0 + WEEK + D)
    // A day past the reset with no reading since: the new window is said to be unknown.
    expect(open).toMatchObject({ status: 'no-data', coverage: 'none' })
    expect(week).toMatchObject({ status: 'closed', coverage: 'partial', finalPercent: 45, unusedPercent: 55 })
    expect(week!.notes.join(' ')).toMatch(/Last reading 4 d 0 h before the reset/)
    expect(weekVerdict(week!)).toBe('55% left unused (at last reading)')
  })

  it('names stretches with no readings, inside a window and between windows, without interpolating', () => {
    const readings = [reading(T0 + 3 * H, 5), reading(T0 + 4 * D, 30), reading(T0 + WEEK - H, 31),
      // The next reading arrives two windows later: the window in between has no readings at all.
      reading(T0 + 2 * WEEK + 2 * H, 4, T0 + 3 * WEEK), reading(T0 + 3 * WEEK - H, 20, T0 + 3 * WEEK)]
    const weeks = summarizeAllowanceWeeks(readings, T0 + 3 * WEEK + 2 * D)
    expect(weeks.map(week => week.status)).toEqual(['no-data', 'closed', 'no-data', 'closed'])
    expect(weeks[0]).toMatchObject({ coverage: 'none', startsAt: new Date(T0 + 3 * WEEK).toISOString(), endsAt: null, peakPercent: null, unusedPercent: null })
    expect(weeks[2]).toMatchObject({ coverage: 'none', startsAt: new Date(T0 + WEEK).toISOString(), endsAt: new Date(T0 + 2 * WEEK).toISOString() })
    expect(weekVerdict(weeks[2]!)).toBe('No readings')
    expect(weeks[3]!.notes.join(' ')).toMatch(/No readings from .* to /)
  })

  it('treats a reset time that moves while use keeps climbing as the same window with a moved end', () => {
    const moved = T0 + WEEK + 6 * H
    const groups = splitWindows([reading(T0 + D, 10), reading(T0 + 3 * D, 20, moved), reading(T0 + 5 * D, 35, moved)])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ end: moved, resetMoved: true })
    const [week] = summarizeAllowanceWeeks([reading(T0 + D, 10), reading(T0 + 3 * D, 20, moved), reading(T0 + 5 * D, 35, moved), reading(moved - H, 40, moved)], moved + H)
    expect(week).toMatchObject({ endsAt: new Date(moved).toISOString(), finalPercent: 40 })
    expect(week!.notes.join(' ')).toMatch(/moved this window/)
  })

  it('starts a new window on an early reset (use falls with a new reset time) but not on an out-of-step dip', () => {
    const early = splitWindows([reading(T0 + D, 40), reading(T0 + 2 * D, 2, T0 + 2 * D + WEEK)])
    expect(early).toHaveLength(2)
    expect(early[0]!.earlyReset).toBe(true)
    const [closed] = summarizeAllowanceWeeks([reading(T0 + D, 40), reading(T0 + 2 * D, 2, T0 + 2 * D + WEEK)], T0 + 3 * D).filter(week => week.status === 'closed')
    // It ends where the provider says the next window began, not at the reset it had announced.
    expect(closed).toMatchObject({ unusedPercent: 60, startsAt: new Date(T0).toISOString(), endsAt: new Date(T0 + 2 * D).toISOString() })
    expect(closed!.notes.join(' ')).toMatch(/reset this window early/)
    // Two tabs reporting 58 then 57 under the same reset time are one window.
    expect(splitWindows([reading(T0 + D, 58), reading(T0 + D + 60_000, 57), reading(T0 + D + 120_000, 58)])).toHaveLength(1)
  })

  it('keeps buckets apart and bounds the result to the requested number of windows', () => {
    const fable = (at: number, percent: number): AllowanceReading => reading(at, percent, T0 + WEEK, { bucket: 'seven_day_overage_included', label: 'Fable weekly', scope: 'model', models: ['fable'] })
    const codex = (at: number, percent: number, reset: number): AllowanceReading => ({ ...reading(at, percent, reset), provider: 'codex', bucket: 'codex:primary' })
    const readings = [reading(T0 + D, 10), fable(T0 + D, 3), codex(T0 + 2 * D, 50, T0 + 2 * D + WEEK),
      ...Array.from({ length: 5 }, (_, index) => reading(T0 + (index + 1) * WEEK + H, 10 + index, T0 + (index + 2) * WEEK))]
    const weeks = summarizeAllowanceWeeks(readings, T0 + 6 * WEEK - H, 2)
    expect(weeks.filter(week => week.bucket === 'seven_day').map(week => week.status)).toEqual(['current', 'closed'])
    expect(weeks.find(week => week.bucket === 'seven_day_overage_included')).toMatchObject({ scope: 'model', models: ['fable'], label: 'Fable weekly' })
    expect(weeks[0]!.provider).toBe('claude')
    expect(weeks.at(-1)!.provider).toBe('codex')
  })

  it('does not project before six hours of a window have passed, and projects a run-out time when on pace to', () => {
    expect(projectWindow(T0, T0 + WEEK, { at: T0 + 2 * H, usedPercent: 10 })).toBeNull()
    const projection = projectWindow(T0, T0 + WEEK, { at: T0 + 2 * D, usedPercent: 50 })
    expect(projection).toMatchObject({ percentAtReset: 175, usedUpAt: new Date(T0 + 4 * D).toISOString() })
  })

  it('reads weekly windows, provider-wide and model-scoped, out of a described report', () => {
    let record: AccountLimitRecord = {}
    record = recordAccountLimits(record, 'claude', { rateLimits: {
      five_hour: { usedPercent: 6, windowDurationMins: 300, resetsAt: (T0 + 5 * H) / 1000 },
      seven_day: { usedPercent: 55, windowDurationMins: 10_080, resetsAt: (T0 + WEEK) / 1000 },
      seven_day_overage_included: { usedPercent: 9, windowDurationMins: 10_080, resetsAt: (T0 + WEEK) / 1000, scope: 'model', modelSelectors: ['fable'], label: 'Fable weekly' }
    } }, { observedAt: new Date(T0 + H).toISOString(), agentSessionId: 'a', projectId: 'p' })!
    const readings = allowanceReadings(describeAccountLimits(record, 'claude', T0 + 2 * H))
    expect(readings.map(entry => [entry.bucket, entry.usedPercent, entry.scope])).toEqual([['seven_day', 55, 'provider'], ['seven_day_overage_included', 9, 'model']])
    expect(readings[0]).toMatchObject({ at: T0 + H, resetsAt: T0 + WEEK, windowMinutes: 10_080 })
    // A window whose reset passed is not current, so it yields no reading.
    expect(allowanceReadings(describeAccountLimits(record, 'claude', T0 + WEEK + H))).toEqual([])
  })
})
