import { describe, expect, it } from 'vitest'
import type { UsageScopeReport } from './usage-accounting'
import { DEFAULT_COST_WARNING_USD, evaluateUsageWarning, USAGE_WARNING_FRACTIONS } from './usage-warning'

const report = (overrides: Partial<UsageScopeReport> = {}): UsageScopeReport => ({
  scope: 'conversation',
  windows: [],
  tokensScope: 'session',
  tokensEstimated: false,
  costEstimated: false,
  turns: 0,
  usageReports: 0,
  ...overrides
})

describe('evaluateUsageWarning', () => {
  it('stays silent below the approaching fraction of an active cap', () => {
    const cap = { metric: 'tokens', limit: 1000, basis: 'conversation' } as const
    expect(evaluateUsageWarning(report({ tokens: { totalTokens: 500 } }), cap)).toBeNull()
  })

  it('flags approaching once the cap-relative fraction crosses 70%, and high past 90%', () => {
    const cap = { metric: 'tokens', limit: 1000, basis: 'conversation' } as const
    const approaching = evaluateUsageWarning(report({ tokens: { totalTokens: 750 } }), cap)
    expect(approaching).toMatchObject({ level: 'approaching', fraction: 0.75 })
    expect(approaching!.detail).toContain('usage cap')
    const high = evaluateUsageWarning(report({ tokens: { totalTokens: 950 } }), cap)
    expect(high).toMatchObject({ level: 'high', fraction: 0.95 })
  })

  it('reads a weekly-percent cap the same way evaluateUsageCap itself would', () => {
    const cap = { metric: 'weekly-percent', limit: 20, basis: 'account' } as const
    const windows = [{ key: 'seven_day', kind: 'weekly' as const, label: 'Weekly', usedPercent: 10, overage: false, startPercent: 0, windowReset: false, samples: 1 }]
    expect(evaluateUsageWarning(report({ windows }), cap)).toBeNull()
    expect(evaluateUsageWarning(report({ windows: [{ ...windows[0]!, usedPercent: 19 }] }), cap)).toMatchObject({ level: 'high' })
  })

  it('never fires on a figure the provider has not reported, even with a cap configured', () => {
    const cap = { metric: 'tokens', limit: 1000, basis: 'conversation' } as const
    expect(evaluateUsageWarning(report(), cap)).toBeNull()
    const percentCap = { metric: 'weekly-percent', limit: 20, basis: 'conversation' } as const
    expect(evaluateUsageWarning(report({ tokens: { totalTokens: 999_999 } }), percentCap)).toBeNull()
  })

  it('falls back to a flat cost figure when no cap is configured anywhere', () => {
    expect(evaluateUsageWarning(report({ costUsd: 1 }), null)).toBeNull()
    expect(evaluateUsageWarning(report({ costUsd: 1 }), { metric: 'none' })).toBeNull()
    expect(evaluateUsageWarning(report({ costUsd: DEFAULT_COST_WARNING_USD.approaching }), undefined)).toMatchObject({ level: 'approaching' })
    const high = evaluateUsageWarning(report({ costUsd: DEFAULT_COST_WARNING_USD.high, costEstimated: true }), undefined)
    expect(high).toMatchObject({ level: 'high', fraction: 1 })
    expect(high!.detail).toContain('estimated')
  })

  it('never fires on cost alone once a cap is configured, even a distant one', () => {
    // A configured cap is the owner's own stop rule; an uncapped dollar guess must not
    // second-guess it once one is set, even if this conversation happens to be expensive.
    const cap = { metric: 'weekly-percent', limit: 90, basis: 'account' } as const
    const windows = [{ key: 'seven_day', kind: 'weekly' as const, label: 'Weekly', usedPercent: 5, overage: false, startPercent: 0, windowReset: false, samples: 1 }]
    expect(evaluateUsageWarning(report({ windows, costUsd: 500 }), cap)).toBeNull()
  })

  it('caps the reported fraction at 1 even when the figure runs past the limit', () => {
    const cap = { metric: 'tokens', limit: 1000, basis: 'conversation' } as const
    expect(evaluateUsageWarning(report({ tokens: { totalTokens: 5000 } }), cap)).toMatchObject({ level: 'high', fraction: 1 })
  })

  it('matches the documented threshold fractions', () => {
    expect(USAGE_WARNING_FRACTIONS).toEqual({ approaching: 0.7, high: 0.9 })
  })
})
