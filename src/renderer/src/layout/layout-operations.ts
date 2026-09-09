import type { LayoutNode, PaneGroupNode, PaneTab, TabGroup, WorkspaceLayout } from '../../../shared/models'
import { makeId, makeLauncherTab } from '../../../shared/models'
import type { CanvasEdge } from './tab-drag'
import {
  createTabGroup,
  expandGroupContaining,
  groupIdAtInsertion,
  normalizeTabGroups,
  setTabGroupCollapsed,
  setTabsGroup,
  tabGroupsOf,
  tabsInGroup,
  updateTabGroup
} from './tab-groups'

export type DockEdge = 'left' | 'right' | 'above' | 'below' | 'center'

const mapNode = (
  node: LayoutNode,
  predicate: (node: LayoutNode) => boolean,
  mapper: (node: LayoutNode) => LayoutNode
): LayoutNode => {
  if (predicate(node)) return mapper(node)
  if (node.type === 'group') return node
  return {
    ...node,
    children: [
      mapNode(node.children[0], predicate, mapper),
      mapNode(node.children[1], predicate, mapper)
    ]
  }
}

export const findGroup = (node: LayoutNode, groupId: string): PaneGroupNode | null => {
  if (node.type === 'group') return node.id === groupId ? node : null
  return findGroup(node.children[0], groupId) ?? findGroup(node.children[1], groupId)
}

export const listGroups = (node: LayoutNode): PaneGroupNode[] => {
  if (node.type === 'group') return [node]
  return [...listGroups(node.children[0]), ...listGroups(node.children[1])]
}

export const updateGroup = (
  layout: WorkspaceLayout,
  groupId: string,
  update: (group: PaneGroupNode) => PaneGroupNode
): WorkspaceLayout => ({
  ...layout,
  root: mapNode(layout.root, (node) => node.type === 'group' && node.id === groupId, (node) =>
    update(node as PaneGroupNode)
  )
})

export const activateTab = (
  layout: WorkspaceLayout,
  groupId: string,
  tabId: string
): WorkspaceLayout =>
  updateGroup(layout, groupId, (group) =>
    group.tabs.some((tab) => tab.id === tabId)
      ? { ...expandGroupContaining(group, tabId), activeTabId: tabId }
      : group
  )

export const replaceTab = (
  layout: WorkspaceLayout,
  groupId: string,
  oldTabId: string,
  newTab: PaneTab
): WorkspaceLayout =>
  updateGroup(layout, groupId, (group) => ({
    ...group,
    tabs: group.tabs.map((tab) => (tab.id === oldTabId ? newTab : tab)),
    activeTabId: group.activeTabId === oldTabId ? newTab.id : group.activeTabId
  }))

export const updateTab = (
  layout: WorkspaceLayout,
  groupId: string,
  tabId: string,
  update: (tab: PaneTab) => PaneTab
): WorkspaceLayout =>
  updateGroup(layout, groupId, (group) => ({
    ...group,
    tabs: group.tabs.map((tab) => tab.id === tabId ? update(tab) : tab)
  }))

export const addTab = (
  layout: WorkspaceLayout,
  groupId: string,
  tab: PaneTab,
  index?: number
): WorkspaceLayout =>
  updateGroup(layout, groupId, (group) => {
    const at = index === undefined || index >= group.tabs.length ? group.tabs.length : Math.max(0, index)
    const placed = { ...tab, tabGroupId: groupIdAtInsertion(group.tabs, at, tab.tabGroupId) }
    return normalizeTabGroups({
      ...group,
      tabs: [...group.tabs.slice(0, at), placed, ...group.tabs.slice(at)],
      activeTabId: placed.id
    })
  })

/** Chrome-style same-bar reorder: `toIndex` is where the tab lands among its siblings
 * once it has been lifted out (see tab-drag.ts's gapAnchorId/tabInsertionIndex, which
 * already compute indices with the dragged tab excluded). Leaves activation untouched. */
