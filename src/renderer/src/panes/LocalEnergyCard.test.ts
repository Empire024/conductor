import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LocalEnergyCard, LocalEnergyTotalsView } from './LocalEnergyCard'
import { DEFAULT_ENERGY_PRICE, formatWh, localEnergyNotice, type LocalEnergyReading } from '../../../shared/local-energy'
import { isConversationActivity } from '../../../shared/conversation-activity'
import type { TimelineItem } from '../../../shared/structured-agent'

const measured: LocalEnergyReading = { measured: true, source: 'nvidia-smi', durationMs: 36_000, gpuWh: 2, systemWh: 0.4, totalWh: 2.4, averageGpuWatts: 200, peakGpuWatts: 231, systemWatts: 40, samples: 72, shared: false }

describe('LocalEnergyCard', () => {
  it('shows Wh and money for a turn, marking what is measured and what is estimated', () => {
    const html = renderToStaticMarkup(createElement(LocalEnergyCard, { reading: measured, price: DEFAULT_ENERGY_PRICE }))
    expect(html).toContain('≈ 2.40 Wh')
    // 2.4 Wh at $0.20/kWh = $0.00048
    expect(html).toContain('≈ $0.00048 this turn')
    expect(html).toContain('GPU 200 W avg over 36.0 s (measured)')
    expect(html).toContain('~40 W rest of system (estimate)')
    expect(html).toContain('default price')
    const priced = renderToStaticMarkup(createElement(LocalEnergyCard, { reading: { ...measured, totalWh: 1000 }, price: { perKwh: 0.3, currency: '€' } }))
    expect(priced).toContain('≈ €0.300 this turn')
    expect(priced).not.toContain('default price')
  })

  it('is conversation activity, not a hidden diagnostic, in both forms', () => {
    const item = (reading: LocalEnergyReading) => ({ id: 'e', data: localEnergyNotice(reading) }) as unknown as TimelineItem
    expect(isConversationActivity(item(measured))).toBe(true)
    expect(isConversationActivity(item({ measured: false, durationMs: 1, reason: 'no nvidia-smi' }))).toBe(true)
  })

  it('says not measured, with no number, when nvidia-smi is missing', () => {
    const html = renderToStaticMarkup(createElement(LocalEnergyCard, { reading: { measured: false, durationMs: 5000, reason: 'nvidia-smi is not available on this machine' }, price: DEFAULT_ENERGY_PRICE }))
    expect(html).toContain('Energy not measured: nvidia-smi is not available on this machine.')
    expect(html).not.toMatch(/Wh|\$/)
  })

  it('totals a conversation and offers the price setting with its default stated', () => {
    const html = renderToStaticMarkup(createElement(LocalEnergyTotalsView, { totals: { turns: 3, measuredTurns: 2, unmeasuredTurns: 1, gpuWh: 4, systemWh: 0.8, totalWh: 4.8, durationMs: 80_000, lastReason: 'the turn ended before nvidia-smi reported a power reading' }, price: DEFAULT_ENERGY_PRICE, onPrice: () => {} }))
    expect(html).toContain(`≈ ${formatWh(4.8)}`)
    expect(html).toContain('over 2 measured turns')
    expect(html).toContain('Rest of system (estimate)')
    expect(html).toContain('Default ($0.2/kWh)')
    expect(html).toContain('1 turn: the turn ended before')
  })
})
