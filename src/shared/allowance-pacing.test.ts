import { describe, expect, it } from 'vitest'
import { allowancePacing, formatTimeLeft, pacingHint } from './allowance-pacing'

const now = Date.parse('2026-10-17T12:00:00Z')
const HOUR = 3_600_000, DAY = 24 * HOUR
const week = (usedPercent: number | null, leftMs: number | null, windowMinutes: number | null = 10080) => ({
  usedPercent, windowMinutes, resetsAt: leftMs === null ? null : new Date(now + leftMs).toISOString()
})

describe('allowancePacing', () => {
  it('is unknown without a reset time, without a current reading, or once the window has reset', () => {
    expect(allowancePacing(week(10, null), now).state).toBe('unknown')
    expect(allowancePacing(week(null, DAY), now)).toMatchObject({ state: 'unknown', unusedPercent: null, leftMs: DAY })
    expect(allowancePacing(week(10, 0), now)).toMatchObject({ state: 'unknown', leftMs: null })
    expect(allowancePacing(week(10, -HOUR), now).state).toBe('unknown')
    expect(allowancePacing({ usedPercent: 10, windowMinutes: 10080, resetsAt: 'not a date' }, now).state).toBe('unknown')
  })

  it('turns red when a large share would be lost within a day or two', () => {
    expect(allowancePacing(week(60, DAY), now).state).toBe('waste-high') // 40% unused, exactly 1 day: boundary is red
    expect(allowancePacing(week(61, DAY), now).state).toBe('waste-warn') // 39% unused: orange (<2 days, >=25%)
    expect(allowancePacing(week(60, DAY + 1), now).state).toBe('waste-warn')
    expect(allowancePacing(week(40, 2 * DAY), now).state).toBe('waste-high') // 60% unused, 2 days
    expect(allowancePacing(week(10, 2 * HOUR), now)).toMatchObject({ state: 'waste-high', unusedPercent: 90 })
  })

  it('turns orange for a quarter unused under two days, or half unused under three', () => {
    expect(allowancePacing(week(75, 1.5 * DAY), now).state).toBe('waste-warn') // 79% of the week gone
    expect(allowancePacing(week(70, 2 * DAY), now).state).toBe('waste-warn')
    expect(allowancePacing(week(75, 2 * DAY), now).state).toBe('ok') // 71% gone: ahead of pace, no colour
    expect(allowancePacing(week(76, 2 * DAY), now).state).toBe('ok') // 24% unused: under the orange share
    expect(allowancePacing(week(50, 3 * DAY), now).state).toBe('waste-warn')
    expect(allowancePacing(week(45, 3 * DAY + 1), now).state).toBe('behind') // over 3 days left: behind pace, no colour
    expect(allowancePacing(week(51, 3 * DAY), now).state).toBe('ok') // 49% unused, 57% gone: within the margin
  })

  it('stays normal on or above pace however near the reset, and leaves near-limit use alone', () => {
    expect(allowancePacing(week(95, HOUR), now).state).toBe('ok')
    expect(allowancePacing(week(100, DAY), now)).toMatchObject({ state: 'ok', unusedPercent: 0 })
    expect(allowancePacing(week(5, 6.5 * DAY), now).state).toBe('ok') // early in the week
    expect(allowancePacing(week(20, 4 * DAY), now).state).toBe('behind') // 43% gone, far from the reset: no colour
  })

  it('assumes a 7-day window when the length is not reported and respects another length', () => {
    expect(allowancePacing(week(50, 3 * DAY, null), now).state).toBe('waste-warn')
    // A 30-day window with 3 days left and half unused is far behind pace too.
    expect(allowancePacing(week(50, 3 * DAY, 30 * 1440), now).state).toBe('waste-warn')
    // A 30-day window 10 days in, 3 days of it left... expected pace decides "ok".
    expect(allowancePacing(week(95, 3 * DAY, 30 * 1440), now).state).toBe('ok')
  })
})

describe('formatTimeLeft and pacingHint', () => {
  it('formats days, hours and minutes compactly', () => {
    expect(formatTimeLeft(2.36 * DAY)).toBe('2.3d')
    expect(formatTimeLeft(DAY)).toBe('1.0d')
    expect(formatTimeLeft(DAY - 1)).toBe('23h')
    expect(formatTimeLeft(HOUR)).toBe('1h')
    expect(formatTimeLeft(40 * 60_000)).toBe('40m')
    expect(formatTimeLeft(10_000)).toBe('1m')
    expect(formatTimeLeft(12 * DAY)).toBe('12d')
  })

  it('explains the colour', () => {
    expect(pacingHint(allowancePacing(week(38, 1.45 * DAY), now))).toBe('62% unused, resets in 1.4 days — use it')
    expect(pacingHint(allowancePacing(week(10, 5 * HOUR), now))).toBe('90% unused, resets in 5 h — use it')
    expect(pacingHint(allowancePacing(week(20, 4 * DAY), now))).toMatch(/^80% unused, resets in 4\.0 days — behind pace \(43% of the week gone\)$/)
    expect(pacingHint(allowancePacing(week(90, 4 * DAY), now))).toBe('10% unused, resets in 4.0 days')
    expect(pacingHint(allowancePacing(week(10, null), now))).toBeNull()
  })
})