export const reorderTab = (
  layout: WorkspaceLayout,
  groupId: string,
  tabId: string,
  toIndex: number
): WorkspaceLayout =>
  updateGroup(layout, groupId, (group) => {
    const from = group.tabs.findIndex((tab) => tab.id === tabId)
    if (from === -1) return group
    const tabs = group.tabs.slice()
    const [moved] = tabs.splice(from, 1)
    const at = Math.max(0, Math.min(toIndex, tabs.length))
    tabs.splice(at, 0, { ...moved!, tabGroupId: groupIdAtInsertion(tabs, at, moved!.tabGroupId) })
    return normalizeTabGroups({ ...group, tabs })
  })

export const splitGroup = (
  layout: WorkspaceLayout,
  groupId: string,
  edge: Exclude<DockEdge, 'center'>,
  tab: PaneTab = makeLauncherTab()
): WorkspaceLayout => {
  const target = findGroup(layout.root, groupId)
  if (!target) return layout
  // Groups are pane-local, so a tab peeling into a pane of its own leaves its group behind.
  const newGroup: PaneGroupNode = {
    type: 'group',
    id: makeId('group'),
    tabs: [{ ...tab, tabGroupId: undefined }],
    activeTabId: tab.id
  }
  const before = edge === 'left' || edge === 'above'
  const direction = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical'
  return {
    ...layout,
    root: mapNode(layout.root, (node) => node.type === 'group' && node.id === groupId, (node) => ({
      type: 'split',
      id: makeId('split'),
      direction,
      children: before
        ? [newGroup, node as PaneGroupNode]
        : [node as PaneGroupNode, newGroup],
      sizes: [50, 50]
    }))
  }
}

interface RemovalResult {
  node: LayoutNode | null
  tab: PaneTab | null
}

const removeFromNode = (node: LayoutNode, groupId: string, tabId: string): RemovalResult => {
  if (node.type === 'group') {
    if (node.id !== groupId) return { node, tab: null }
    const tab = node.tabs.find((item) => item.id === tabId) ?? null
    if (!tab) return { node, tab: null }
    const tabs = node.tabs.filter((item) => item.id !== tabId)
    if (tabs.length === 0) return { node: null, tab }
    const activeTabId =
      node.activeTabId === tabId
        ? tabs[Math.max(0, node.tabs.indexOf(tab) - 1)]!.id
        : node.activeTabId
    // Normalizing drops a group record whose last tab just left; expanding covers the case
    // where the tab that inherits activation is itself hidden inside a collapsed group.
    const pruned = normalizeTabGroups({ ...node, tabs, activeTabId })
    return { node: expandGroupContaining(pruned, activeTabId), tab }
  }

  const left = removeFromNode(node.children[0], groupId, tabId)
  if (left.tab) {
    if (!left.node) return { node: node.children[1], tab: left.tab }
    return { node: { ...node, children: [left.node, node.children[1]] }, tab: left.tab }
  }
  const right = removeFromNode(node.children[1], groupId, tabId)
  if (right.tab) {
    if (!right.node) return { node: node.children[0], tab: right.tab }
    return { node: { ...node, children: [node.children[0], right.node] }, tab: right.tab }
  }
  return { node, tab: null }
}

export const closeTab = (
  layout: WorkspaceLayout,
  groupId: string,
  tabId: string
): { layout: WorkspaceLayout; closed: PaneTab | null } => {
  const removal = removeFromNode(layout.root, groupId, tabId)
  if (!removal.tab) return { layout, closed: null }
  if (removal.node) return { layout: { ...layout, root: removal.node }, closed: removal.tab }

  return {
    layout: {
      ...layout,
      root: { type: 'group', id: (layout.root.type === 'group' ? layout.root.id : makeId('group')), tabs: [], activeTabId: '' }
    },
    closed: removal.tab
  }
}

/** Runtime tab groups are intentionally limited to agents, shells, and the
 * runtime launcher. Files, editors, browsers, memory, and automation live in
 * workspace chrome so their lifecycles cannot be confused with PTY sessions. */
export const stripWorkspaceUtilityTabs = (layout: WorkspaceLayout): WorkspaceLayout => {
  let next = layout
  const utilityTabs = listGroups(layout.root).flatMap((group) =>
    group.tabs
      .filter((tab) => !['launcher', 'agent', 'terminal'].includes(tab.kind))
      .map((tab) => ({ groupId: group.id, tabId: tab.id }))
  )
  for (const utility of utilityTabs) {
    next = closeTab(next, utility.groupId, utility.tabId).layout
  }
  return next
}

