/** The mouse events a tab needs to close on a middle click, as React handler props. */
interface MiddleButtonEvent { button: number; preventDefault(): void; stopPropagation(): void }

/**
 * A middle click on a tab closes it, as in the conversation tab strip. The press itself must be
 * cancelled: on a strip that overflows, Chromium otherwise starts its own autoscroll on mousedown,
 * shows the scroll cursor and swallows the release, so the auxclick that closes never arrives.
 * Spread the result onto the tab together with data-autoscroll="off" (src/renderer/src/autoscroll.ts).
 */
export function middleClickClose(close: () => void, enabled = true): { onMouseDown(event: MiddleButtonEvent): void; onAuxClick(event: MiddleButtonEvent): void } {
  return {
    onMouseDown: event => { if (enabled && event.button === 1) event.preventDefault() },
    onAuxClick: event => {
      if (!enabled || event.button !== 1) return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }
}
