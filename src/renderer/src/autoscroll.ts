/**
 * Middle-click autoscroll for every scrollable surface in the app: menus, task
 * lists, file trees and conversations. Chromium only ships this for the page
 * itself, so panes and popovers ignored it until now.
 */
const DEAD_ZONE = 12
const MAX_SPEED = 3200

/** Chromium-like ramp: a small pull creeps, a long pull races, direction is exact. */
export function autoscrollSpeed(distance: number): number {
  const travel = Math.abs(distance) - DEAD_ZONE
  if (travel <= 0) return 0
  return Math.sign(distance) * Math.min(MAX_SPEED, Math.pow(travel, 1.35) * 1.6)
}

/** Fractional pixels are carried between frames so slow scrolling never stalls. */
export function autoscrollStep(distance: number, seconds: number): number {
  return autoscrollSpeed(distance) * seconds
}

export function isScrollableOverflow(overflow: string): boolean {
  return ['auto', 'scroll', 'overlay'].includes(overflow)
}

export function canScroll(overflow: string, scrollSize: number, clientSize: number): boolean {
  return isScrollableOverflow(overflow) && scrollSize - clientSize > 1
}

/** Surfaces that already own the middle button, or that scroll by their own transform. */
const EXCLUDED = '[data-autoscroll="off"], .xterm, .monaco-editor, input, textarea, select'

export function autoscrollTarget(from: Element | null): Element | null {
  for (let node = from; node instanceof Element; node = node.parentElement) {
    if (node.closest(EXCLUDED)) return null
    const style = getComputedStyle(node)
    const vertical = canScroll(style.overflowY, node.scrollHeight, node.clientHeight)
    const horizontal = canScroll(style.overflowX, node.scrollWidth, node.clientWidth)
    if (vertical || horizontal) return node
  }
  return null
}

/** Installs the behavior for one document; detached windows install their own. */
export function installAutoscroll(doc: Document = document): () => void {
  const view = doc.defaultView
  if (!view) return () => {}
  let target: Element | null = null
  let anchor: HTMLElement | null = null
  let origin = { x: 0, y: 0 }
  let pointer = { x: 0, y: 0 }
  let carry = { x: 0, y: 0 }
  let startedAt = 0
  let moved = false
  let frame = 0
  let last = 0
  let consumedButton: number | null = null
  let consumedKey: string | null = null

  const stop = (): void => {
    if (!target) return
    target = null
    if (frame) view.cancelAnimationFrame(frame)
    frame = 0
    anchor?.remove()
    anchor = null
    doc.body.classList.remove('autoscrolling')
  }

  const tick = (now: number): void => {
    if (!target) return
    const seconds = Math.min(0.05, Math.max(0, (now - last) / 1000))
    last = now
    carry.x += autoscrollStep(pointer.x - origin.x, seconds)
    carry.y += autoscrollStep(pointer.y - origin.y, seconds)
    const x = Math.trunc(carry.x)
    const y = Math.trunc(carry.y)
    carry = { x: carry.x - x, y: carry.y - y }
    if (x || y) target.scrollBy({ left: x, top: y, behavior: 'instant' as ScrollBehavior })
    frame = view.requestAnimationFrame(tick)
  }

  const down = (event: MouseEvent): void => {
    // A new press ends any prior gesture, even if it produced no click.
    consumedButton = null
    if (target) { consumedButton = event.button; event.preventDefault(); event.stopPropagation(); stop(); return }
    if (event.button !== 1 || event.defaultPrevented) return
    const scroller = autoscrollTarget(event.target instanceof Element ? event.target : null)
    if (!scroller) return
    event.preventDefault()
    consumedButton = event.button
    target = scroller
    origin = { x: event.clientX, y: event.clientY }
    pointer = { ...origin }
    carry = { x: 0, y: 0 }
    startedAt = event.timeStamp
    moved = false
    anchor = doc.createElement('div')
    anchor.className = 'autoscroll-anchor'
    anchor.setAttribute('aria-hidden', 'true')
    anchor.style.left = origin.x + 'px'
    anchor.style.top = origin.y + 'px'
    doc.body.append(anchor)
    doc.body.classList.add('autoscrolling')
    last = view.performance.now()
    frame = view.requestAnimationFrame(tick)
  }

  const move = (event: MouseEvent): void => {
    if (!target) return
    pointer = { x: event.clientX, y: event.clientY }
    if (Math.abs(pointer.x - origin.x) > DEAD_ZONE || Math.abs(pointer.y - origin.y) > DEAD_ZONE) moved = true
  }
  // A press-and-drag scrolls while held; a quick click parks in autoscroll mode.
  const up = (event: MouseEvent): void => { if (target && event.button === 1 && (moved || event.timeStamp - startedAt > 350)) stop() }
  const cancel = (): void => stop()
  const consumeStopClick = (event: MouseEvent): void => {
    if (consumedButton !== event.button) return
    // Cancelling mousedown alone does not cancel the browser's later click.
    // Consume this stopping gesture before task/permission buttons can act.
    event.preventDefault()
    event.stopPropagation()
    // On Windows contextmenu can follow auxclick; keep the whole press consumed.
  }
  const contextMenu = (event: MouseEvent): void => { consumeStopClick(event); stop() }
  const keyDown = (event: KeyboardEvent): void => {
    consumedButton = null
    if (consumedKey === event.key) { event.preventDefault(); event.stopPropagation(); return }
    consumedKey = null
    if (!target) return
    stop()
    // These keys can activate a focused button or dismiss its containing dialog.
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
      consumedKey = event.key
      event.preventDefault()
      event.stopPropagation()
    }
  }
  const keyUp = (event: KeyboardEvent): void => {
    if (consumedKey !== event.key) return
    consumedKey = null
    event.preventDefault()
    event.stopPropagation()
  }

  doc.addEventListener('mousedown', down, true)
  doc.addEventListener('mousemove', move, true)
  doc.addEventListener('mouseup', up, true)
  doc.addEventListener('click', consumeStopClick, true)
  doc.addEventListener('auxclick', consumeStopClick, true)
  doc.addEventListener('wheel', cancel, true)
  doc.addEventListener('keydown', keyDown, true)
  doc.addEventListener('keyup', keyUp, true)
  doc.addEventListener('contextmenu', contextMenu, true)
  view.addEventListener('blur', cancel)
  return () => {
    stop()
    doc.removeEventListener('mousedown', down, true)
    doc.removeEventListener('mousemove', move, true)
    doc.removeEventListener('mouseup', up, true)
    doc.removeEventListener('click', consumeStopClick, true)
    doc.removeEventListener('auxclick', consumeStopClick, true)
    doc.removeEventListener('wheel', cancel, true)
    doc.removeEventListener('keydown', keyDown, true)
    doc.removeEventListener('keyup', keyUp, true)
    doc.removeEventListener('contextmenu', contextMenu, true)
    view.removeEventListener('blur', cancel)
  }
}