export const dockTab = (
  layout: WorkspaceLayout,
  sourceGroupId: string,
  tabId: string,
  targetGroupId: string,
  edge: DockEdge
): WorkspaceLayout => {
  const source = findGroup(layout.root, sourceGroupId)
  const target = findGroup(layout.root, targetGroupId)
  const tab = source?.tabs.find((item) => item.id === tabId)
  if (!source || !target || !tab) return layout

  if (edge === 'center' && sourceGroupId === targetGroupId) {
    return activateTab(layout, targetGroupId, tabId)
  }
  if (edge !== 'center' && sourceGroupId === targetGroupId && source.tabs.length === 1) return layout

  const removal = removeFromNode(layout.root, sourceGroupId, tabId)
  if (!removal.node || !removal.tab) return layout
  const withoutSource: WorkspaceLayout = { ...layout, root: removal.node }

  if (edge === 'center') return addTab(withoutSource, targetGroupId, removal.tab)
  return splitGroup(withoutSource, targetGroupId, edge, removal.tab)
}

/** Moves a tab into a specific slot of `targetGroupId`, reordering in place when the
 * target is the tab's own group and relocating (collapsing the source, same as dockTab)
 * otherwise. The tab becomes active in whichever group it ends up in when it crosses groups. */
export const moveTabToGroup = (
  layout: WorkspaceLayout,
  sourceGroupId: string,
  tabId: string,
  targetGroupId: string,
  toIndex: number
): WorkspaceLayout => {
  if (sourceGroupId === targetGroupId) return reorderTab(layout, sourceGroupId, tabId, toIndex)
  const removal = removeFromNode(layout.root, sourceGroupId, tabId)
  if (!removal.node || !removal.tab) return layout
  return addTab({ ...layout, root: removal.node }, targetGroupId, removal.tab, toIndex)
}

export type TabDropTarget =
  | { kind: 'bar'; groupId: string; index: number }
  | { kind: 'canvas'; groupId: string; edge: CanvasEdge }

/** What dropping a dragged tab on `target` does to the layout: joining a tab bar at an
 * index (reorder or move-in), or peeling it into its own pane when dropped away from any
 * tab bar. The single entry point PaneWorkspace's drag handling commits through. */
export const applyTabDrop = (
  layout: WorkspaceLayout,
  sourceGroupId: string,
  tabId: string,
  target: TabDropTarget
): WorkspaceLayout =>
  target.kind === 'bar'
    ? moveTabToGroup(layout, sourceGroupId, tabId, target.groupId, target.index)
    : dockTab(layout, sourceGroupId, tabId, target.groupId, target.edge)

/** Whether `target` would actually move the tab. A pane's last tab cannot peel off the pane
 * it already fills, so the drag preview asks this before squeezing that pane open for an
 * edge it will then refuse - the indicator only ever promises a drop that really happens. */
export const tabDropLands = (
  layout: WorkspaceLayout,
  sourceGroupId: string,
  tabId: string,
  target: TabDropTarget
): boolean =>
  target.kind === 'bar' || applyTabDrop(layout, sourceGroupId, tabId, target) !== layout

export const duplicateTab = (tab: PaneTab): PaneTab => ({
  ...tab,
  id: makeId('pane'),
  resourceId:
    tab.kind === 'terminal' || tab.kind === 'agent' ? makeId(tab.kind) : tab.resourceId,
  title: `${tab.title} copy`,
  state: tab.state ? { ...tab.state } : undefined
})

export const resizeSplit = (
  layout: WorkspaceLayout,
  splitId: string,
  sizes: [number, number]
): WorkspaceLayout => ({
  ...layout,
  root: mapNode(layout.root, (node) => node.type === 'split' && node.id === splitId, (node) => ({
    ...node,
    sizes
  }))
})

