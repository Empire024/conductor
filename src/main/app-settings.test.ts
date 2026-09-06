import { describe, expect, it } from 'vitest'
import { normalizeThemeSettings } from './app-settings'

describe('theme settings migration', () => {
  it.each([
    ['light', { themeId: 'night-owl', themeVariant: 'day', themeAuto: false }],
    ['dark', { themeId: 'night-owl', themeVariant: 'night', themeAuto: false }],
    ['auto', { themeId: 'night-owl', themeVariant: 'night', themeAuto: true }]
  ] as const)('migrates the legacy %s mode', (legacyThemeMode, expected) => {
    expect(normalizeThemeSettings({
      themeId: null,
      themeVariant: null,
      themeAuto: null,
      legacyThemeMode
    })).toEqual(expected)
  })

  it('keeps valid family settings instead of consulting the legacy mode', () => {
    expect(normalizeThemeSettings({
      themeId: 'obsidian',
      themeVariant: 'day',
      themeAuto: 'false',
      legacyThemeMode: 'auto'
    })).toEqual({ themeId: 'obsidian', themeVariant: 'day', themeAuto: false })
  })
})
