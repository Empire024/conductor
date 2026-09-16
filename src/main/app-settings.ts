import type { ThemeId, ThemeVariant } from '../shared/models'
import { THEME_IDS, THEME_VARIANTS } from '../shared/models'
import { isSessionPermission, type ProviderCapabilities, type SessionSettings, type StructuredProvider } from '../shared/structured-agent'

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

const REMEMBERED_PERMISSION_PREFIX = 'rememberedPermission:'
/**
 * Mirrors the renderer's per-provider permission memory (see
 * src/renderer/src/panes/permission-memory.ts) into the main process's own settings store, keyed
 * by provider. The renderer's choice lives in that window's localStorage, which the main process
 * cannot read directly; an agent-opened tab is created here, so it needs its own readable copy
 * rather than a second, independent notion of "remembered". Same guarantee as the renderer copy:
 * a mode is only ever remembered or replayed for the provider that actually offers it.
 */
export function rememberedPermission(getSetting: (key: string) => string | null, provider: StructuredProvider): SessionSettings['permission'] | undefined {
  const value = getSetting(REMEMBERED_PERMISSION_PREFIX + provider)
  return isSessionPermission(value) ? value : undefined
}
export function rememberPermission(setSetting: (key: string, value: string) => void, provider: StructuredProvider, permission: SessionSettings['permission'], capabilities?: ProviderCapabilities): void {
  if (capabilities && capabilities.provider !== provider) return
  if (capabilities?.permissions && !capabilities.permissions.includes(permission)) return
  setSetting(REMEMBERED_PERMISSION_PREFIX + provider, permission)
}

/** A filename suffix, never a path. Multiple suffixes such as test.ts are valid. */
export function normalizeNewFileExtension(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const extension = value.trim().replace(/^\./, '').toLowerCase()
  return extension.length <= 32 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(extension) ? extension : null
}
