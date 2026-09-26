/**
 * Immediate feedback for clicks that start work in main (owner: "sometimes things load and idk if
 * i clicked"). Every bridge function the renderer calls is wrapped once, here, instead of a busy
 * flag per button: a call that returns a promise within a moment of a user gesture (click, Enter
 * or Space, a change or submit) counts as that gesture's work. Once such work has been pending for
 * 100 ms the whole app shows the progress cursor and the control that was used is marked busy
 * (data-ipc-busy, aria-busy) until the work settles. Faster work never shows anything, and a state
 * that did show stays up briefly so it does not flash. Background calls (polling, subscriptions,
 * event-driven refreshes) are never attributed to a gesture, so they never move the cursor.
 * A gesture's work may run as a chain (open a project, then load its tabs): a call that starts
 * right after one of the gesture's calls settles still belongs to it, but only for a few links and
 * a bounded time, so a poller that happens to fire just after a click cannot chain itself to that
 * click for as long as it keeps polling (VR7 C2b).
 */

export interface BusyEnvironment<Control> {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setAppBusy(busy: boolean): void
  setControlBusy(control: Control, busy: boolean): void
}

export interface BusyOptions {
  /** How long after a gesture a started call still belongs to it. */
  gestureWindowMs: number
  /** How soon after one of a gesture's calls settles the next call must start to extend its chain. */
  chainWindowMs: number
  /** How many calls may join a gesture's chain after its first window. */
  maxChainLinks: number
  /** No call joins a gesture's chain later than this after the gesture. */
  chainCapMs: number
  /** Work that settles sooner shows nothing. */
  showAfterMs: number
  /** Once shown, the busy state stays at least this long. */
  minShowMs: number
  /** A call that never settles stops showing after this; the cursor must not spin forever. */
  maxMs: number
}

export const DEFAULT_BUSY_OPTIONS: BusyOptions = { gestureWindowMs: 500, chainWindowMs: 250, maxChainLinks: 4, chainCapMs: 15_000, showAfterMs: 100, minShowMs: 150, maxMs: 60_000 }

interface Call<Control> { control: Control | null; gesture: number; shownAt: number | null; done: boolean; timers: unknown[] }

export class BusyWork<Control> {
  private gestureId = 0
  private gestureAt = -Infinity
  private gestureControl: Control | null = null
  /** When the current gesture's latest call settled, and how many calls joined its chain since. */
  private chainAt = -Infinity
  private chainLinks = 0
  private readonly visible = new Set<Call<Control>>()
  private readonly busyControls = new Set<Control>()
  private appBusy = false
  private pending = 0

  constructor(private readonly env: BusyEnvironment<Control>, private readonly options: BusyOptions = DEFAULT_BUSY_OPTIONS) {}

  /** The owner acted on `control` (null: no specific control, e.g. Enter in a text field). */
  gesture(control: Control | null): void {
    this.gestureId++
    this.gestureAt = this.env.now()
    this.gestureControl = control
    this.chainAt = -Infinity
    this.chainLinks = 0
  }

  /** Whether any gesture's work is running (shown or not yet). */
  get inFlight(): number { return this.pending }

  /** Passes a bridge call's result through, tracking it when it is a gesture's pending work. */
  track<T>(result: T): T {
    if (!isThenable(result) || !this.attribute()) return result
    const call: Call<Control> = { control: this.gestureControl, gesture: this.gestureId, shownAt: null, done: false, timers: [] }
    this.pending++
    call.timers.push(this.env.setTimeout(() => this.show(call), this.options.showAfterMs))
    call.timers.push(this.env.setTimeout(() => this.settle(call), this.options.maxMs))
    const settle = (): void => this.settle(call)
    ;(result as PromiseLike<unknown>).then(settle, settle)
    return result
  }

  /** Whether a call starting now is the current gesture's work: inside the gesture's own window,
   *  or the next link of its chain (started right after one of its calls settled, within the link
   *  and time bounds). */
  private attribute(): boolean {
    const now = this.env.now()
    if (now - this.gestureAt <= this.options.gestureWindowMs) return true
    if (now - this.chainAt > this.options.chainWindowMs || this.chainLinks >= this.options.maxChainLinks || now - this.gestureAt > this.options.chainCapMs) return false
    this.chainLinks++
    return true
  }

  private show(call: Call<Control>): void {
    if (call.done) return
    call.shownAt = this.env.now()
    this.visible.add(call)
    this.refresh()
  }

