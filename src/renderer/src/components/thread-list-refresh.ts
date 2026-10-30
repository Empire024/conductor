/**
 * The Threads list's refresh lifecycle, apart from React so it can be driven with fake timers and
 * deferred readers. One controller per mounted list; it is the only thing that calls `read`.
 *
 *  - Pushes from main (`threads:changed`) replace the five-second poll. The subscription is made
 *    before the first read, so a change between the two is not lost.
 *  - Reads never overlap: an invalidation that lands while one is in flight leaves one trailing
 *    read, however many arrive, and bursts leave at most one read per `minIntervalMs`.
 *  - A result is applied only if its query is still the current one and the list is still shown.
 *    Otherwise it is dropped and the list is marked stale, so it catches up when shown again.
 *  - Collapsed or hidden, nothing is read; becoming visible again always reads once.
 *  - A reader that throws, rejects or never answers is retried with backoff while the list is shown.
 *    Nothing escapes as an unhandled rejection.
 *  - While shown, a cheap local clock (no read) lets row ages move on without the poll.
 *
 * The interval and backoff defaults are choices, not measurements.
 */
import type { ThreadView } from '../../../shared/threads'

export interface ThreadListRefreshEnvironment {
  /** True while the window is visible (`document.visibilityState === 'visible'`). */
  isVisible(): boolean
  /** Window focus; returns the unsubscribe. */
  onFocus(listener: () => void): () => void
  /** Page visibility changes; returns the unsubscribe. */
  onVisibilityChange(listener: () => void): () => void
}

export interface ThreadListRefreshOptions {
  environment: ThreadListRefreshEnvironment
  /** `threads:changed` from main; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /** `threads:list`. May return a promise, a value, or throw. */
  read(query: string): Promise<ThreadView> | ThreadView
  /** A current result. Never called after `dispose`, for a superseded query, or while hidden. */
  onView(view: ThreadView): void
  /** Local clock tick while shown, for ages; reads nothing. */
  onClock?(now: number): void
  onError?(error: unknown): void
  query?: string
  collapsed?: boolean
  /** Push bursts wait this long so they leave as one read. */
  coalesceMs?: number
  /** The shortest gap between the starts of two reads. */
  minIntervalMs?: number
  retryMs?: number
  maxRetryMs?: number
  /** A read that has not answered by now counts as failed and no longer blocks the next one. */
  readTimeoutMs?: number
  clockMs?: number
  now?(): number
}

export interface ThreadListRefresh {
  setQuery(query: string): void
  setCollapsed(collapsed: boolean): void
  /** A push or `refreshKey` change: coalesced. Held while hidden or collapsed. */
  invalidate(): void
  /** Read as soon as no read is running (after the owner changed something). */
  refreshNow(): void
  dispose(): void
}

export const THREAD_REFRESH_DEFAULTS = {
  coalesceMs: 60,
  minIntervalMs: 400,
  retryMs: 1000,
  maxRetryMs: 15_000,
  readTimeoutMs: 20_000,
  clockMs: 30_000
} as const

