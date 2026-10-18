import { describe, expect, it } from 'vitest'
import { REVEAL_MARGIN, revealScrollLeft } from './tab-strip-reveal'

const view = (scrollLeft: number, clientWidth = 600, scrollWidth = 2000) => ({ scrollLeft, clientWidth, scrollWidth })

describe('revealScrollLeft (a focused tab is brought fully into its strip)', () => {
  it('leaves a tab that is already fully visible where it is', () => {
    expect(revealScrollLeft(view(0), { start: 10, width: 120 })).toBeNull()
    expect(revealScrollLeft(view(300), { start: 300, width: 600 })).toBeNull()
  })

  it('scrolls just far enough to show a tab past the right edge, with a margin', () => {
    const left = revealScrollLeft(view(0), { start: 1500, width: 150 })
    expect(left).toBe(1500 + 150 - 600 + REVEAL_MARGIN)
    expect(1500 + 150).toBeLessThanOrEqual(left! + 600)
  })

  it('shows a tab cut by the right edge whole', () => {
    expect(revealScrollLeft(view(0), { start: 520, width: 120 })).toBe(520 + 120 - 600 + REVEAL_MARGIN)
  })

  it('scrolls back to a tab before the left edge, or cut by it', () => {
    expect(revealScrollLeft(view(900), { start: 100, width: 120 })).toBe(100 - REVEAL_MARGIN)
    expect(revealScrollLeft(view(900), { start: 850, width: 120 })).toBe(850 - REVEAL_MARGIN)
  })

  it('aligns a tab wider than the strip by its start', () => {
    expect(revealScrollLeft(view(0, 200), { start: 700, width: 226 })).toBe(700 - REVEAL_MARGIN)
  })

  it('stays inside the scrollable range', () => {
    expect(revealScrollLeft(view(0, 600, 1640), { start: 1520, width: 118 })).toBe(1040)
    expect(revealScrollLeft(view(400), { start: 4, width: 118 })).toBe(0)
  })

  it('does nothing when the remaining distance is under a pixel', () => {
    expect(revealScrollLeft(view(1049.4), { start: 1520, width: 130 }, 0)).toBeNull()
  })
})
