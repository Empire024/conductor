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

const REMEMBERED_BROWSER_TOOLS_PREFIX = 'rememberedBrowserTools:'
/**
 * The owner's last deliberate browser-tools choice, per provider. Enabling the project browser is
 * an explicit session authority (structured-sessions.ts messageSettings), so it is remembered only
 * from the composer's own toggle and replayed onto brand-new conversations of that provider,
 * whether the owner or a coworker opened them. Local models have no browser; nothing is stored.
 */
export function rememberedBrowserTools(getSetting: (key: string) => string | null, provider: string | undefined): boolean | undefined {
  if (provider !== 'claude' && provider !== 'codex') return undefined
  const value = getSetting(REMEMBERED_BROWSER_TOOLS_PREFIX + provider)
  return value === 'true' ? true : value === 'false' ? false : undefined
}
export function rememberBrowserTools(setSetting: (key: string, value: string) => void, provider: string | undefined, enabled: boolean): void {
  if (provider !== 'claude' && provider !== 'codex') return
  setSetting(REMEMBERED_BROWSER_TOOLS_PREFIX + provider, enabled ? 'true' : 'false')
}

/** A filename suffix, never a path. Multiple suffixes such as test.ts are valid. */
export function normalizeNewFileExtension(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const extension = value.trim().replace(/^\./, '').toLowerCase()
  return extension.length <= 32 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(extension) ? extension : null
}
