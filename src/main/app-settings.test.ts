import { describe, expect, it } from 'vitest'
import { normalizeNewFileExtension, normalizeThemeSettings } from './app-settings'

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

describe('new file extension settings', () => {
  it('normalizes conventional extensions and rejects paths or invalid suffixes', () => {
    expect(normalizeNewFileExtension(' .MD ')).toBe('md')
    expect(normalizeNewFileExtension('test.ts')).toBe('test.ts')
    for (const value of ['../ts', 'a/b', 'a\\b', '', '.', 'md.', '..md', 'a'.repeat(33), null]) expect(normalizeNewFileExtension(value)).toBeNull()
  })
})
