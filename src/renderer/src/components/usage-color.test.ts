import { describe, expect, it } from 'vitest'
import { usageColor, usageRedShare } from './usage-color'

describe('usage graph colour', () => {
  it('stays plain blue through most of the range', () => {
    expect(usageRedShare(0)).toBe(0)
    expect(usageRedShare(50)).toBe(0)
    expect(usageRedShare(75)).toBe(0)
    expect(usageColor(0)).toBe(usageColor(75))
  })
  it('turns red sharply and only fully at 100%', () => {
    expect(usageRedShare(100)).toBe(1)
    expect(usageRedShare(90)).toBeLessThan(0.5)
    expect(usageRedShare(95)).toBeGreaterThan(usageRedShare(90))
    expect(usageColor(100)).toBe('rgb(229, 57, 53)')
  })
  it('clamps out-of-range values and never decreases', () => {
    expect(usageRedShare(-10)).toBe(0)
    expect(usageRedShare(140)).toBe(1)
    let last = 0
    for (let p = 0; p <= 100; p += 1) { const share = usageRedShare(p); expect(share).toBeGreaterThanOrEqual(last); last = share }
  })
})
