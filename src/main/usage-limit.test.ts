import { describe, expect, it } from 'vitest'
import { parseUsageLimitReset } from './usage-limit'

describe('parseUsageLimitReset', () => {
  const from = new Date(2026, 8, 6, 14, 15, 0, 0)

  it('adds compound durations to the supplied reference time', () => {
    expect(parseUsageLimitReset('Usage limit reached. Try again in 2 hours 30 minutes.', from))
      .toEqual(new Date(2026, 8, 6, 16, 45, 0, 0))
    expect(parseUsageLimitReset('Rate-limit exceeded; retry after 1 day and 15 seconds.', from))
      .toEqual(new Date(from.getTime() + 86_415_000))
  })

  it('parses provider clock messages and rolls elapsed clocks to tomorrow', () => {
    expect(parseUsageLimitReset("You've hit your limit; resets at 5:30 PM.", from))
      .toEqual(new Date(2026, 8, 6, 17, 30, 0, 0))
    expect(parseUsageLimitReset('Quota reached; available 2am.', from))
      .toEqual(new Date(2026, 8, 7, 2, 0, 0, 0))
    expect(parseUsageLimitReset("You've hit your weekly limit · resets 11am (Europe/Budapest)", from))
      .toEqual(new Date(2026, 8, 7, 11, 0, 0, 0))
    expect(parseUsageLimitReset('Usage limit; resets at 25:00.', from)).toBeNull()
  })

  it('preserves explicit ISO instants', () => {
    expect(parseUsageLimitReset('Usage limit reached; continue at 2026-09-07T08:45:00+02:00.', from)?.toISOString())
      .toBe('2026-09-07T06:45:00.000Z')
  })

  it('ignores unrelated or incomplete text', () => {
    expect(parseUsageLimitReset('The layout resize limit was changed.', from)).toBeNull()
    expect(parseUsageLimitReset('Usage limit reached.', from)).toBeNull()
    expect(parseUsageLimitReset('Try again in 30 minutes.', from)).toBeNull()
  })
})