export const instantiateLayout = (layout: WorkspaceLayout): WorkspaceLayout => {
  const instantiateNode = (node: LayoutNode): LayoutNode => {
    if (node.type === 'split') {
      return {
        ...node,
        id: makeId('split'),
        children: [instantiateNode(node.children[0]), instantiateNode(node.children[1])]
      }
    }
    // A template's groups are copied, not shared: fresh ids, remapped onto the fresh tabs.
    const groupIds = new Map(tabGroupsOf(node).map((group) => [group.id, makeId('tabgroup')]))
    const tabs = node.tabs.map((tab) => ({
      ...tab,
      id: makeId('pane'),
      resourceId:
        tab.kind === 'terminal' || tab.kind === 'agent' ? makeId(tab.kind) : tab.resourceId,
      state: tab.state ? { ...tab.state } : undefined,
      tabGroupId: tab.tabGroupId ? groupIds.get(tab.tabGroupId) : undefined
    }))
    const instantiated: PaneGroupNode = {
      ...node,
      id: makeId('group'),
      tabs,
      activeTabId: tabs[Math.max(0, node.tabs.findIndex((tab) => tab.id === node.activeTabId))]?.id ?? tabs[0]?.id ?? ''
    }
    if (groupIds.size) {
      instantiated.tabGroups = tabGroupsOf(node).map((group) => ({ ...group, id: groupIds.get(group.id)! }))
    }
    return normalizeTabGroups(instantiated)
  }
  return { version: 1, root: instantiateNode(layout.root) }
}


/** Layout-level entry points for the pane-local group operations in tab-groups.ts, so callers
 * only ever hold a workspace layout and a pane id. */

export const groupTabs = (
  layout: WorkspaceLayout,
  paneId: string,
  tabIds: string[],
  init?: Partial<Omit<TabGroup, 'id'>>
): { layout: WorkspaceLayout; tabGroupId: string } => {
  let tabGroupId = ''
  const next = updateGroup(layout, paneId, (pane) => {
    const created = createTabGroup(pane, tabIds, init)
    tabGroupId = created.tabGroupId
    return created.pane
  })
  return { layout: next, tabGroupId }
}

/** Moves tabs into an existing group, or out of any group when `tabGroupId` is null. */
export const assignTabsToGroup = (
  layout: WorkspaceLayout,
  paneId: string,
  tabIds: string[],
  tabGroupId: string | null
): WorkspaceLayout => updateGroup(layout, paneId, (pane) => setTabsGroup(pane, tabIds, tabGroupId))

export const editTabGroup = (
  layout: WorkspaceLayout,
  paneId: string,
  tabGroupId: string,
  patch: Partial<Omit<TabGroup, 'id'>>
): WorkspaceLayout => updateGroup(layout, paneId, (pane) => updateTabGroup(pane, tabGroupId, patch))

export const collapseTabGroup = (
  layout: WorkspaceLayout,
  paneId: string,
  tabGroupId: string,
  collapsed: boolean
): WorkspaceLayout =>
  updateGroup(layout, paneId, (pane) => setTabGroupCollapsed(pane, tabGroupId, collapsed))

/** Chrome's "Ungroup": the tabs stay open and keep their places, the group itself disappears. */
export const ungroupTabGroup = (
  layout: WorkspaceLayout,
  paneId: string,
  tabGroupId: string
): WorkspaceLayout =>
  updateGroup(layout, paneId, (pane) =>
    setTabsGroup(pane, tabsInGroup(pane, tabGroupId).map((tab) => tab.id), null)
  )

/** Chrome's "Close group": every tab in it closes, and the closed tabs come back so they can
 * join the reopen stack like any other closed tab. */
export const closeTabGroup = (
  layout: WorkspaceLayout,
  paneId: string,
  tabGroupId: string
): { layout: WorkspaceLayout; closed: PaneTab[] } => {
  const pane = findGroup(layout.root, paneId)
  if (!pane) return { layout, closed: [] }
  let next = layout
  const closed: PaneTab[] = []
  for (const tab of tabsInGroup(pane, tabGroupId)) {
    const result = closeTab(next, paneId, tab.id)
    next = result.layout
    if (result.closed) closed.push(result.closed)
  }
  return { layout: next, closed }
}
