import type { TimelineItem } from '../../../shared/structured-agent'

/** One matching message in the open conversation. A match is a message, not an occurrence: the
 *  position readout ("3 of 17") has to agree with what the timeline visibly highlights, and the
 *  highlight lands on the message card. `matches` still reports the occurrences inside it. */
export interface ConversationMatch { itemId: string; sequence: number; matches: number }
/** The renderer mirrors the store's rule (structured-store.ts searchableMessage): message text
 *  only, so a find never hits tool payloads, ids or provider internals. */
export function conversationMatches(items: TimelineItem[], query: string, limit = 1000): ConversationMatch[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  const found: ConversationMatch[] = []
  for (const item of items) {
    if (item.data.type !== 'text' || !item.data.text) continue
    const haystack = item.data.text.toLocaleLowerCase()
    let matches = 0
    for (let cursor = haystack.indexOf(needle); cursor !== -1; cursor = haystack.indexOf(needle, cursor + needle.length)) matches++
    if (!matches) continue
    found.push({ itemId: item.id, sequence: item.sequence, matches })
    if (found.length >= limit) break
  }
  return found
}

export interface FindState { open: boolean; query: string; index: number }
export const CLOSED_FIND: FindState = { open: false, query: '', index: 0 }
export type FindAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'query'; query: string }
  | { type: 'step'; direction: 1 | -1; count: number }
  | { type: 'select'; index: number; count: number }
const clampIndex = (index: number, count: number): number => count > 0 ? Math.min(Math.max(0, index), count - 1) : 0
/** Reopening keeps the previous needle (the owner usually wants the same search again); every
 *  query change restarts at the first match, and stepping wraps in both directions. */
export function findReducer(state: FindState, action: FindAction): FindState {
  switch (action.type) {
    case 'open': return state.open ? state : { ...state, open: true, index: 0 }
    case 'close': return state.open ? { ...state, open: false, index: 0 } : state
    case 'query': return action.query === state.query ? state : { ...state, query: action.query, index: 0 }
    case 'step': {
      if (action.count < 1) return state.index === 0 ? state : { ...state, index: 0 }
      return { ...state, index: (clampIndex(state.index, action.count) + action.direction + action.count) % action.count }
    }
    case 'select': {
      const index = clampIndex(action.index, action.count)
      return index === state.index ? state : { ...state, index }
    }
  }
}
export function findPositionLabel(count: number, index: number, query: string): string {
  if (!query.trim()) return ''
  return count ? `${clampIndex(index, count) + 1} of ${count}` : 'No matches'
}

/** Paint-only highlighting: ranges are handed to the CSS Custom Highlight API, so rendered
 *  markdown and code blocks are never rewritten and cannot be corrupted by find. A match is only
 *  collected inside a single text node, which also keeps it from spanning inline markup. */
export function collectQueryRanges(root: Element, query: string, limit = 500): Range[] {
  const needle = query.trim().toLocaleLowerCase()
  const doc = root.ownerDocument
  if (!needle || !doc) return []
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const ranges: Range[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLocaleLowerCase()
    for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) {
      const range = doc.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + needle.length)
      ranges.push(range)
      if (ranges.length >= limit) return ranges
    }
  }
  return ranges
}
interface HighlightRegistry { set(name: string, value: object): void; delete(name: string): void }
const registry = (): HighlightRegistry | null => {
  const api = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights
  return api && typeof (globalThis as { Highlight?: unknown }).Highlight === 'function' ? api : null
}
export const FIND_HIGHLIGHT = 'conductor-find', FIND_HIGHLIGHT_CURRENT = 'conductor-find-current'
/** `::highlight()` can only name a static highlight, but panes tile: two find bars open at once
 *  would otherwise overwrite each other's ranges, and the first pane to close would wipe the
 *  survivor's painting. So each pane owns an entry here and the two registry names always carry
 *  the union across every pane still painting. */
const painters = new Map<string, { all: Range[]; current: Range[] }>()
function repaint(): void {
  const highlights = registry()
  if (!highlights) return
  const Highlight = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => object }).Highlight
  const all: Range[] = [], current: Range[] = []
  for (const painted of painters.values()) { all.push(...painted.all); current.push(...painted.current) }
  if (all.length) highlights.set(FIND_HIGHLIGHT, new Highlight(...all)); else highlights.delete(FIND_HIGHLIGHT)
  if (current.length) highlights.set(FIND_HIGHLIGHT_CURRENT, new Highlight(...current)); else highlights.delete(FIND_HIGHLIGHT_CURRENT)
}
export function paintFindRanges(owner: string, all: Range[], current: Range[]): void {
  painters.set(owner, { all, current })
  repaint()
}
export function clearFindRanges(owner: string): void {
  if (!painters.delete(owner)) return
  repaint()
}
