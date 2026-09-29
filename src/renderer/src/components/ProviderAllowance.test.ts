import { describe, expect, it } from 'vitest'
import { allowanceLevel, gaugeTitle, sparklinePath } from './ProviderAllowance'

describe('ProviderAllowance', () => {
  it('draws a step line over the elapsed part of the window', () => {
    expect(sparklinePath({ points: [], elapsed: 0.5, usedPercent: null })).toBe('')
    expect(sparklinePath({ points: [[0, 0], [0.5, 50]], elapsed: 0.75, usedPercent: 50 })).toBe('M0 10.5 H17 V5.5 H25.5')
  })

  it('colours by level and names the reset in the hover', () => {
    expect([allowanceLevel(null), allowanceLevel(20), allowanceLevel(75), allowanceLevel(95)]).toEqual(['unknown', 'ok', 'warn', 'high'])
    const now = Date.parse('2026-09-30T12:00:00Z')
    const title = gaugeTitle('Claude', { label: 'Weekly', usedPercent: 42.4, resetsAt: '2026-10-02T12:00:00Z', windowMinutes: 10080, observedAt: '2026-09-30T11:55:00Z', points: [], elapsed: 0.7 }, now)
    expect(title).toMatch(/^Claude weekly: 42% used · resets .+ \(in 2 d 0 h\) · reported 5 min ago$/)
    expect(gaugeTitle('GPT', { label: '5 hour', usedPercent: null, resetsAt: null, windowMinutes: 300, observedAt: '2026-09-30T11:00:00Z', points: [], elapsed: 1 }, now)).toMatch(/current use unknown.*reset time not reported/)
  })
})
