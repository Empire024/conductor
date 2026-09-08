import type { AppSettings, ThemeVariant } from '../../shared/models'

const transitionTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

export const DAY_START_HOUR = 7
export const NIGHT_START_HOUR = 19

export function resolveThemeVariant(
  settings: Pick<AppSettings, 'themeVariant' | 'themeAuto'>,
  at = new Date()
): ThemeVariant {
  if (!settings.themeAuto) return settings.themeVariant
  const hour = at.getHours()
  return hour >= DAY_START_HOUR && hour < NIGHT_START_HOUR ? 'day' : 'night'
}

export function applyAppTheme(
  settings: Pick<AppSettings, 'themeId' | 'themeVariant' | 'themeAuto'>,
  root: HTMLElement = document.documentElement,
  at = new Date()
): ThemeVariant {
  const variant = resolveThemeVariant(settings, at)
  const changed = root.dataset.themeId && (root.dataset.themeId !== settings.themeId || root.dataset.themeVariant !== variant)
  if (changed && !root.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    clearTimeout(transitionTimers.get(root))
    root.classList.add('theme-changing')
    // Install transitions before replacing the palette, including embedded editors.
    void root.offsetWidth
    transitionTimers.set(root, setTimeout(() => root.classList.remove('theme-changing'), 460))
  }
  root.dataset.themeId = settings.themeId
  // Keep light/dark here for existing component selectors and Monaco integration.
  root.dataset.theme = variant === 'day' ? 'light' : 'dark'
  root.dataset.themeVariant = variant
  root.dataset.themeAuto = String(settings.themeAuto)
  root.style.colorScheme = variant === 'day' ? 'light' : 'dark'
  return variant
}
