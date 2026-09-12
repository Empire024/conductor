import { describe, expect, it } from 'vitest'
import type { AgentEventData, TimelineItem } from '../shared/structured-agent'
import { accountWindowMovement, describeUsageCap, evaluateUsageCap, normalizeUsageWindows, parseUsageCapSetting, shortWindow, summarizeUsageRun, usageWindowAppliesToModel, weeklyWindow } from '../shared/usage-accounting'
import { activeUsageCap, parseUsageLimitReset, resolveUsageCap } from './usage-limit'

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
    expect(parseUsageLimitReset('You have 2 usage limit resets available. Run /usage to use one.', from)).toBeNull()
    expect(parseUsageLimitReset('You have 2 usage limit resets available. Run /usage to use one. Next window resets at 2 AM.', from)).toBeNull()
  })
})

const item = (sequence: number, data: AgentEventData, extra: Partial<TimelineItem> = {}): TimelineItem =>
  ({ id: String(sequence), runtimeId: 'runtime', sequence, timestamp: '2026-09-07T00:00:00Z', data, ...extra })
const windows = (rateLimits: Record<string, unknown>): AgentEventData =>
  ({ type: 'usage', source: 'provider', limits: { rateLimits } as never })

describe('account allowance windows (provider-reported only)', () => {
  it('classifies reported windows by their reported duration and drops unreported ones', () => {
    const parsed = normalizeUsageWindows({
      rateLimits: {
        five_hour: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1789344000 },
        seven_day: { usedPercent: 61, windowDurationMins: 10080 },
        seven_day_overage_included: { usedPercent: 4, windowDurationMins: 10080 },
        unreported: { windowDurationMins: 300 },
        nulled: null
      }
    })
    expect(parsed.map(entry => [entry.key, entry.kind, entry.label])).toEqual([
      ['seven_day', 'weekly', 'Weekly'],
      ['seven_day_overage_included', 'weekly', 'Fable weekly'],
      ['five_hour', 'short', '5 hour']
    ])
    expect(parsed[0]!.usedPercent).toBe(61)
    expect(parsed[1]).toMatchObject({scope:'model',modelSelectors:['fable'],overage:false})
    expect(parsed[2]!.resetsAt).toBe(new Date(1789344000 * 1000).toISOString())
    // A model-scoped ceiling is not treated as universal when no model was supplied.
    expect(weeklyWindow(parsed)!.key).toBe('seven_day')
    expect(usageWindowAppliesToModel(parsed[1]!, 'claude-sonnet-4-5')).toBe(false)
    expect(weeklyWindow(parsed, 'claude-sonnet-4-5')!.key).toBe('seven_day')
    expect(usageWindowAppliesToModel(parsed[1]!, 'claude-fable-5-1')).toBe(true)
    const fableLimited = normalizeUsageWindows({ rateLimits: {
      seven_day: { usedPercent: 10, windowDurationMins: 10080 },
      seven_day_overage_included: { usedPercent: 99, windowDurationMins: 10080 }
    } })
    expect(weeklyWindow(fableLimited, 'claude-fable-5-1')!.key).toBe('seven_day_overage_included')
    expect(weeklyWindow(fableLimited, 'claude-sonnet-4-5')!.key).toBe('seven_day')
    expect(shortWindow(parsed)!.key).toBe('five_hour')
  })

  it('reports the movement between the first and latest reported level, not a guess', () => {
    const [weekly] = accountWindowMovement([
      item(1, windows({ seven_day: { usedPercent: 10, windowDurationMins: 10080 } })),
      item(2, { type: 'usage', source: 'provider', inputTokens: 40, outputTokens: 8 }),
      item(3, windows({ seven_day: { usedPercent: 70, windowDurationMins: 10080 } }))
    ])
    expect(weekly).toMatchObject({ startPercent: 10, usedPercent: 70, consumedPercent: 60, samples: 2, windowReset: false })
  })

  it('refuses to attribute a share once the window rolled over mid-conversation', () => {
    const [weekly] = accountWindowMovement([
      item(1, windows({ seven_day: { usedPercent: 88, windowDurationMins: 10080 } })),
      item(2, windows({ seven_day: { usedPercent: 3, windowDurationMins: 10080 } })),
      item(3, windows({ seven_day: { usedPercent: 9, windowDurationMins: 10080 } }))
    ])
    expect(weekly!.windowReset).toBe(true)
    expect(weekly!.consumedPercent).toBeUndefined()
    expect(weekly!.usedPercent).toBe(9)
  })

  it('separates what the provider reported from what Conductor computed', () => {
    const report = summarizeUsageRun([
      item(1, windows({ seven_day: { usedPercent: 10, windowDurationMins: 10080 } })),
      item(2, { type: 'usage', source: 'provider', scope: 'session', inputTokens: 900, outputTokens: 120 }, { turnId: 'one', timestamp: '2026-09-07T00:00:30Z' }),
      item(3, windows({ seven_day: { usedPercent: 34, windowDurationMins: 10080 } }), { timestamp: '2026-09-07T00:01:00Z' })
    ])
    expect(report.conversation.tokens).toMatchObject({ inputTokens: 900, outputTokens: 120, totalTokens: 1020 })
    expect(report.conversation.windows[0]!.consumedPercent).toBe(24)
    expect(report.conversation.turns).toBe(1)
    expect(report.conversation.wallMs).toBe(60_000)
    expect(report.measured.join(' ')).toContain('reported by the provider')
    expect(report.derived.join(' ')).toContain('upper bound')
  })
})

