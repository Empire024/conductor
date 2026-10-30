/**
 * Push invalidations for the Threads list (replaces the renderer's five-second poll).
 *
 * Main already announces everything that can change a thread row - a conversation's events, its
 * phase, the project list, remote machines, archives, new workspaces - on channels the windows
 * hear. This turns those into one payload-free `threads:changed` notice per burst to every live
 * window. A window answers it by asking `threads:list`, which keeps its trusted-sender check and
 * its async read of the phone state; the notice itself carries nothing a window could not ask for.
 *
 * `phone:changed` is deliberately absent: it is the desktop settings and status of phone access,
 * not a conversation event.
 */
import { THREADS_CHANGED_CHANNEL } from '../shared/threads'

/** The channels that change what the Threads list shows, as main broadcasts them. */
export const THREAD_INVALIDATING_CHANNELS: ReadonlySet<string> = new Set([
  'structured:events', // messages, titles (rename) and archive flags are session events
  'agent:status', // a phase change: working, needs the owner, idle, exited
  'projects:changed', // a project added, renamed, removed, or the General project turned into one
  'remote:changed', // a paired machine's projects and their threads come and go
  'session-archive:changed', // a closed workspace archived or restored
  'sessions:restored' // a workspace reopened or created by a task dispatch
])

/** What `BrowserWindow` already offers; narrowed so the module needs no Electron to be tested. */
export interface ThreadInvalidationWindow {
  isDestroyed(): boolean
  webContents: { isDestroyed(): boolean; send(channel: string): void }
}

export interface ThreadInvalidationDeps {
  /** Every window, live or not; destroyed ones are skipped at send time. */
  windows(): readonly ThreadInvalidationWindow[]
  /**
   * The shortest gap between two notices to a window. An invalidation inside the gap is held and
   * leaves as one trailing notice when it ends, so a streamed answer costs at most one notice per
   * window per gap rather than one per event batch. 200 ms is a choice, not a measurement.
   */
  intervalMs?: number
}

export interface ThreadInvalidations {
  /**
   * Feed it every broadcast `(channel, payload)`. Returns whether the channel can change the list.
   * Never throws, so it is safe inside a broadcast listener.
   */
  observe(channel: string, payload?: unknown): boolean
  /** Invalidate without a channel: for structural handlers that broadcast nothing themselves. */
  notify(): void
  /** Send a held notice now. */
  flush(): void
  dispose(): void
}

export const THREAD_INVALIDATION_INTERVAL_MS = 200

export function createThreadInvalidations(deps: ThreadInvalidationDeps): ThreadInvalidations {
  const intervalMs = Math.max(0, deps.intervalMs ?? THREAD_INVALIDATION_INTERVAL_MS)
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const send = (): void => {
    let windows: readonly ThreadInvalidationWindow[] = []
    try { windows = deps.windows() } catch (error) { console.warn('Thread invalidation could not list windows', error) }
    for (const window of windows) {
      try {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue
        window.webContents.send(THREADS_CHANGED_CHANNEL)
      } catch (error) { console.warn('Thread invalidation could not reach a window', error) }
    }
  }
  const notify = (): void => {
    if (disposed || timer) return
    timer = setTimeout(() => { timer = null; if (!disposed) send() }, intervalMs)
  }
  return {
    observe(channel, payload) {
      if (!THREAD_INVALIDATING_CHANNELS.has(channel)) return false
      // An empty event batch changes nothing a row shows.
      if (channel === 'structured:events' && Array.isArray(payload) && payload.length === 0) return false
      notify()
      return true
    },
    notify,
    flush() {
      if (disposed || !timer) return
      clearTimeout(timer)
      timer = null
      send()
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
