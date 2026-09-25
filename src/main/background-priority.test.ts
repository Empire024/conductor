import { describe, expect, it } from 'vitest'
import { BACKGROUND_PRIORITY, applyParkedPriority, lowerToBackground, parkedPriorityWanted, startParkedPriority, type PriorityPorts } from './background-priority'

const fakePorts = (initial: Record<number, number>): PriorityPorts & { values: Record<number, number> } => {
  const values = { ...initial }
  return {
    values,
    get: pid => { if (!(pid in values)) throw new Error('ESRCH'); return values[pid] as number },
    set: (pid, priority) => { if (!(pid in values)) throw new Error('ESRCH'); values[pid] = priority }
  }
}

describe('parked instance priority (typing-lag-under-test-load)', () => {
  it('applies to a parked instance unless CONDUCTOR_BACKGROUND_PRIORITY=0', () => {
    expect(parkedPriorityWanted(true, {})).toBe(true)
    expect(parkedPriorityWanted(true, { CONDUCTOR_BACKGROUND_PRIORITY: '0' })).toBe(false)
    expect(parkedPriorityWanted(false, {})).toBe(false)
  })

  it('lowers normal processes, leaves idle ones and skips processes that are gone', () => {
    const ports = fakePorts({ 1: 0, 2: 19, 3: BACKGROUND_PRIORITY })
    expect(lowerToBackground([1, 2, 3, 4], ports)).toEqual([1])
    expect(ports.values).toEqual({ 1: BACKGROUND_PRIORITY, 2: 19, 3: BACKGROUND_PRIORITY })
  })

  it('lowers main at once and every child whenever one starts', () => {
    const ports = fakePorts({ [process.pid]: 0, 11: 0 })
    let sweep: (() => void) | undefined
    const applied = applyParkedPriority({ parked: true, env: {}, processIds: () => Object.keys(ports.values).map(Number), onChildStarted: callback => { sweep = callback }, ports })
    expect(applied).toBe(true)
    expect(ports.values[process.pid]).toBe(BACKGROUND_PRIORITY)
    expect(ports.values[11]).toBe(0)
    ports.values[12] = 0
    sweep?.()
    expect(ports.values).toMatchObject({ 11: BACKGROUND_PRIORITY, 12: BACKGROUND_PRIORITY })
  })

  it('does nothing for the owner app or an opted-out stand-in', () => {
    const ports = fakePorts({ [process.pid]: 0 })
    let subscribed = false
    for (const [parked, env] of [[false, {}], [true, { CONDUCTOR_BACKGROUND_PRIORITY: '0' }]] as const) {
      expect(applyParkedPriority({ parked, env, processIds: () => [process.pid], onChildStarted: () => { subscribed = true }, ports })).toBe(false)
    }
    expect(subscribed).toBe(false)
    expect(ports.values[process.pid]).toBe(0)
  })

  it('never wires Electron for the owner app or an opted-out stand-in', () => {
    const listeners: Array<(event: unknown, contents: { on: (event: 'dom-ready', listener: () => void) => unknown }) => void> = []
    const fakeApp = { getAppMetrics: () => [], whenReady: () => Promise.resolve(), on: (_event: 'web-contents-created', listener: (typeof listeners)[number]) => { listeners.push(listener) } }
    expect(startParkedPriority(fakeApp, false, {})).toBe(false)
    expect(listeners).toHaveLength(0)
    // A parked launch with the opt-out: the owner stand-in of a measurement.
    expect(startParkedPriority(fakeApp, true, { CONDUCTOR_BACKGROUND_PRIORITY: '0' })).toBe(false)
    expect(listeners).toHaveLength(0)
  })
})
