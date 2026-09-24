import { describe, expect, it } from 'vitest'
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, clampSidebarWidth } from './Sidebar'

describe('clampSidebarWidth', () => {
  it('keeps a width inside the min/max range unchanged', () => {
    expect(clampSidebarWidth(300)).toBe(300)
    expect(clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH)).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('clamps below the minimum up to it', () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(-50)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(150)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('clamps above the maximum down to it', () => {
    expect(clampSidebarWidth(900)).toBe(SIDEBAR_MAX_WIDTH)
  })
})
