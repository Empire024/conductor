import type { LayoutNode, PaneGroupNode, PaneTab, WorkspaceLayout } from '../../../shared/models'
import { makeId, makeLauncherTab } from '../../../shared/models'

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
    group.tabs.some((tab) => tab.id === tabId) ? { ...group, activeTabId: tabId } : group
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
  tab: PaneTab
): WorkspaceLayout =>
  updateGroup(layout, groupId, (group) => ({
    ...group,
    tabs: [...group.tabs, tab],
    activeTabId: tab.id
  }))

export const splitGroup = (
  layout: WorkspaceLayout,
  groupId: string,
  edge: Exclude<DockEdge, 'center'>,
  tab: PaneTab = makeLauncherTab()
): WorkspaceLayout => {
  const target = findGroup(layout.root, groupId)
  if (!target) return layout
  const newGroup: PaneGroupNode = {
    type: 'group',
    id: makeId('group'),
    tabs: [tab],
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
    return { node: { ...node, tabs, activeTabId }, tab }
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
    const tabs = node.tabs.map((tab) => ({
      ...tab,
      id: makeId('pane'),
      resourceId:
        tab.kind === 'terminal' || tab.kind === 'agent' ? makeId(tab.kind) : tab.resourceId,
      state: tab.state ? { ...tab.state } : undefined
    }))
    return {
      ...node,
      id: makeId('group'),
      tabs,
      activeTabId: tabs[Math.max(0, node.tabs.findIndex((tab) => tab.id === node.activeTabId))]?.id ?? tabs[0]?.id ?? ''
    }
  }
  return { version: 1, root: instantiateNode(layout.root) }
}
