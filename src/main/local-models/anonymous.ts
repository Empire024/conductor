import type { LayoutNode, PaneTab, WorkspaceLayout } from '../../shared/models'

/**
 * Anonymous local conversations (local-anonymous-mode). The owner chose, when the tab opened,
 * that nothing of this conversation outlives it: no database row, journal entry, memory, briefing,
 * log line or restart record carries its prompts, answers, tool calls, title or usage. It lives in
 * this process's memory and is gone for good when its tab closes or Conductor exits; files the
 * model wrote in the workspace stay, because those are the owner's files, not the conversation.
 *
 * This registry is the one place every durable sink asks. It is process memory on purpose: after
 * a restart it is empty, so nothing is restored and nothing needs cleaning up.
 */
const ids = new Set<string>()
/** Ids a layout has shown at least once. A conversation is registered a moment before its tab
 *  reaches any layout, so only one that was seen and is now gone counts as closed. */
const seen = new Set<string>()
const forgetListeners = new Set<(id: string) => void>()

export const anonymousConversations = {
  mark(id: string): void { ids.add(id) },
  has(id: string | null | undefined): boolean { return Boolean(id) && ids.has(id!) },
  /** Whether a durable key (a setting, a journal key) names an anonymous conversation. Keys are
   *  built as prefix + id or embed the id in JSON, so containment is the test; ids are opaque
   *  random tokens, so one never occurs inside another by accident. */
  ownsKey(key: string): boolean {
    for (const id of ids) if (key.includes(id)) return true
    return false
  },
  /** Called when the tab closes: every in-memory holder drops what it kept for this id. */
  forget(id: string): void {
    seen.delete(id)
    if (!ids.delete(id)) return
    for (const listener of forgetListeners) { try { listener(id) } catch { /* one holder never blocks the others */ } }
  },
  onForget(listener: (id: string) => void): () => void {
    forgetListeners.add(listener)
    return () => { forgetListeners.delete(listener) }
  },
  size(): number { return ids.size },
  /** Given every agent tab id the open layouts hold now, the anonymous conversations whose tab
   *  has closed: the caller stops their runtimes and forgets them. */
  closed(present: ReadonlySet<string>): string[] {
    const gone: string[] = []
    for (const id of ids) {
      if (present.has(id)) seen.add(id)
      else if (seen.has(id)) gone.push(id)
    }
    return gone
  },
  /** Test hook: forget every conversation without notifying holders. */
  clearForTests(): void { ids.clear(); seen.clear() }
}

/** A tab opened in anonymous mode carries the mark in its own state, so the renderer can show it
 *  and every layout write can leave it out. */
export const isAnonymousTab = (tab: Pick<PaneTab, 'state' | 'resourceId'> | null | undefined): boolean =>
  Boolean(tab && (tab.state?.anonymous === true || anonymousConversations.has(tab.resourceId)))

const stripNode = (node: LayoutNode): { node: LayoutNode; removed: boolean } => {
  if (node.type === 'split') {
    const left = stripNode(node.children[0]), right = stripNode(node.children[1])
    return left.removed || right.removed ? { node: { ...node, children: [left.node, right.node] }, removed: true } : { node, removed: false }
  }
  const tabs = node.tabs.filter(tab => !isAnonymousTab(tab))
  if (tabs.length === node.tabs.length) return { node, removed: false }
  // A group left empty keeps a launcher, the same thing closing its last tab leaves behind.
  const kept = tabs.length ? tabs : [{ id: node.id + '-launcher', kind: 'launcher' as PaneTab['kind'], title: 'New tab' }]
  const activeTabId = kept.some(tab => tab.id === node.activeTabId) ? node.activeTabId : kept.at(-1)!.id
  return { node: { ...node, tabs: kept, activeTabId }, removed: true }
}

/** The layout as it may be written to disk: every anonymous tab left out. `removed` says whether
 *  there was one, so a caller keeps the full layout in memory only when it differs. */
export function persistableLayout(layout: WorkspaceLayout): { layout: WorkspaceLayout; removed: boolean } {
  const stripped = stripNode(layout.root)
  return stripped.removed ? { layout: { ...layout, root: stripped.node }, removed: true } : { layout, removed: false }
}

/** Closed-tab history is for reopening; an anonymous conversation cannot be reopened. */
export const persistableClosedTabs = (tabs: PaneTab[]): PaneTab[] => tabs.filter(tab => !isAnonymousTab(tab))

/** Every agent tab id in these layouts. */
export function agentTabIds(layouts: WorkspaceLayout[]): Set<string> {
  const found = new Set<string>()
  const visit = (node: LayoutNode): void => {
    if (node.type === 'split') { node.children.forEach(visit); return }
    for (const tab of node.tabs) if (tab.kind === 'agent' && tab.resourceId) found.add(tab.resourceId)
  }
  layouts.forEach(layout => visit(layout.root))
  return found
}
