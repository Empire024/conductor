/** How a conversation pane takes in its streamed events without taking the keyboard away.
 *
 * Events are applied at most once per animation frame, in slices bounded by a time budget; a
 * backlog larger than one budget (a reconnect replay, a flood of tool output, the fixture's
 * 12,000 events a second) continues in a fresh task, so keystrokes queued behind it run between
 * slices instead of after all of it. Applying is cheap bookkeeping outside React; rendering the
 * result is the expensive part, so it happens once the backlog has drained, or at most every
 * `renderEveryMs` while a long one is still being worked through.
 *
 * A render is handed to React as an interruptible transition, and the next one waits until the
 * caller reports it `committed`. A transition that keeps receiving new updates is restarted by
 * each of them, and one starved for a few seconds is finished synchronously, all at once, which
 * is exactly the multi-second stall this exists to prevent. One render in flight at a time lets
 * each finish between keystrokes.
 *
 * Input comes first. Each commit of a long conversation also costs the browser a frame of style,
 * layout, paint and hit testing that nothing can interrupt, so while the owner is typing a new
 * render waits for a pause (`inputQuietMs` without a key), never longer than `maxHoldMs`: the
 * conversation keeps moving in steps, and the keys in between paint at once. */
export interface StreamIngestOptions<E> {
  /** Folds events into the caller's latest state. Called with every event exactly once, in order. */
  apply(events: E[]): void
  /** Shows the latest state; called after apply, never more than once per slice. */
  render(): void
  budgetMs?: number
  sliceSize?: number
  renderEveryMs?: number
  /** A render that never reports its commit (React bailed out on an equal state) stops blocking after this. */
  commitTimeoutMs?: number
  /** When the owner last pressed a key, on the `now` clock; renders wait for a pause in typing. */
  lastInputAt?(): number
  inputQuietMs?: number
  maxHoldMs?: number
  now?(): number
  frame?(run: () => void): () => void
  task?(run: () => void): () => void
  delay?(run: () => void, ms: number): () => void
}
export interface StreamIngest<E> {
  push(events: E[]): void
  /** Takes everything queued so far, for a caller folding it into a freshly loaded snapshot. */
  drain(): E[]
  /** Starts applying; events pushed before this wait in the queue. */
  start(): void
  /** The last render reached the screen; a newer state may now be rendered. */
  committed(): void
  dispose(): void
}

let ownerKeyAt = Number.NEGATIVE_INFINITY
if (typeof document !== 'undefined') document.addEventListener('keydown', event => { ownerKeyAt = event.timeStamp }, { capture: true, passive: true })
/** When the owner last pressed a key anywhere in this window, on the performance.now() clock. */
export const lastOwnerKeyAt = (): number => ownerKeyAt

const animationFrame =(run: () => void): (() => void) => { const id = requestAnimationFrame(run); return () => cancelAnimationFrame(id) }
const timerTask = (run: () => void): (() => void) => { const id = setTimeout(run, 0); return () => clearTimeout(id) }
const timerDelay = (run: () => void, ms: number): (() => void) => { const id = setTimeout(run, ms); return () => clearTimeout(id) }

export function createStreamIngest<E>(options: StreamIngestOptions<E>): StreamIngest<E> {
  const { apply, render, budgetMs = 6, sliceSize = 250, renderEveryMs = 250, commitTimeoutMs = 1000, lastInputAt = () => Number.NEGATIVE_INFINITY, inputQuietMs = 400, maxHoldMs = 1500, now = () => performance.now(), frame = animationFrame, task = timerTask, delay = timerDelay } = options
  let queue: E[] = []
  let started = false, disposed = false
  let cancel: (() => void) | null = null
  let lastRender = Number.NEGATIVE_INFINITY
  let unrendered = false
  let rendering: (() => void) | null = null
  let held: (() => void) | null = null
  let holdingSince: number | null = null
  /** How long a render should still wait for the owner to stop typing; 0 renders now. */
  const holdFor = (): number => {
    const typedAgo = now() - lastInputAt()
    if (typedAgo >= inputQuietMs) return 0
    holdingSince ??= now()
    const waited = now() - holdingSince
    return waited >= maxHoldMs ? 0 : Math.min(inputQuietMs - typedAgo, maxHoldMs - waited)
  }
  const schedule = (backlog: boolean): void => {
    if (cancel || disposed || !started) return
    cancel = (backlog ? task : frame)(run)
  }
  const committed = (): void => {
    if (!rendering) return
    rendering()
    rendering = null
    if (unrendered) schedule(false)
  }
  function run(): void {
    cancel = null
    if (disposed) return
    const deadline = now() + budgetMs
    // At least one slice per run, so a slow machine still makes progress.
    do {
      const slice = queue.length > sliceSize ? queue.splice(0, sliceSize) : queue.splice(0)
      if (!slice.length) break
      apply(slice)
      unrendered = true
    } while (queue.length && now() < deadline)
    const hold = unrendered && !rendering && !held ? holdFor() : 0
    if (hold > 0) held = delay(() => { held = null; schedule(false) }, hold)
    else if (unrendered && !rendering && !held && (!queue.length || now() - lastRender >= renderEveryMs)) {
      unrendered = false
      holdingSince = null
      lastRender = now()
      rendering = delay(committed, commitTimeoutMs)
      render()
    }
    if (queue.length) schedule(true)
  }
  return {
    push(events) {
      if (disposed || !events.length) return
      for (const event of events) queue.push(event)
      schedule(false)
    },
    drain() { const taken = queue; queue = []; return taken },
    start() { started = true; if (queue.length) schedule(false) },
    committed,
    dispose() { disposed = true; cancel?.(); cancel = null; rendering?.(); rendering = null; held?.(); held = null; queue = [] }
  }
}
