import { useSyncExternalStore } from 'react'

/**
 * Tabs an agent opened in the background that the owner has not looked at yet (FX21). The tab
 * strip shows them with a small "new" dot; the mark clears the first time the tab is active.
 * Kept in memory only: after a restart every tab is simply a tab again.
 */
let marked: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()
const emit = (): void => { for (const listener of listeners) listener() }

export function markNewTab(tabId: string): void {
  if (marked.has(tabId)) return
  marked = new Set(marked).add(tabId)
  emit()
}

export function clearNewTab(tabId: string): void {
  if (!marked.has(tabId)) return
  const next = new Set(marked)
  next.delete(tabId)
  marked = next
  emit()
}

export function newTabMarks(): ReadonlySet<string> { return marked }

export function useNewTabMarks(): ReadonlySet<string> {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, newTabMarks)
}
