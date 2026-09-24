import { useCallback, useEffect, useRef, useState } from 'react'
import type { TimelineItem } from '../../../shared/structured-agent'
import type { ConversationMatch } from './conversation-find'

/** `none`: the resident projection is the whole conversation. `idle`: older activity is on disk.
 *  `done`: every stored page is loaded. `unavailable`: loaded to the start of what is still stored,
 *  and older activity existed that the journal no longer keeps. */
export type OlderHistoryStatus = 'none' | 'idle' | 'loading' | 'done' | 'unavailable'
export interface OlderHistory {
  /** Oldest first, all older than the resident projection's first item. */
  items: TimelineItem[]
  status: OlderHistoryStatus
  /** Loads the next older page, or every page back to `until` (a timeline sequence). */
  load(until?: number): Promise<void>
}
const PAGE = 250, MAX_PAGES_PER_LOAD = 40

/** `covered` is the resident boundary the loaded pages reach up to. */
interface Loaded { sessionId: string; items: TimelineItem[]; status: OlderHistoryStatus; covered: number }
/**
 * Conversation activity older than the renderer's projection, paged in from the main process
 * (src/main/conversation-history.ts) only when the owner scrolls or searches back that far. The
 * projection holds the latest 2000 items; `truncated` says it dropped older ones, and `boundary`
 * is the sequence of its first item.
 */
export function useOlderHistory(sessionId: string, truncated: boolean, boundary: number | undefined): OlderHistory {
  const [loaded, setLoaded] = useState<Loaded>({ sessionId, items: [], status: 'idle', covered: 0 })
  const current = loaded.sessionId === sessionId ? loaded : { sessionId, items: [], status: 'idle' as const, covered: 0 }
  const latest = useRef({ loaded: current, boundary, loading: null as Promise<void> | null })
  latest.current.loaded = current
  latest.current.boundary = boundary
  useEffect(() => { latest.current.loading = null }, [sessionId])

  /** Pages from `before` back to `until` (or one page), oldest first. */
  const fetchPages = async (before: number, until?: number): Promise<{ items: TimelineItem[]; hasMore: boolean; unavailable: boolean }> => {
    const items: TimelineItem[] = []
    let hasMore = true, unavailable = false
    for (let page = 0; page < MAX_PAGES_PER_LOAD && hasMore; page++) {
      const next = await window.conductor.conversationHistory.page(sessionId, before, PAGE)
      items.unshift(...next.items)
      hasMore = next.hasMore
      unavailable = next.unavailable
      if (!next.items.length || until === undefined || next.items[0]!.sequence <= until) break
      before = next.items[0]!.sequence
    }
    return { items, hasMore, unavailable }
  }

  const load = useCallback((until?: number): Promise<void> => {
    const state = latest.current
    if (state.loading) return state.loading
    const { loaded: known, boundary: resident } = state
    if (known.status !== 'idle' || resident === undefined) return Promise.resolve()
    const before = known.items[0]?.sequence ?? resident
    setLoaded({ ...known, status: 'loading' })
    const task = fetchPages(before, until).then(page => {
      if (latest.current.loaded.sessionId !== sessionId) return
      setLoaded(previous => previous.sessionId !== sessionId ? previous : {
        sessionId,
        items: [...page.items, ...previous.items],
        covered: previous.items.length ? previous.covered : resident,
        status: page.hasMore ? 'idle' : page.unavailable ? 'unavailable' : 'done'
      })
    }).catch(() => {
      setLoaded(previous => previous.sessionId === sessionId ? { ...previous, status: 'idle' } : previous)
    }).finally(() => { if (latest.current.loading === task) latest.current.loading = null })
    state.loading = task
    return task
  }, [sessionId])

  // A running conversation keeps pushing its oldest resident items out of the projection. Once
  // older pages are loaded, those items would fall into a gap between the two, so the gap is
  // paged in behind them (the main process extends its rebuild instead of starting over).
  const newestOlder = current.items.at(-1)?.sequence
  const covered = current.covered
  useEffect(() => {
    if (boundary === undefined || newestOlder === undefined || !truncated || boundary <= covered) return
    const timer = window.setTimeout(() => {
      void fetchPages(boundary, newestOlder).then(page => {
        const gap = page.items.filter(item => item.sequence > newestOlder)
        setLoaded(previous => previous.sessionId === sessionId && previous.items.at(-1)?.sequence === newestOlder ? { ...previous, items: gap.length ? [...previous.items, ...gap] : previous.items, covered: boundary } : previous)
      }).catch(() => { /* The next boundary move retries; the loaded pages stay valid. */ })
    }, 600)
    return () => window.clearTimeout(timer)
  }, [boundary, covered, newestOlder, sessionId, truncated])

  return { items: current.items, status: truncated ? current.status : 'none', load }
}

/** In-chat find over the whole stored conversation: the store's hits in journal-only history
 *  that is not loaded yet come first (they are all older), then everything the renderer holds. */
export function withStoredMatches(stored: ConversationMatch[], loaded: ConversationMatch[], loadedIds: ReadonlySet<string>): ConversationMatch[] {
  const unloaded = stored.filter(hit => !loadedIds.has(hit.itemId))
  return unloaded.length ? [...unloaded, ...loaded] : loaded
}
