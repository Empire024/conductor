import { describe, expect, it } from 'vitest'
import { SPIN_DURATION_MS, spinPhaseDelayMs, spinPhaseStyle } from './spin-sync'

describe('spin phase sync', () => {
  it('has no delay exactly on an epoch boundary', () => {
    expect(spinPhaseDelayMs(0, 900)).toBe(0)
    expect(spinPhaseDelayMs(1800, 900)).toBe(0)
  })

  it('rewinds by however far the clock sits into the current cycle', () => {
    expect(spinPhaseDelayMs(450, 900)).toBe(-450)
    expect(spinPhaseDelayMs(899, 900)).toBe(-899)
  })

  it('produces the same phase for two clock readings a whole cycle apart', () => {
    expect(spinPhaseDelayMs(450, 900)).toBe(spinPhaseDelayMs(450 + 900, 900))
    expect(spinPhaseDelayMs(450, 900)).toBe(spinPhaseDelayMs(450 + 900 * 7, 900))
  })

  it('keeps two independently-mounted spinners in phase without any shared state', () => {
    // Two elements reading the clock at different real moments, as long as both use the
    // same duration, must still land on the same point in the cycle.
    const mountedEarly = spinPhaseDelayMs(12_345, SPIN_DURATION_MS)
    const mountedLate = spinPhaseDelayMs(12_345 + SPIN_DURATION_MS * 3, SPIN_DURATION_MS)
    expect(mountedEarly).toBe(mountedLate)
  })

  it('handles a negative clock reading without producing -0', () => {
    const delay = spinPhaseDelayMs(-450, 900)
    expect(delay).toBe(-450)
    expect(Object.is(delay, -0)).toBe(false)
  })

  it('defaults to the shared spin duration', () => {
    expect(spinPhaseDelayMs(450)).toBe(spinPhaseDelayMs(450, SPIN_DURATION_MS))
  })

  it('formats a ready-to-use inline style', () => {
    expect(spinPhaseStyle(450, 900)).toEqual({ animationDelay: '-450ms' })
    expect(spinPhaseStyle(0, 900)).toEqual({ animationDelay: '0ms' })
  })
})
