import { describe, expect, it } from 'vitest'
import { resolveThemeVariant } from './appearance'

describe('theme variant resolution', () => {
  it('keeps the selected variant while automatic switching is off', () => {
    expect(resolveThemeVariant(
      { themeVariant: 'day', themeAuto: false },
      new Date(2026, 8, 6, 23, 0)
    )).toBe('day')
    expect(resolveThemeVariant(
      { themeVariant: 'night', themeAuto: false },
      new Date(2026, 8, 6, 12, 0)
    )).toBe('night')
  })

  it('uses local day hours only while automatic switching is on', () => {
    expect(resolveThemeVariant(
      { themeVariant: 'night', themeAuto: true },
      new Date(2026, 8, 6, 7, 0)
    )).toBe('day')
    expect(resolveThemeVariant(
      { themeVariant: 'day', themeAuto: true },
      new Date(2026, 8, 6, 18, 59)
    )).toBe('day')
    expect(resolveThemeVariant(
      { themeVariant: 'day', themeAuto: true },
      new Date(2026, 8, 6, 19, 0)
    )).toBe('night')
  })
})
