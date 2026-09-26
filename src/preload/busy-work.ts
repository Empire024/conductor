/**
 * Immediate feedback for clicks that start work in main (owner: "sometimes things load and idk if
 * i clicked"). Every bridge function the renderer calls is wrapped once, here, instead of a busy
 * flag per button: a call that returns a promise as a user gesture's own work (click, Enter or
 * Space, a change or submit) is tracked. Once such work has been pending for 100 ms the whole app
 * shows the progress cursor and the control that was used is marked busy (data-ipc-busy,
 * aria-busy) until the work settles. Faster work never shows anything, and a state that did show
 * stays up briefly so it does not flash.
 *
 * "Own work" is causal, not a time window. A call belongs to a gesture when it starts in the task
 * that dispatched the gesture's event (its handlers, and the microtasks they queue), or in the task
 * in which one of the gesture's own calls settled (the handler's `await` continuing: open a
 * project, then load its tabs), each followed by one more posted task so a render the handler
 * scheduled (React's scheduler) still counts. A poller, subscription or event-driven refresh runs
 * from its own timer or IPC task and so never joins a gesture however close to a click it fires,
 * and never moves the cursor (VR7 C2b, VR8d K3).
 */

export interface BusyEnvironment<Control> {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** Runs `callback` in a later task, after every task already posted (a MessageChannel message). */
  nextTask(callback: () => void): void
  setAppBusy(busy: boolean): void
  setControlBusy(control: Control, busy: boolean): void
}

export interface BusyOptions {
  /** How many posted tasks after the gesture's task (or a settle's) still belong to it. */
  followTasks: number
  /** A safety bound: no more calls than this belong to one gesture. */
  maxChainLinks: number
  /** A safety bound: no call joins a gesture later than this after it. */
  chainCapMs: number
  /** Work that settles sooner shows nothing. */
  showAfterMs: number
  /** Once shown, the busy state stays at least this long. */
  minShowMs: number
  /** A call that never settles stops showing after this; the cursor must not spin forever. */
  maxMs: number
}

export const DEFAULT_BUSY_OPTIONS: BusyOptions = { followTasks: 1, maxChainLinks: 32, chainCapMs: 15_000, showAfterMs: 100, minShowMs: 150, maxMs: 60_000 }

interface Gesture<Control> { control: Control | null; at: number; links: number }
interface Call<Control> { gesture: Gesture<Control>; shownAt: number | null; done: boolean; timers: unknown[] }

export class BusyWork<Control> {
  /** The gesture whose task (or whose call's continuation) is running now, if any. */
  private current: Gesture<Control> | null = null
  private currentSerial = 0
  private readonly visible = new Set<Call<Control>>()
  private readonly busyControls = new Set<Control>()
  private appBusy = false
  private pending = 0

  constructor(private readonly env: BusyEnvironment<Control>, private readonly options: BusyOptions = DEFAULT_BUSY_OPTIONS) {}

  /** The owner acted on `control` (null: no specific control, e.g. Enter in a text field). Call it
   *  while the gesture's event is being dispatched, before the page's own handlers. */
  gesture(control: Control | null): void {
    this.enter({ control, at: this.env.now(), links: 0 })
  }

  /** Whether any gesture's work is running (shown or not yet). */
  get inFlight(): number { return this.pending }

  /** Passes a bridge call's result through, tracking it when it is a gesture's pending work. */
  track<T>(result: T): T {
    if (!isThenable(result)) return result
    const gesture = this.owner()
    if (!gesture) return result
    const call: Call<Control> = { gesture, shownAt: null, done: false, timers: [] }
    this.pending++
    call.timers.push(this.env.setTimeout(() => this.show(call), this.options.showAfterMs))
    call.timers.push(this.env.setTimeout(() => this.settle(call, false), this.options.maxMs))
    const settle = (): void => this.settle(call, true)
    ;(result as PromiseLike<unknown>).then(settle, settle)
    return result
  }

  /** Marks the running task as `gesture`'s until `followTasks` posted tasks later. A newer
   *  gesture or settle takes over; the older window's closing hops then do nothing. */
  private enter(gesture: Gesture<Control>): void {
    this.current = gesture
    const serial = ++this.currentSerial
    let hops = this.options.followTasks + 1
    const hop = (): void => {
      if (serial !== this.currentSerial) return
      if (--hops > 0) this.env.nextTask(hop)
      else this.current = null
    }
    this.env.nextTask(hop)
  }

  /** The gesture a call starting now belongs to: the one whose task is running, within bounds. */
  private owner(): Gesture<Control> | null {
    const gesture = this.current
    if (!gesture || gesture.links >= this.options.maxChainLinks || this.env.now() - gesture.at > this.options.chainCapMs) return null
    gesture.links++
    return gesture
  }

  private show(call: Call<Control>): void {
    if (call.done) return
    call.shownAt = this.env.now()
    this.visible.add(call)
    this.refresh()
  }

  private settle(call: Call<Control>, settled: boolean): void {
    if (call.done) return
    call.done = true
    this.pending--
    for (const timer of call.timers) this.env.clearTimeout(timer)
    // The code awaiting this call continues in this task: what it starts is the same gesture's work.
    if (settled) this.enter(call.gesture)
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
    for (const call of this.visible) if (call.gesture.control !== null) controls.add(call.gesture.control)
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
  // Posted messages run in the order they were posted, after the running task and its microtasks.
  const channel = new MessageChannel()
  const posted: Array<() => void> = []
  channel.port1.onmessage = () => { posted.shift()?.() }
  const work = new BusyWork<Element>({
    now: () => target.performance.now(),
    setTimeout: (callback, ms) => target.setTimeout(callback, ms),
    clearTimeout: handle => target.clearTimeout(handle as number),
    nextTask: callback => { posted.push(callback); channel.port2.postMessage(null) },
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
    if ((event.type === 'pointerdown' || event.type === 'pointerup' || event.type === 'click') && text) return
    if ((event.type === 'pointerdown' || event.type === 'pointerup') && (event as PointerEvent).button !== 0) return
    work.gesture(controlOf(event.target))
  }
  // Captured on the window, so the gesture is known before any handler of the page runs.
  for (const type of ['pointerdown', 'pointerup', 'click', 'keydown', 'change', 'submit']) target.addEventListener(type, onGesture, { capture: true })
  return wrapBridge(bridge, work)
}
