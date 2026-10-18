/**
 * Bringing a focused tab into view in its pane's tab strip. Focusing a tab from anywhere (its chip,
 * the sidebar, the coworkers row, a notification, app control tabs.focus) used to leave it where it
 * was: a tab past the strip's right edge became active while still sitting in "+N". The strip now
 * scrolls itself, and only itself: no element is focused and nothing scrolls the window, so a parked
 * window is never activated by it.
 */

/** Space kept between a revealed tab and the strip edge it was brought to. */
export const REVEAL_MARGIN = 8
/** Asks every pane strip holding this tab to bring it into view, also when it is already active. */
export const TAB_REVEAL_EVENT = 'conductor:reveal-tab'

export type StripView = { scrollLeft: number; clientWidth: number; scrollWidth: number }
/** The tab's start and width in the strip's scrolled content, so independent of the current scroll. */
export type TabSpan = { start: number; width: number }

/** The strip scrollLeft that shows the whole tab, moving as little as possible, or null when the tab
 *  is already fully in view. A tab wider than the strip is aligned by its start. */
export function revealScrollLeft(view: StripView, tab: TabSpan, margin = REVEAL_MARGIN): number | null {
  const end = tab.start + tab.width
  const visibleStart = view.scrollLeft, visibleEnd = view.scrollLeft + view.clientWidth
  if (tab.start >= visibleStart - 0.5 && end <= visibleEnd + 0.5) return null
  const target = tab.start < visibleStart || tab.width + margin * 2 > view.clientWidth ? tab.start - margin : end - view.clientWidth + margin
  const clamped = Math.round(Math.max(0, Math.min(target, view.scrollWidth - view.clientWidth)))
  return Math.abs(clamped - view.scrollLeft) < 1 ? null : clamped
}

/** Scrolls the strip so the tab with this id is fully visible; false when the strip does not hold it. */
export function revealTabInStrip(strip: HTMLElement, tabId: string, { instant = false }: { instant?: boolean } = {}): boolean {
  const node = strip.querySelector<HTMLElement>(`.pane-tab[data-control-tab-id="${CSS.escape(tabId)}"]`)
  if (!node?.getClientRects().length) return false
  const stripRect = strip.getBoundingClientRect(), tabRect = node.getBoundingClientRect()
  const left = revealScrollLeft(
    { scrollLeft: strip.scrollLeft, clientWidth: strip.clientWidth, scrollWidth: strip.scrollWidth },
    { start: tabRect.left - stripRect.left - strip.clientLeft + strip.scrollLeft, width: tabRect.width }
  )
  if (left === null) return true
  // A hidden window paints no frames, so a smooth scroll there would never arrive.
  const smooth = !instant && !document.hidden && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  strip.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' })
  return true
}

/** Brings the tab into view in whichever strip holds it, once the layout that activates it is painted. */
export function requestTabReveal(tabId: string): void {
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return
  requestAnimationFrame(() => window.dispatchEvent(new CustomEvent<{ tabId: string }>(TAB_REVEAL_EVENT, { detail: { tabId } })))
}
