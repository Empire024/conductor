import { describe, expect, it } from 'vitest'
import { headlineWindow, nextAllowanceReset, recordAllowanceHistory, summarizeProviderAllowance, windowShortLabel, type AllowanceHistory } from './provider-allowance'
import type { AccountLimitsReport, AccountLimitWindow } from './usage-accounting'

const NOW = Date.parse('2026-09-30T12:00:00Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const window = (over: Partial<AccountLimitWindow>): AccountLimitWindow => ({
  bucket: 'b', key: 'k', label: 'Weekly', kind: 'weekly', scope: 'provider', usedPercent: 40, windowMinutes: 10080,
  resetsAt: iso(NOW + 3 * 86_400_000), state: 'current', observedAt: iso(NOW - 60_000), ageSeconds: 60,
  source: { agentSessionId: 'a', projectId: 'p' }, ...over
})
const report = (provider: AccountLimitsReport['provider'], windows: AccountLimitWindow[], planType?: string): AccountLimitsReport =>
  ({ provider, status: windows.length ? 'reported' : 'unknown', windows, unknown: [], ...(planType ? { credits: [{ bucket: 'codex', planType, observedAt: iso(NOW) }] } : {}) })

describe('provider allowance strip', () => {
  it('picks the provider-wide window of each kind, never a model-scoped bucket', () => {
    const windows = [window({ key: 'fable', scope: 'model', usedPercent: 99, models: ['fable'] }), window({ key: 'seven_day', usedPercent: 40 }), window({ key: 'five_hour', kind: 'short', windowMinutes: 300, usedPercent: 12 })]
    expect(headlineWindow(windows, 'weekly')?.key).toBe('seven_day')
    expect(headlineWindow(windows, 'short')?.key).toBe('five_hour')
  })

  it('records a bounded history: unchanged readings write nothing, rises within 15 minutes move the newest point, drops add one', () => {
    let history: AllowanceHistory = {}
    const at = (minutes: number, percent: number) => report('claude', [window({ usedPercent: percent, observedAt: iso(NOW + minutes * 60_000) })])
    history = recordAllowanceHistory(history, at(0, 10), NOW + 1e9)!
    expect(recordAllowanceHistory(history, at(1, 10), NOW + 1e9)).toBeNull()
    history = recordAllowanceHistory(history, at(2, 11), NOW + 1e9)!
    history = recordAllowanceHistory(history, at(5, 12), NOW + 1e9)!
    history = recordAllowanceHistory(history, at(30, 13), NOW + 1e9)!
    history = recordAllowanceHistory(history, at(31, 0), NOW + 1e9)!
    expect(history.claude?.weekly?.map(([, percent]) => percent)).toEqual([10, 12, 13, 0])
    // A window that has reset since it was observed is not a reading.
    expect(recordAllowanceHistory(history, report('claude', [window({ usedPercent: 50, state: 'reset', observedAt: iso(NOW + 40 * 60_000) })]), NOW + 1e9)).toBeNull()
  })

  it('keeps at most a week and 96 points per series', () => {
    let history: AllowanceHistory = {}
    for (let index = 0; index < 400; index++) history = recordAllowanceHistory(history, report('codex', [window({ usedPercent: index % 2 ? 5 : 6, observedAt: iso(NOW + index * 3_600_000) })]), NOW + 1e10) ?? history
    const series = history.codex!.weekly!
    expect(series.length).toBeLessThanOrEqual(96)
    expect(series.at(-1)![0] - series[0]![0]).toBeLessThanOrEqual(7 * 86_400_000)
  })

  it('summarizes recently used providers in a fixed order with the current window of the line, and hides stale or unreported ones', () => {
    const since = NOW + 3 * 86_400_000 - 7 * 86_400_000
    const history: AllowanceHistory = { codex: { weekly: [[since - 3_600_000, 90], [since + 3_600_000, 20], [NOW - 60_000, 40]] } }
    const rows = summarizeProviderAllowance([
      report('grok', []),
      report('codex', [window({}), window({ key: 'codex:primary', kind: 'short', windowMinutes: 300, usedPercent: 7, resetsAt: iso(NOW - 1000), state: 'reset' })], 'pro'),
      report('claude', [window({ observedAt: iso(NOW - 8 * 86_400_000) })])
    ], history, NOW)
    expect(rows.map(row => row.provider)).toEqual(['codex'])
    const codex = rows[0]!
    expect(codex).toMatchObject({ name: 'GPT', planType: 'pro' })
    // The previous week's 90% is left out; the line ends at the current reading.
    expect(codex.weekly!.points.map(([, percent]) => percent)).toEqual([20, 40])
    expect(codex.weekly!.elapsed).toBeCloseTo(4 / 7, 5)
    expect(codex.short).toMatchObject({ usedPercent: null, windowMinutes: 300 })
    expect(nextAllowanceReset(rows, NOW)).toBe(NOW + 3 * 86_400_000)
  })

  it('labels windows by length', () => {
    expect([windowShortLabel(10080, 'wk'), windowShortLabel(300, 's'), windowShortLabel(90, 's'), windowShortLabel(null, 'wk')]).toEqual(['7d', '5h', '90m', 'wk'])
  })
})