describe('usage caps', () => {
  const weekly = (usedPercent: number): AgentEventData => windows({ seven_day: { usedPercent, windowDurationMins: 10080 } })

  it('rejects settings it cannot honor rather than storing a weaker cap', () => {
    expect(parseUsageCapSetting('{"metric":"weekly-percent","limit":25,"basis":"account"}')).toEqual({ metric: 'weekly-percent', limit: 25, basis: 'account' })
    expect(parseUsageCapSetting({ metric: 'weekly-percent', limit: 140, basis: 'conversation' })).toBeNull()
    expect(parseUsageCapSetting({ metric: 'weekly-percent', limit: 0, basis: 'conversation' })).toBeNull()
    expect(parseUsageCapSetting({ metric: 'invented', limit: 5 })).toBeNull()
    expect(parseUsageCapSetting('')).toBeNull()
    expect(parseUsageCapSetting({ metric: 'none' })).toEqual({ metric: 'none' })
    // A token cap is only ever about this conversation; no provider reports an account token total.
    expect(parseUsageCapSetting({ metric: 'tokens', limit: 5000.7, basis: 'account' })).toEqual({ metric: 'tokens', limit: 5000, basis: 'conversation' })
  })

  it('prefers the narrowest configured scope and lets a tab opt out of a workspace cap', () => {
    const cap = JSON.stringify({ metric: 'weekly-percent', limit: 10, basis: 'conversation' })
    expect(resolveUsageCap({ workspace: cap })).toMatchObject({ scope: 'workspace' })
    expect(resolveUsageCap({ tab: cap, workspace: JSON.stringify({ metric: 'tokens', limit: 5 }) })).toMatchObject({ scope: 'tab' })
    expect(resolveUsageCap({ default: cap })).toMatchObject({ scope: 'default' })
    expect(resolveUsageCap({})).toBeNull()
    // An explicit "none" is a decision, so it wins over a broader cap instead of inheriting it.
    expect(resolveUsageCap({ tab: '{"metric":"none"}', workspace: cap })).toEqual({ setting: { metric: 'none' }, scope: 'tab' })
    expect(activeUsageCap({ tab: '{"metric":"none"}', workspace: cap })).toBeNull()
    expect(activeUsageCap({ workspace: cap })).toMatchObject({ scope: 'workspace' })
  })

  it('fires on consumed share, absolute account level and token totals separately', () => {
    const report = summarizeUsageRun([
      item(1, weekly(50)),
      item(2, { type: 'usage', source: 'provider', scope: 'session', inputTokens: 8_000, outputTokens: 2_000 }),
      item(3, weekly(62))
    ]).conversation
    expect(evaluateUsageCap({ metric: 'weekly-percent', limit: 10, basis: 'conversation' }, report)).toMatchObject({ value: 12, reached: true })
    expect(evaluateUsageCap({ metric: 'weekly-percent', limit: 20, basis: 'conversation' }, report)).toMatchObject({ value: 12, reached: false })
    // The same figures read as an absolute account level rather than a share.
    expect(evaluateUsageCap({ metric: 'weekly-percent', limit: 60, basis: 'account' }, report)).toMatchObject({ value: 62, reached: true })
    expect(evaluateUsageCap({ metric: 'tokens', limit: 10_000, basis: 'conversation' }, report)).toMatchObject({ value: 10_000, reached: true })
    expect(evaluateUsageCap({ metric: 'tokens', limit: 10_001, basis: 'conversation' }, report)).toMatchObject({ reached: false })
  })

  it('never fires on a figure the provider has not reported', () => {
    const noWindows = summarizeUsageRun([item(1, { type: 'usage', source: 'provider', inputTokens: 5, outputTokens: 1 })]).conversation
    const missing = evaluateUsageCap({ metric: 'weekly-percent', limit: 1, basis: 'account' }, noWindows)
    expect(missing.reached).toBe(false)
    expect(missing.value).toBeUndefined()
    expect(missing.detail).toContain('has not reported')

    const noTokens = summarizeUsageRun([item(1, weekly(99))]).conversation
    const noTokenFigure = evaluateUsageCap({ metric: 'tokens', limit: 1, basis: 'conversation' }, noTokens)
    expect(noTokenFigure.reached).toBe(false)
    expect(noTokenFigure.value).toBeUndefined()

    // A rolled-over window has no attributable share, so a conversation cap stays silent
    // even though the account itself is nearly exhausted.
    const rolled = summarizeUsageRun([item(1, weekly(95)), item(2, weekly(4))]).conversation
    expect(evaluateUsageCap({ metric: 'weekly-percent', limit: 1, basis: 'conversation' }, rolled)).toMatchObject({ reached: false })
    expect(evaluateUsageCap({ metric: 'weekly-percent', limit: 1, basis: 'account' }, rolled)).toMatchObject({ reached: true, value: 4 })
  })

  it('describes a cap in the words of the window the provider reported', () => {
    const reported = normalizeUsageWindows({ rateLimits: { five_hour: { usedPercent: 3, windowDurationMins: 300 } } })
    expect(describeUsageCap({ metric: 'none' })).toBe('No usage cap')
    expect(describeUsageCap({ metric: 'tokens', limit: 250_000, basis: 'conversation' })).toContain('250,000 tokens')
    expect(describeUsageCap({ metric: 'short-window-percent', limit: 15, basis: 'account' }, reported)).toContain('5 hour')
  })
})