  private settle(call: Call<Control>): void {
    if (call.done) return
    call.done = true
    this.pending--
    for (const timer of call.timers) this.env.clearTimeout(timer)
    // A chain (open a project, then load its tabs) keeps belonging to the gesture that began it.
    if (call.gesture === this.gestureId) this.chainAt = Math.max(this.chainAt, this.env.now())
    if (call.shownAt === null) return
    const remaining = this.options.minShowMs - (this.env.now() - call.shownAt)
    if (remaining > 0) this.env.setTimeout(() => this.hide(call), remaining)
    else this.hide(call)
  }

  private hide(call: Call<Control>): void {
    this.visible.delete(call)
    this.refresh()
  }

  private refresh(): void {
    const busy = this.visible.size > 0
    if (busy !== this.appBusy) { this.appBusy = busy; this.env.setAppBusy(busy) }
    const controls = new Set<Control>()
    for (const call of this.visible) if (call.control !== null) controls.add(call.control)
    for (const control of this.busyControls) if (!controls.has(control)) { this.busyControls.delete(control); this.env.setControlBusy(control, false) }
    for (const control of controls) if (!this.busyControls.has(control)) { this.busyControls.add(control); this.env.setControlBusy(control, true) }
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

/** Wraps every function of a bridge object (recursively) so its result passes through track().
 *  Only plain objects are walked; anything else is exposed as it is. */
export function wrapBridge<T>(bridge: T, work: Pick<BusyWork<unknown>, 'track'>): T {
  if (typeof bridge === 'function') {
    const fn = bridge as unknown as (...args: unknown[]) => unknown
    return function (this: unknown, ...args: unknown[]) { return work.track(fn.apply(this, args)) } as unknown as T
  }
  if (!bridge || typeof bridge !== 'object' || Array.isArray(bridge)) return bridge
  const prototype = Object.getPrototypeOf(bridge)
  if (prototype !== Object.prototype && prototype !== null) return bridge
  const wrapped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(bridge as Record<string, unknown>)) wrapped[key] = wrapBridge(value, work)
  return wrapped as T
}

const CONTROL_SELECTOR = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], summary, select, input[type="checkbox"], input[type="radio"], input[type="submit"], .project-row'

/** Wires the tracker to this window's input and document; returns the wrapped bridge. */
export function installBusyWork<T>(bridge: T, target: Window = window): T {
  const document = target.document
  const marked = new WeakSet<Element>()
  const work = new BusyWork<Element>({
    now: () => target.performance.now(),
    setTimeout: (callback, ms) => target.setTimeout(callback, ms),
    clearTimeout: handle => target.clearTimeout(handle as number),
    setAppBusy: busy => document.documentElement.classList.toggle('ipc-busy', busy),
    setControlBusy: (control, busy) => {
      if (busy) {
        control.setAttribute('data-ipc-busy', '')
        if (!control.hasAttribute('aria-busy')) { control.setAttribute('aria-busy', 'true'); marked.add(control) }
      } else {
        control.removeAttribute('data-ipc-busy')
        if (marked.delete(control)) control.removeAttribute('aria-busy')
      }
    }
  })
  const controlOf = (node: EventTarget | null): Element | null => {
    const element = node && (node as Node).nodeType === 1 ? node as Element : (node as Node | null)?.parentElement ?? null
    return element?.closest(CONTROL_SELECTOR) ?? null
  }
  // Typing is not a gesture: a space in the composer or a click into a text field starts nothing.
  const editable = (node: EventTarget | null): boolean => {
    const element = node as HTMLElement | null
    if (!element || element.nodeType !== 1) return false
    if (element.isContentEditable || element.tagName === 'TEXTAREA') return true
    return element.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|color|range)$/i.test((element as HTMLInputElement).type)
  }
  const onGesture = (event: Event): void => {
    if (!event.isTrusted) return
    const text = editable(event.target)
    if (event.type === 'keydown') {
      const keys = event as KeyboardEvent
      if (keys.repeat || keys.isComposing) return
      if (keys.key === ' ' ? text : keys.key !== 'Enter' || (text && keys.shiftKey)) return
    }
    if ((event.type === 'pointerdown' || event.type === 'click') && text) return
    if (event.type === 'pointerdown' && (event as PointerEvent).button !== 0) return
    work.gesture(controlOf(event.target))
  }
  for (const type of ['pointerdown', 'click', 'keydown', 'change', 'submit']) target.addEventListener(type, onGesture, { capture: true })
  return wrapBridge(bridge, work)
}
