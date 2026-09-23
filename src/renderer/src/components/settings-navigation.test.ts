import { describe, expect, it } from 'vitest'
import { matchingSettingsSections, resolveSettingsSection, SETTINGS_SECTIONS } from './settings-navigation'

describe('settings navigation', () => {
  it('keeps the owner-facing page order stable', () => {
    expect(SETTINGS_SECTIONS.map(section => section.id)).toEqual(['general', 'appearance', 'sounds', 'usage', 'machines', 'phone', 'updates', 'runtimes', 'debug'])
  })
  it('matches titles, descriptions and controls, ignoring case and extra space', () => {
    expect(matchingSettingsSections(' PHONE ')).toEqual(['phone'])
    expect(matchingSettingsSections('colors')).toEqual(['appearance'])
    expect(matchingSettingsSections('  HIDDEN   files ')).toEqual(['general'])
    expect(matchingSettingsSections('tokens')).toEqual(['usage'])
    expect(matchingSettingsSections('tailscale')).toEqual(['machines', 'phone'])
    expect(matchingSettingsSections('not-a-setting')).toEqual([])
    expect(matchingSettingsSections('  ')).toHaveLength(9)
  })
  it('opens General first, remembers the last page, and lets a deep link override it', () => {
    expect(resolveSettingsSection()).toBe('general')
    expect(resolveSettingsSection(undefined, 'sounds')).toBe('sounds')
    for (const section of SETTINGS_SECTIONS) expect(resolveSettingsSection(section.id, 'debug')).toBe(section.id)
    expect(resolveSettingsSection('unknown', 'updates')).toBe('updates')
  })
})
