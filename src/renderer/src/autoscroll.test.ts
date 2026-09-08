import { describe, expect, it } from 'vitest'
import { autoscrollSpeed, autoscrollStep, canScroll, isScrollableOverflow } from './autoscroll'

describe('middle-click autoscroll', () => {
  it('ignores a steady hand and accelerates with distance in the pulled direction', () => {
    expect(autoscrollSpeed(0)).toBe(0)
    expect(autoscrollSpeed(11)).toBe(0)
    expect(autoscrollSpeed(-11)).toBe(0)
    expect(autoscrollSpeed(40)).toBeGreaterThan(0)
    expect(autoscrollSpeed(-40)).toBe(-autoscrollSpeed(40))
    expect(autoscrollSpeed(120)).toBeGreaterThan(autoscrollSpeed(40))
    expect(autoscrollSpeed(100_000)).toBeLessThanOrEqual(3200)
  })
  it('scales each frame by its own duration so speed never depends on frame rate', () => {
    expect(autoscrollStep(60, 0)).toBe(0)
    expect(autoscrollStep(60, 1 / 30)).toBeCloseTo(autoscrollStep(60, 1 / 60) * 2, 6)
  })
  it('only claims surfaces that actually scroll', () => {
    expect(isScrollableOverflow('auto')).toBe(true)
    expect(isScrollableOverflow('scroll')).toBe(true)
    expect(isScrollableOverflow('hidden')).toBe(false)
    expect(isScrollableOverflow('visible')).toBe(false)
    expect(canScroll('auto', 900, 400)).toBe(true)
    expect(canScroll('auto', 400, 400)).toBe(false)
    expect(canScroll('hidden', 900, 400)).toBe(false)
  })
})
