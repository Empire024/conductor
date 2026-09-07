import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentEventData, TimelineItem } from '../../../shared/structured-agent'
import { StructuredUsageDetails } from './StructuredUsageDetails'

function render(events: AgentEventData[]): string {
  const items: TimelineItem[] = events.map((data, index) => ({ id: String(index), runtimeId: 'synthetic', sequence: index + 1, timestamp: '2026-09-07T00:00:00Z', data }))
  return renderToStaticMarkup(createElement(StructuredUsageDetails, { items }))
}
describe('opt-in usage details (synthetic, zero inference)', () => {
  it('starts collapsed and keeps missing telemetry unknown rather than zero', () => {
    const html = render([])
    expect(html).toContain('<details class="sa-usage-details"><summary>Usage &amp; limits</summary>')
    expect(html).not.toContain('<details open')
    expect(html).toContain('Token usage has not been reported.')
    expect(html).toContain('Account limits have not been reported.')
    expect(html).not.toContain('0% used')
    expect(html).not.toContain('$0')
    expect(html).not.toContain('<dd>0</dd>')
  })
  it('shows authoritative zero values when they actually are reported', () => {
    const html = render([{ type: 'usage', source: 'provider', inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, limits: { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } } }])
    expect(html.match(/<dd>0<\/dd>/g)).toHaveLength(4)
    expect(html).toContain('$0.0000')
    expect(html).toContain('0% used')
    expect(html).not.toContain('Token usage has not been reported.')
    expect(html).not.toContain('Account limits have not been reported.')
  })
  it('uses the latest token snapshot and does not add repeated cumulative snapshots', () => {
    const html = render([
      { type: 'usage', source: 'provider', inputTokens: 10, outputTokens: 4 },
      { type: 'text', role: 'assistant', mode: 'snapshot', text: 'Done.' },
      { type: 'usage', source: 'provider', inputTokens: 30, outputTokens: 12 }
    ])
    expect(html).toContain('<dd>30</dd>')
    expect(html).toContain('<dd>12</dd>')
    expect(html).not.toContain('<dd>40</dd>')
    expect(html).not.toContain('Done.')
  })
  it('preserves separately emitted estimated Claude cost without calling it a subscription charge', () => {
    const html = render([
      { type: 'usage', source: 'provider', inputTokens: 100, outputTokens: 25 },
      { type: 'usage', source: 'estimate', costUsd: 0.0123 }
    ])
    expect(html).toContain('<dd>100</dd>')
    expect(html).toContain('$0.0123')
    expect(html).toMatch(/[Ee]stimat/)
    expect(html).toContain('not a subscription charge')
    expect(html).toContain('Estimated cost (latest report)')
  })
  it('can show a cost-only report while token counts remain unknown', () => {
    const html = render([{ type: 'usage', source: 'estimate', costUsd: 0 }])
    expect(html).toContain('Token usage has not been reported.')
    expect(html).toContain('$0.0000')
    expect(html).toMatch(/[Ee]stimat/)
  })
  it('keeps account windows when a later token event contains only context-window metadata', () => {
    const html = render([
      { type: 'usage', source: 'provider', limits: { rateLimits: { primary: { usedPercent: 17, windowDurationMins: 300 }, secondary: { usedPercent: 9, windowDurationMins: 10080 } } } },
      { type: 'usage', source: 'provider', inputTokens: 512, outputTokens: 24, limits: { modelContextWindow: 200_000 } }
    ])
    expect(html).toContain('17% used')
    expect(html).toContain('9% used')
    expect(html).toContain('Weekly')
    expect(html).not.toContain('Account limits have not been reported.')
  })
  it('does not turn a model context window or null account data into subscription quota', () => {
    const html = render([{ type: 'usage', source: 'provider', limits: { modelContextWindow: 200_000, rateLimits: { primary: null, secondary: null } } }])
    expect(html).toContain('Account limits have not been reported.')
    expect(html).not.toContain('% used')
  })
  it('retains inspectable native limits while escaping untrusted strings', () => {
    const html = render([{ type: 'usage', source: 'provider', limits: { rateLimits: { custom: '<script>alert(1)</script>' } } }])
    expect(html).toContain('Limit details')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })
})
