import type { PaneTab, SessionRecord, WorkspaceLayout } from '../../../shared/models'
import { CLOSED_TABS_LIMIT } from '../../../shared/tab-archive'
import { activateTab, addTab, closeTab, dockTabsBeside, findGroup, groupTabs, listGroups, moveTabToGroup, reorderTab, splitGroup, type DockEdge, type TabDropTarget } from './layout-operations'

/**
 * Selecting tabs like files in Windows Explorer (feature-list 4538163d), in the tab strip and in
 * the sidebar's workspace list: a click selects one, Ctrl+click toggles one, Shift+click selects the
 * range from the anchor, Ctrl+Shift+click adds that range, Ctrl+A selects all, Esc clears. As in a
 * browser's tab strip the active tab counts as selected, so Ctrl+click on a second tab selects two.
 * A selection of two or more is what the bulk actions act on.
 */
export interface TabSelection {
  ids: ReadonlySet<string>
  /** Where a Shift+click range starts. */
  anchor: string | null
}

export const EMPTY_SELECTION: TabSelection = { ids: new Set(), anchor: null }

export interface SelectionModifiers { ctrl: boolean; shift: boolean }

/** A click with modifiers on `clicked`, over the tabs in `order` (the order they are listed in). */
export function selectionClick(order: readonly string[], current: TabSelection, clicked: string, active: string | null, modifiers: SelectionModifiers): TabSelection {
  if (!modifiers.ctrl && !modifiers.shift) return { ids: new Set([clicked]), anchor: clicked }
  // The tab on screen is the implicit selection a first Ctrl/Shift+click extends.
  const seeded = current.ids.size ? current : active && order.includes(active) ? { ids: new Set([active]), anchor: active } : EMPTY_SELECTION
  if (modifiers.shift) {
    const anchor = seeded.anchor && order.includes(seeded.anchor) ? seeded.anchor : clicked
    const from = order.indexOf(anchor), to = order.indexOf(clicked)
    const range = from < 0 || to < 0 ? [clicked] : order.slice(Math.min(from, to), Math.max(from, to) + 1)
    return { ids: new Set(modifiers.ctrl ? [...seeded.ids, ...range] : range), anchor }
  }
  const ids = new Set(seeded.ids)
  if (ids.has(clicked)) ids.delete(clicked)
  else ids.add(clicked)
  return { ids, anchor: clicked }
}

export const selectAll = (order: readonly string[]): TabSelection => ({ ids: new Set(order), anchor: order[0] ?? null })

/** The selection limited to tabs that still exist, in `order`; the same object when nothing went. */
export function pruneSelection(selection: TabSelection, order: readonly string[]): TabSelection {
  if (!selection.ids.size) return selection
  const present = new Set(order)
  if ([...selection.ids].every(id => present.has(id))) return selection
  const ids = new Set([...selection.ids].filter(id => present.has(id)))
  return { ids, anchor: selection.anchor && present.has(selection.anchor) ? selection.anchor : null }
}

/** The selected ids in list order; only a selection of two or more is a bulk selection. */
export const orderedSelection = (selection: TabSelection, order: readonly string[]): string[] => order.filter(id => selection.ids.has(id))
export const isBulk = (selection: TabSelection): boolean => selection.ids.size > 1

export interface PlacedTab { groupId: string; tabId: string }

/** Where every selected tab is, pane by pane, in layout order. */
export function placeTabs(layout: WorkspaceLayout, tabIds: readonly string[]): PlacedTab[] {
  const wanted = new Set(tabIds)
  return listGroups(layout.root).flatMap(group => group.tabs.filter(tab => wanted.has(tab.id)).map(tab => ({ groupId: group.id, tabId: tab.id })))
}

const groupOf = (layout: WorkspaceLayout, tabId: string): string | undefined => listGroups(layout.root).find(group => group.tabs.some(tab => tab.id === tabId))?.id

/**
 * Moves these tabs (in layout order) into a pane's strip in front of the first unselected tab at or
 * after `index`, which is counted the way a single-tab drop counts it: with `draggedTabId` lifted
 * out. They keep their relative order; crossing panes, the dragged one becomes active there.
 */
export function moveTabsToBar(layout: WorkspaceLayout, tabIds: readonly string[], targetGroupId: string, index: number, draggedTabId?: string): WorkspaceLayout {
  const target = findGroup(layout.root, targetGroupId)
  if (!target) return layout
  const moving = new Set(tabIds)
  const anchor = target.tabs.filter(tab => tab.id !== draggedTabId).slice(Math.max(0, index)).find(tab => !moving.has(tab.id))?.id ?? null
  let next = layout
  for (const { tabId } of placeTabs(layout, tabIds)) {
    const source = groupOf(next, tabId)
    const pane = findGroup(next.root, targetGroupId)
    if (!source || !pane) continue
    if (source === targetGroupId) {
      const lifted = pane.tabs.filter(tab => tab.id !== tabId)
      const at = anchor ? lifted.findIndex(tab => tab.id === anchor) : lifted.length
      next = reorderTab(next, targetGroupId, tabId, at < 0 ? lifted.length : at)
    } else {
      const at = anchor ? pane.tabs.findIndex(tab => tab.id === anchor) : pane.tabs.length
      next = moveTabToGroup(next, source, tabId, targetGroupId, at < 0 ? pane.tabs.length : at)
    }
  }
  if (draggedTabId && groupOf(next, draggedTabId) === targetGroupId && groupOf(layout, draggedTabId) !== targetGroupId) next = activateTab(next, targetGroupId, draggedTabId)
  return next
}

