import { describe, expect, it } from 'vitest'
import { GpuEnergySampler } from './local-energy'
import { localEnergyNotice, localEnergyOf, summarizeLocalEnergy } from '../shared/local-energy'
import type { TimelineItem } from '../shared/structured-agent'

function rig() {
  let clock = 1_000_000
  let starts = 0, stops = 0
  let emit: ((line: string) => void) | null = null
  let end: ((reason: string) => void) | null = null
  const sampler = new GpuEnergySampler({
    now: () => clock,
    systemWatts: 40,
    start: (onLine, onEnd) => { starts++; emit = onLine; end = onEnd; return { stop: () => { stops++; emit = null } } }
  })
  return {
    sampler,
    advance: (ms: number) => { clock += ms },
    line: (text: string) => emit?.(text),
    end: (reason: string) => end?.(reason),
    get starts() { return starts },
    get stops() { return stops },
    get streaming() { return emit !== null }
  }
}

describe('GpuEnergySampler', () => {
  it('integrates GPU power over a turn and adds the stated system estimate', () => {
    const r = rig()
    const meter = r.sampler.begin()
    expect(r.starts).toBe(1)
    r.advance(500); r.line('0, 200.00')
    for (let i = 0; i < 20; i++) { r.advance(500); r.line('0, 200.00') }
    r.advance(500)
    const reading = meter.stop()
    expect(reading.measured).toBe(true)
    if (!reading.measured) return
    // 11.0 s at 200 W (the 0.5 s before the first sample is charged at the sampled average).
    expect(reading.durationMs).toBe(11_000)
    expect(reading.gpuWh).toBeCloseTo(200 * 11 / 3600, 6)
    expect(reading.systemWh).toBeCloseTo(40 * 11 / 3600, 6)
    expect(reading.totalWh).toBeCloseTo(240 * 11 / 3600, 6)
    expect(reading.averageGpuWatts).toBeCloseTo(200, 6)
    expect(reading.peakGpuWatts).toBe(200)
    expect(reading.samples).toBe(21)
    expect(reading.shared).toBe(false)
    // The stream only runs while a turn does.
    expect(r.stops).toBe(1)
    expect(r.streaming).toBe(false)
    expect(meter.stop()).toBe(reading)
  })

  it('sums several GPUs and splits the draw between turns that overlap', () => {
    const r = rig()
    const a = r.sampler.begin()
    r.line('0, 100'); r.line('1, 50')
    r.advance(1000); r.line('0, 100'); r.line('1, 50')
    const b = r.sampler.begin()
    expect(r.starts).toBe(1)
    r.advance(1000); r.line('0, 100'); r.line('1, 50')
    const first = a.stop()
    r.advance(1000); r.line('0, 100')
    const second = b.stop()
    if (!first.measured || !second.measured) throw new Error('expected measured readings')
    // a: 1 s alone at 150 W, then 1 s shared → 150 + 75 J.
    expect(first.gpuWh * 3600).toBeCloseTo(225, 6)
    expect(first.shared).toBe(true)
    // b: 1 s shared (75 J), then 1 s alone (150 J).
    expect(second.gpuWh * 3600).toBeCloseTo(225, 6)
    expect(second.shared).toBe(true)
    expect(r.stops).toBe(1)
  })

  it('says "not measured" without nvidia-smi, and does not try again for the next turn', () => {
    const r = rig()
    const meter = r.sampler.begin()
    r.end('nvidia-smi is not available on this machine (no NVIDIA GPU tools), so GPU power cannot be read')
    r.advance(3000)
    const reading = meter.stop()
    expect(reading).toEqual({ measured: false, durationMs: 3000, reason: expect.stringMatching(/nvidia-smi is not available/) })
    expect(JSON.stringify(reading)).not.toMatch(/Wh/)
    const next = r.sampler.begin()
    expect(r.starts).toBe(1)
    expect(next.stop().measured).toBe(false)
  })

  it('treats a driver that reports [N/A] as not measured', () => {
    const r = rig()
    const meter = r.sampler.begin()
    r.line('0, [N/A]')
    r.advance(1000)
    const reading = meter.stop()
    expect(reading.measured).toBe(false)
    if (!reading.measured) expect(reading.reason).toMatch(/does not report power draw/)
  })

  it('reports no number when the turn ends before the first reading', () => {
    const r = rig()
    const meter = r.sampler.begin()
    r.advance(100)
    const reading = meter.stop()
    expect(reading).toEqual({ measured: false, durationMs: 100, reason: expect.stringMatching(/before nvidia-smi reported/) })
  })
})

describe('local energy notices', () => {
  it('round-trip through a notice and total a conversation', () => {
    const measured = { measured: true as const, source: 'nvidia-smi' as const, durationMs: 10_000, gpuWh: 0.5, systemWh: 0.1111, totalWh: 0.6111, averageGpuWatts: 180, peakGpuWatts: 220, systemWatts: 40, samples: 20, shared: false }
    const items = [
      { id: 'a', data: localEnergyNotice(measured) },
      { id: 'b', data: localEnergyNotice({ measured: false, durationMs: 2000, reason: 'nvidia-smi is not available' }) },
      { id: 'c', data: localEnergyNotice(measured) },
      { id: 'd', data: { type: 'notice', message: 'other' } }
    ] as unknown as TimelineItem[]
    expect(localEnergyOf(items[0]!.data)).toEqual(measured)
    expect(localEnergyOf(items[3]!.data)).toBeUndefined()
    expect(summarizeLocalEnergy(items)).toMatchObject({ turns: 3, measuredTurns: 2, unmeasuredTurns: 1, gpuWh: 1, totalWh: 1.2222, durationMs: 22_000 })
    expect(summarizeLocalEnergy([])).toBeNull()
  })
})
