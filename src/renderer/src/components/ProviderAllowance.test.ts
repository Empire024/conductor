import { describe, expect, it } from 'vitest'
import { allowanceButtonLabel, allowanceLevel, formatDuration, gaugeTitle, sparklinePath, sparklineX, windowProgress } from './ProviderAllowance'

describe('ProviderAllowance', () => {
  it('rescales a share of the whole window to the elapsed-so-far part, so an early reading fills the slot', () => {
    // A 7-day window read 10% of the way in: a point halfway through what's elapsed so far
    // lands at mid-slot, not squeezed into the first tenth of the pixels.
    expect(sparklineX(0.05, 0.1)).toBe(17)
    expect(sparklineX(0, 0.1)).toBe(0)
    expect(sparklineX(0.1, 0.1)).toBe(34)
    // A share can't exceed elapsed in practice, but clamp defensively against rounding.
    expect(sparklineX(0.11, 0.1)).toBe(34)
    // Nothing elapsed yet (window just opened): no meaningful position, park at the start.
    expect(sparklineX(0, 0)).toBe(0)
  })

  it('draws a step line rescaled to the elapsed part of the window', () => {
    expect(sparklinePath({ points: [], elapsed: 0.5, usedPercent: null })).toBe('')
    expect(sparklinePath({ points: [[0, 0], [0.5, 50]], elapsed: 0.75, usedPercent: 50 })).toBe('M0 10.5 H22.67 V5.5 H34')
    // A single sample still reaches the right edge instead of stopping partway.
    expect(sparklinePath({ points: [[0, 40]], elapsed: 0.1, usedPercent: 40 })).toBe('M0 6.5 H34')
    // A flat series (no change reported) is a level line, not collapsed to a point.
    expect(sparklinePath({ points: [[0, 20], [0.05, 20]], elapsed: 0.1, usedPercent: 20 })).toBe('M0 8.5 H17 V8.5 H34')
  })

  it('colours by level and names the reset in the hover', () => {
    expect([allowanceLevel(null), allowanceLevel(20), allowanceLevel(75), allowanceLevel(95)]).toEqual(['unknown', 'ok', 'warn', 'high'])
    const now = Date.parse('2026-09-30T12:00:00Z')
    const title = gaugeTitle('Claude', { label: 'Weekly', usedPercent: 42.4, resetsAt: '2026-10-02T12:00:00Z', windowMinutes: 10080, observedAt: '2026-09-30T11:55:00Z', points: [], elapsed: 0.7 }, now)
    expect(title).toMatch(/^Claude weekly: 42% used · resets .+ \(in 2 d 0 h\) · reported 5 min ago$/)
    expect(gaugeTitle('GPT', { label: '5 hour', usedPercent: null, resetsAt: null, windowMinutes: 300, observedAt: '2026-09-30T11:00:00Z', points: [], elapsed: 1 }, now)).toMatch(/current use unknown.*reset time not reported/)
  })

  it('counts down to the end of the five-hour window from the reported reset, to the minute', () => {
    expect(formatDuration(102 * 60_000 + 59_000)).toBe('1h 42m')
    expect(formatDuration(42 * 60_000)).toBe('42m')
    expect(formatDuration(5 * 60 * 60_000)).toBe('5h 0m')
    expect(formatDuration(20_000)).toBe('<1m')
    expect(formatDuration((3 * 24 + 4) * 3_600_000)).toBe('3d 4h')
    const now = Date.parse('2026-10-18T12:00:00Z')
    const short = { usedPercent: 18, resetsAt: '2026-10-18T13:42:00Z', windowMinutes: 300 }
    const progress = windowProgress(short, now)!
    expect(progress.leftMs).toBe(102 * 60_000)
    expect(progress.spanMs).toBe(300 * 60_000)
    expect(progress.elapsedShare).toBeCloseTo(0.66, 5)
    // A minute later the countdown and the elapsed share both move.
    const later = windowProgress(short, now + 60_000)!
    expect(formatDuration(later.leftMs)).toBe('1h 41m')
    expect(later.elapsedShare).toBeGreaterThan(progress.elapsedShare)
    // Nothing to count down: no reset, no length, already reset, or use unknown since the rollover.
    expect(windowProgress({ ...short, resetsAt: null }, now)).toBeNull()
    expect(windowProgress({ ...short, windowMinutes: null }, now)).toBeNull()
    expect(windowProgress(short, Date.parse('2026-10-18T13:42:00Z'))).toBeNull()
    expect(windowProgress({ ...short, usedPercent: null }, now)).toBeNull()
    // A reset reported further out than one window length never shows a negative elapsed share.
    expect(windowProgress({ ...short, resetsAt: '2026-10-18T20:00:00Z' }, now)!.elapsedShare).toBe(0)
  })

  it('names the strip button with its figures and the five-hour countdown', () => {
    const now = Date.parse('2026-10-18T12:00:00Z')
    const gauge = { points: [], elapsed: 0.5, observedAt: '2026-10-18T11:58:00Z' }
    const label = allowanceButtonLabel([
      { provider: 'claude', name: 'Claude', observedAt: gauge.observedAt, weekly: { ...gauge, label: 'Weekly', usedPercent: 41.2, resetsAt: '2026-10-21T12:00:00Z', windowMinutes: 10080 }, short: { ...gauge, label: '5 hour', usedPercent: 18, resetsAt: '2026-10-18T13:42:00Z', windowMinutes: 300 } },
      { provider: 'codex', name: 'GPT', observedAt: gauge.observedAt, short: { ...gauge, label: '5 hour', usedPercent: null, resetsAt: '2026-10-18T11:00:00Z', windowMinutes: 300 } }
    ], now)
    expect(label).toBe('Usage: Claude weekly 41%, 5h 18%, resets in 1h 42m; GPT 5h unknown. Open the full usage view')
  })
})