/** Gathers the tabs into one pane first (the pane of the first of them), then peels them off
 *  `targetGroupId`'s edge into a pane of their own. Unchanged when that would empty the pane it
 *  splits (every tab of the only pane is selected). */
export function dockTabsAt(layout: WorkspaceLayout, tabIds: readonly string[], targetGroupId: string, edge: Exclude<DockEdge, 'center'>): WorkspaceLayout {
  const placed = placeTabs(layout, tabIds)
  if (!placed.length) return layout
  const home = placed[0]!.groupId
  const gathered = moveTabsToBar(layout, tabIds, home, Number.MAX_SAFE_INTEGER)
  const pane = findGroup(gathered.root, home)
  if (!pane) return layout
  const moving = new Set(tabIds)
  // The target must keep at least one tab of its own, or there is nothing left to split beside.
  const target = findGroup(gathered.root, targetGroupId)
  if (!target || target.tabs.every(tab => moving.has(tab.id))) return layout
  return dockTabsBeside(gathered, home, placed.map(item => item.tabId), targetGroupId, edge)
}

/** Several tabs dragged in from another window, landing together on a strip index or a pane edge. */
export function insertForeignTabs(layout: WorkspaceLayout, tabs: readonly PaneTab[], target: TabDropTarget): WorkspaceLayout {
  const present = new Set(listGroups(layout.root).flatMap(group => group.tabs.map(tab => tab.id)))
  const arriving = tabs.filter(tab => !present.has(tab.id))
  if (!arriving.length) return layout
  if (target.kind === 'bar') return arriving.reduce((next, tab, index) => addTab(next, target.groupId, tab, target.index + index), layout)
  const [first, ...rest] = arriving
  let next = splitGroup(layout, target.groupId, target.edge, first!)
  const created = groupOf(next, first!.id)
  if (created) for (const tab of rest) next = addTab(next, created, tab)
  return created ? activateTab(next, created, first!.id) : next
}

export type BulkTabAction =
  | { kind: 'close' }
  | { kind: 'move'; groupId: string }
  | { kind: 'split'; edge: Exclude<DockEdge, 'center'> }
  | { kind: 'new-tab-group' }
  | { kind: 'detach' }

/**
 * A bulk action over a workspace. 'close' and 'detach' take the tabs out of the layout and return
 * them in `removed` (closed ones also join the reopen list; the caller archives them and opens
 * the detached window); the others only rearrange.
 */
export function applyBulkTabAction(session: SessionRecord, tabIds: readonly string[], action: BulkTabAction): { session: SessionRecord; removed: PaneTab[]; focusedGroupId?: string } {
  const placed = placeTabs(session.layout, tabIds)
  if (!placed.length) return { session, removed: [] }
  let layout = session.layout
  const removed: PaneTab[] = []
  if (action.kind === 'close' || action.kind === 'detach') {
    for (const { groupId, tabId } of placed) {
      const result = closeTab(layout, groupOf(layout, tabId) ?? groupId, tabId)
      layout = result.layout
      if (result.closed) removed.push(result.closed)
    }
    const closedTabs = action.kind === 'close' ? [...session.closedTabs, ...removed].slice(-CLOSED_TABS_LIMIT) : session.closedTabs
    const maximizedGroupId = session.maximizedGroupId && findGroup(layout.root, session.maximizedGroupId) ? session.maximizedGroupId : null
    return { session: { ...session, layout, closedTabs, maximizedGroupId }, removed, focusedGroupId: listGroups(layout.root)[0]?.id }
  }
  if (action.kind === 'move') {
    layout = moveTabsToBar(layout, tabIds, action.groupId, Number.MAX_SAFE_INTEGER)
    const last = placed.at(-1)!.tabId
    if (groupOf(layout, last) === action.groupId) layout = activateTab(layout, action.groupId, last)
    return { session: { ...session, layout }, removed, focusedGroupId: action.groupId }
  }
  if (action.kind === 'split') {
    const home = placed[0]!.groupId
    layout = dockTabsAt(layout, tabIds, home, action.edge)
    return { session: { ...session, layout, maximizedGroupId: null }, removed, focusedGroupId: groupOf(layout, placed[0]!.tabId) }
  }
  const home = placed[0]!.groupId
  // Tabs already in one pane stay where they are; a tab group gathers them itself.
  if (placed.some(item => item.groupId !== home)) layout = moveTabsToBar(layout, tabIds, home, Number.MAX_SAFE_INTEGER)
  layout = groupTabs(layout, home, placed.map(item => item.tabId), { title: '' }).layout
  return { session: { ...session, layout }, removed, focusedGroupId: home }
}