export function createThreadListRefresh(options: ThreadListRefreshOptions): ThreadListRefresh {
  const { environment } = options
  const coalesceMs = options.coalesceMs ?? THREAD_REFRESH_DEFAULTS.coalesceMs
  const minIntervalMs = options.minIntervalMs ?? THREAD_REFRESH_DEFAULTS.minIntervalMs
  const retryMs = options.retryMs ?? THREAD_REFRESH_DEFAULTS.retryMs
  const maxRetryMs = options.maxRetryMs ?? THREAD_REFRESH_DEFAULTS.maxRetryMs
  const readTimeoutMs = options.readTimeoutMs ?? THREAD_REFRESH_DEFAULTS.readTimeoutMs
  const clockMs = options.clockMs ?? THREAD_REFRESH_DEFAULTS.clockMs
  const now = options.now ?? Date.now

  let query = options.query ?? ''
  let collapsed = options.collapsed ?? false
  let visible = environment.isVisible()
  let disposed = false
  let dirty = false
  let failures = 0
  let lastStart = Number.NEGATIVE_INFINITY
  let nextRun: ReturnType<typeof setTimeout> | null = null
  let clock: ReturnType<typeof setInterval> | null = null
  // The one read allowed to answer; a newer token replaces it, which is how a timed-out read is abandoned.
  let flight: { token: number; query: string; timeout: ReturnType<typeof setTimeout> } | null = null
  let tokens = 0

  const active = (): boolean => !disposed && !collapsed && visible
  const report = (error: unknown): void => { try { options.onError?.(error) } catch { /* a reporter must not break the list */ } }
  const clearNextRun = (): void => { if (nextRun) clearTimeout(nextRun); nextRun = null }

  const schedule = (urgent: boolean): void => {
    dirty = true
    if (!active() || flight) return // a settling read looks at `dirty`
    if (urgent) { clearNextRun(); run(); return }
    if (nextRun) return
    const wait = Math.max(coalesceMs, lastStart + minIntervalMs - now())
    nextRun = setTimeout(() => { nextRun = null; run() }, wait)
  }

  function run(): void {
    if (!active() || flight) return
    dirty = false
    lastStart = now()
    const token = ++tokens
    const asked = query
    const timeout = setTimeout(() => settle(token, asked, { failed: new Error('The thread list did not answer') }), readTimeoutMs)
    flight = { token, query: asked, timeout }
    let pending: Promise<ThreadView>
    try { pending = Promise.resolve(options.read(asked)) } catch (error) { pending = Promise.reject(error) }
    pending.then(view => settle(token, asked, { view }), error => settle(token, asked, { failed: error }))
  }

  function settle(token: number, asked: string, outcome: { view: ThreadView } | { failed: unknown }): void {
    if (!flight || flight.token !== token) return // abandoned
    clearTimeout(flight.timeout)
    flight = null
    if (disposed) return
    if ('failed' in outcome) {
      report(outcome.failed)
      if (!active()) { dirty = true; return }
      failures += 1
      dirty = true
      if (asked !== query) { schedule(true); return }
      clearNextRun()
      nextRun = setTimeout(() => { nextRun = null; run() }, Math.min(maxRetryMs, retryMs * 2 ** (failures - 1)))
      return
    }
    failures = 0
    if (asked !== query || !active()) dirty = true
    else {
      try { options.onView(outcome.view) } catch (error) { report(error) }
    }
    if (dirty) schedule(asked !== query)
  }

  const stopClock = (): void => { if (clock) clearInterval(clock); clock = null }
  const syncActivity = (): void => {
    if (active()) {
      if (!clock && options.onClock) clock = setInterval(() => { if (active()) { try { options.onClock?.(now()) } catch (error) { report(error) } } }, clockMs)
      schedule(true) // shown again, or first shown: always read once
    } else {
      stopClock()
      clearNextRun() // hidden or collapsed reads nothing; pushes keep marking it stale
    }
  }

  // Subscribe first: a change between this and the first read is already marked and read again.
  const unsubscribe = ((): (() => void) => {
    try { return options.subscribe(() => schedule(false)) } catch (error) { report(error); return () => undefined }
  })()
  const onFocus = (): void => { if (active()) schedule(true) }
  const onVisibility = (): void => {
    const next = environment.isVisible()
    if (next === visible) return
    visible = next
    syncActivity()
  }
  const offFocus = environment.onFocus(onFocus)
  const offVisibility = environment.onVisibilityChange(onVisibility)
  syncActivity()

  return {
    setQuery(next) {
      if (next === query) return
      query = next
      if (active()) schedule(true) // an in-flight read for the old query answers into the void
      else dirty = true
    },
    setCollapsed(next) {
      if (next === collapsed) return
      collapsed = next
      syncActivity()
    },
    invalidate() { schedule(false) },
    refreshNow() { schedule(true) },
    dispose() {
      if (disposed) return
      disposed = true
      clearNextRun()
      stopClock()
      if (flight) clearTimeout(flight.timeout)
      flight = null
      unsubscribe()
      offFocus()
      offVisibility()
    }
  }
}

/** The window's own focus and visibility. Touched only when called, so importing stays Node-safe. */
export function browserThreadListEnvironment(): ThreadListRefreshEnvironment {
  return {
    isVisible: () => document.visibilityState === 'visible',
    onFocus: listener => { window.addEventListener('focus', listener); return () => window.removeEventListener('focus', listener) },
    onVisibilityChange: listener => { document.addEventListener('visibilitychange', listener); return () => document.removeEventListener('visibilitychange', listener) }
  }
}
