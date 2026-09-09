import { describe, expect, it, vi } from 'vitest'
import { applyAppTheme, resolveThemeVariant } from './appearance'

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

// Minimal stand-in for document.documentElement: just the bits applyAppTheme touches.
function fakeRoot(options: { reducedMotion?: boolean; startViewTransition?: (update: () => void) => { finished: Promise<void> } } = {}): HTMLElement {
  const dataset: Record<string, string> = {}
  const style: Record<string, string> = {}
  const root = {
    dataset,
    style,
    ownerDocument: {
      defaultView: { matchMedia: () => ({ matches: !!options.reducedMotion }) },
      startViewTransition: options.startViewTransition
    }
  }
  return root as unknown as HTMLElement
}

describe('applyAppTheme', () => {
  it('sets the dataset attributes and color-scheme for the resolved variant', () => {
    const root = fakeRoot()
    const variant = applyAppTheme({ themeId: 'nord', themeVariant: 'day', themeAuto: true }, root, new Date(2026, 8, 6, 12, 0))
    expect(variant).toBe('day')
    expect(root.dataset.themeId).toBe('nord')
    expect(root.dataset.theme).toBe('light')
    expect(root.dataset.themeVariant).toBe('day')
    expect(root.dataset.themeAuto).toBe('true')
    expect(root.style.colorScheme).toBe('light')
  })

  it('wraps the swap in startViewTransition when available and motion is allowed', () => {
    let ranUpdate = false
    const startViewTransition = vi.fn((update: () => void) => { update(); ranUpdate = true; return { finished: Promise.resolve() } })
    const root = fakeRoot({ startViewTransition })
    root.dataset.themeId = 'nord'
    root.dataset.themeVariant = 'day'
    applyAppTheme({ themeId: 'nord', themeVariant: 'night', themeAuto: false }, root)
    expect(startViewTransition).toHaveBeenCalledTimes(1)
    expect(ranUpdate).toBe(true)
    expect(root.dataset.themeVariant).toBe('night')
    expect(root.style.colorScheme).toBe('dark')
  })

  it('still applies the theme synchronously when startViewTransition is absent', () => {
    const root = fakeRoot()
    root.dataset.themeId = 'nord'
    root.dataset.themeVariant = 'day'
    const variant = applyAppTheme({ themeId: 'nord', themeVariant: 'night', themeAuto: false }, root)
    expect(variant).toBe('night')
    expect(root.dataset.themeVariant).toBe('night')
    expect(root.style.colorScheme).toBe('dark')
  })

  it('still applies the theme, without starting a transition, when reduced motion is preferred', () => {
    const startViewTransition = vi.fn()
    const root = fakeRoot({ reducedMotion: true, startViewTransition })
    root.dataset.themeId = 'nord'
    root.dataset.themeVariant = 'day'
    applyAppTheme({ themeId: 'nord', themeVariant: 'night', themeAuto: false }, root)
    expect(startViewTransition).not.toHaveBeenCalled()
    expect(root.dataset.themeVariant).toBe('night')
  })
})
