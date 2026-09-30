import { describe, expect, it } from 'vitest'
import { allowanceLevel, gaugeTitle, sparklinePath, sparklineX } from './ProviderAllowance'

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
})
