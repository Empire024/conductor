import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentEventData, TimelineItem } from '../../../shared/structured-agent'
import { StructuredUsageContent, StructuredUsageDetails } from './StructuredUsageDetails'

const items = (events: AgentEventData[]): TimelineItem[] => events.map((data, index) => ({ id: String(index), runtimeId: 'synthetic', sequence: index + 1, timestamp: '2026-09-07T00:00:00Z', data }))
function render(events: AgentEventData[]): string {
  return renderToStaticMarkup(createElement(StructuredUsageDetails, { items: items(events) }))
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
  it('shows a Fable-specific allowance row only when the visible composer selected Fable', () => {
    const events: AgentEventData[] = [{ type: 'usage', source: 'provider', limits: { rateLimits: {
      seven_day: { usedPercent: 95, windowDurationMins: 10080 },
      seven_day_overage_included: { usedPercent: 99, windowDurationMins: 10080, scope: 'model', modelSelectors: ['fable'], label: 'Fable weekly' }
    } } }]
    const fable = renderToStaticMarkup(createElement(StructuredUsageContent, { items: items(events), modelLabel: 'Claude Fable 5.1' }))
    const sonnet = renderToStaticMarkup(createElement(StructuredUsageContent, { items: items(events), modelLabel: 'Claude Sonnet 4.5' }))
    expect(fable).toContain('<span>Fable weekly</span><strong>99% used</strong>')
    expect(sonnet).not.toContain('<span>Fable weekly</span><strong>99% used</strong>')
    expect(sonnet).toContain('<span>Weekly</span><strong>95% used</strong>')
  })
})

describe('what a run actually cost (synthetic, zero inference)', () => {
  it('names the account movement two reports support and says it is an upper bound', () => {
    const html = render([
      { type: 'session', phase: 'running', capabilities: { provider: 'codex', runtimeVersion: 'x', adapterVersion: 1, authentication: 'cli', textStreaming: true, steering: true, toolInputStreaming: true, toolOutputStreaming: true, approvals: true, questions: true, resume: true, fork: true, plans: true, effort: [], models: [], limitations: [], effectiveSettings: { model: 'gpt-6-astra' } } },
      { type: 'usage', source: 'provider', limits: { rateLimits: { seven_day: { usedPercent: 10, windowDurationMins: 10080 } } } },
      { type: 'usage', source: 'provider', scope: 'session', inputTokens: 120000, outputTokens: 9000, totalTokens: 129000 },
      { type: 'usage', source: 'provider', limits: { rateLimits: { seven_day: { usedPercent: 70, windowDurationMins: 10080 } } } }
    ])
    expect(html).toContain('Codex')
    expect(html).toContain('gpt-6-astra')
    expect(html).toContain('60 points')
    expect(html).toContain('weekly allowance while this conversation was open')
    expect(html).toContain('10% ')
    expect(html).toContain('70%')
    expect(html).toContain('129,000')
    // The provenance split is explicit rather than implied by wording alone.
    expect(html).toContain('Where these numbers come from')
    expect(html).toContain('upper bound')
  })

  it('shows the current level but claims no share until a second report exists', () => {
    const html = render([
      { type: 'usage', source: 'provider', limits: { rateLimits: { seven_day: { usedPercent: 44, windowDurationMins: 10080 } } } }
    ])
    expect(html).toContain('44% used')
    expect(html).toContain('no movement can be attributed')
    expect(html).not.toContain('points of your')
    // A single level is a measurement, not a movement: no share is claimed anywhere.
    expect(html).not.toContain('Share consumed here')
    expect(html).not.toContain('upper bound')
  })

  it('refuses to attribute a share across a window rollover', () => {
    const html = render([
      { type: 'usage', source: 'provider', limits: { rateLimits: { seven_day: { usedPercent: 91, windowDurationMins: 10080 } } } },
      { type: 'usage', source: 'provider', limits: { rateLimits: { seven_day: { usedPercent: 5, windowDurationMins: 10080 } } } }
    ])
    expect(html).toContain('5% used')
    expect(html).toContain('cannot be attributed')
    expect(html).not.toContain('points of your')
  })
})
