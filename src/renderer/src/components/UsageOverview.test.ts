import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { UsageAllowanceDetails, windowChartPath } from './UsageOverview'
import type { ProviderAllowanceRow } from '../../../shared/provider-allowance'

const now = Date.parse('2026-10-18T12:00:00Z')
const rows: ProviderAllowanceRow[] = [{
  provider: 'claude', name: 'Claude', observedAt: '2026-10-18T11:55:00Z', planType: 'max',
  weekly: { label: 'Weekly', usedPercent: 41, resetsAt: '2026-10-21T12:00:00Z', windowMinutes: 10080, observedAt: '2026-10-18T11:55:00Z', points: [[0.1, 10], [0.5, 41]], elapsed: 0.57 },
  short: { label: '5 hour', usedPercent: 18, resetsAt: '2026-10-18T13:42:00Z', windowMinutes: 300, observedAt: '2026-10-18T11:55:00Z', points: [[0.2, 5], [0.6, 18]], elapsed: 0.65 }
}, {
  provider: 'codex', name: 'GPT', observedAt: '2026-10-18T10:00:00Z',
  short: { label: '5 hour', usedPercent: null, resetsAt: '2026-10-18T11:00:00Z', windowMinutes: 300, observedAt: '2026-10-18T10:00:00Z', points: [], elapsed: 1 }
}]

describe('usage overview', () => {
  it('plots a window over its whole length, ending at now', () => {
    expect(windowChartPath([], 0.5)).toBe('')
    // x is the share of the whole window (300 px), not rescaled to the elapsed part.
    expect(windowChartPath([[0, 0], [0.5, 50]], 0.75)).toBe('M0 55 H150 V28 H225')
    expect(windowChartPath([[0.2, 100]], 0.2)).toBe('M60 1 H60')
  })

  it('shows every provider window with its reset countdown, elapsed bar and history line', () => {
    const html = renderToStaticMarkup(createElement(UsageAllowanceDetails, { rows, now }))
    expect(html.match(/class="usage-provider"/g)).toHaveLength(2)
    expect(html).toContain('max plan')
    // Claude 5h: resets 13:42, 1h 42m from now; 3h 18m of the 5h window gone (66%).
    expect(html).toContain('Resets in <b>1h 42m</b>')
    expect(html).toContain('3h 18m of 5h elapsed')
    expect(html).toMatch(/role="progressbar" aria-label="Claude 5 hour window elapsed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="66" aria-valuetext="3h 18m of 5h elapsed, resets in 1h 42m"/)
    expect(html).toContain('style="width:66.0%"')
    // Weekly: three days left, with the pacing hint the sidebar shows on hover.
    expect(html).toContain('Resets in <b>3d 0h</b>')
    expect(html).toMatch(/59% unused, resets in 3\.0 days/)
    expect(html.match(/class="line"/g)).toHaveLength(2)
    expect(html).toContain('Reported 5 min ago')
    // A window that already rolled over says its use is unknown and has no countdown.
    const gpt = html.slice(html.indexOf('data-provider="codex"'))
    expect(gpt).toContain('current use unknown until the next turn reports it')
    expect(gpt).not.toContain('progressbar')
  })

  it('says when no provider has reported yet', () => {
    expect(renderToStaticMarkup(createElement(UsageAllowanceDetails, { rows: [], now }))).toContain('No provider has reported an allowance yet')
  })
})
