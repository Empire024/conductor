import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { WeeklyAllowanceList, bucketLabel, groupWeeks, weekDates } from './WeeklyAllowance'
import type { AllowanceWeek, AllowanceWeekReport } from '../../../shared/usage-weeks'

const base: AllowanceWeek = {
  provider: 'claude', bucket: 'seven_day', label: 'Weekly', scope: 'provider', status: 'closed', windowMinutes: 10_080,
  startsAt: '2026-09-21T09:00:00.000Z', endsAt: '2026-09-28T09:00:00.000Z', readings: 12,
  firstReadingAt: '2026-09-21T10:00:00.000Z', lastReadingAt: '2026-09-28T08:00:00.000Z',
  peakPercent: 69, finalPercent: 69, usedUp: false, usedUpAt: null, unusedPercent: 31, coverage: 'complete', notes: []
}
const now = Date.parse('2026-10-01T12:00:00.000Z')
const report: AllowanceWeekReport = {
  generatedAt: new Date(now).toISOString(), recordedSince: '2026-09-07T20:07:16.884Z', unknown: ['Grok does not report an account allowance through its runtime.'],
  weeks: [
    { ...base, status: 'current', startsAt: '2026-09-28T09:00:00.000Z', endsAt: '2026-10-05T09:00:00.000Z', finalPercent: 42, peakPercent: 42, unusedPercent: null,
      projection: { percentAtReset: 85, usedUpAt: null, basis: '' }, tokens: { models: [{ model: 'opus', processedTokens: 3_200_000, conversations: 4, estimated: true, costUsd: 41.2 }], processedTokens: 3_200_000, totalTokens: 9_000_000, costUsd: 41.2, costEstimated: true, complete: true, notes: [] } },
    { ...base, tokens: { models: [], processedTokens: 1_500_000, totalTokens: 2_000_000, costUsd: null, costEstimated: false, complete: true, notes: [] } },
    { ...base, startsAt: '2026-09-14T09:00:00.000Z', endsAt: '2026-09-21T09:00:00.000Z', usedUp: true, usedUpAt: '2026-09-19T15:00:00.000Z', peakPercent: 100, finalPercent: 100, unusedPercent: 0 },
    { ...base, status: 'no-data', startsAt: '2026-09-07T09:00:00.000Z', endsAt: '2026-09-14T09:00:00.000Z', readings: 0, peakPercent: null, finalPercent: null, unusedPercent: null, coverage: 'none', notes: ['No readings from A to B; use in this stretch is unknown.'] },
    { ...base, provider: 'codex', bucket: 'codex:primary', coverage: 'partial', unusedPercent: 12, finalPercent: 88, peakPercent: 88, notes: ['Last reading 2 d 0 h before the reset; use after it is not known.'] }
  ]
}

describe('weekly allowance view', () => {
  it('draws one group per provider bucket and one row per week with its verdict, bar and spend', () => {
    const html = renderToStaticMarkup(createElement(WeeklyAllowanceList, { report, now }))
    expect(html.match(/role="rowgroup"/g)).toHaveLength(2)
    expect(html).toContain('Claude · Weekly')
    expect(html).toContain('Codex · Weekly')
    expect(html).toContain('This week')
    expect(html).toContain('42% so far · on pace for 85% at reset')
    expect(html).toContain('31% left unused')
    expect(html).toMatch(/Used up on /)
    expect(html).toContain('No readings')
    expect(html).toContain('12% left unused (at last reading)')
    expect(html).toContain('Partial data')
    expect(html).toContain('3.2M tok · ≈ $41')
    expect(html).toContain('1.5M tok')
    expect(html).toContain('aria-label="Peak 100% used"')
    expect(html).toContain('Grok does not report')
    expect(html).toContain('not a charge')
  })

  it('labels dates from the provider window and an open stretch without readings', () => {
    expect(weekDates(base)).toMatch(/Sep 21 – Sep 28/)
    expect(weekDates({ ...base, status: 'no-data', endsAt: null })).toMatch(/^Since Sep 21/)
    expect(groupWeeks(report.weeks).map(group => [group.key, group.weeks.length])).toEqual([['claude:seven_day', 4], ['codex:codex:primary', 1]])
    // A model bucket names its model, unless its label already does.
    expect(bucketLabel({ label: 'Weekly', scope: 'model', models: ['codex_bengalfox', 'GPT-5.3-Codex-Spark'] })).toBe('GPT-5.3-Codex-Spark weekly')
    expect(bucketLabel({ label: 'Fable weekly', scope: 'model', models: ['fable'] })).toBe('Fable weekly')
  })

  it('says plainly when nothing has been recorded yet', () => {
    const html = renderToStaticMarkup(createElement(WeeklyAllowanceList, { report: { ...report, weeks: [], recordedSince: null }, now }))
    expect(html).toContain('No weekly allowance readings yet')
  })
})
