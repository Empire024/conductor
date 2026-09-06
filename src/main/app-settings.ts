import type { ThemeId, ThemeVariant } from '../shared/models'
import { THEME_IDS, THEME_VARIANTS } from '../shared/models'

export interface StoredThemeSettings {
  themeId: string | null
  themeVariant: string | null
  themeAuto: string | null
  legacyThemeMode: string | null
}

export interface ThemeSettings {
  themeId: ThemeId
  themeVariant: ThemeVariant
  themeAuto: boolean
}

export function normalizeThemeSettings(stored: StoredThemeSettings): ThemeSettings {
  const themeId: ThemeId = THEME_IDS.includes(stored.themeId as ThemeId)
    ? stored.themeId as ThemeId
    : 'night-owl'
  const themeVariant: ThemeVariant = THEME_VARIANTS.includes(stored.themeVariant as ThemeVariant)
    ? stored.themeVariant as ThemeVariant
    : stored.legacyThemeMode === 'light' ? 'day' : 'night'
  const themeAuto = stored.themeAuto === 'true' || (
    stored.themeAuto === null && stored.legacyThemeMode !== 'dark' && stored.legacyThemeMode !== 'light'
  )
  return { themeId, themeVariant, themeAuto }
}
