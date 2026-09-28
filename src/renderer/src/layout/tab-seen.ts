import type { LayoutNode, WorkspaceLayout } from '../../../shared/models'
import { TAB_PINNED_KEY, TAB_SEEN_KEY, tabPinned } from '../../../shared/workspace-clarity'
import { updateGroup } from './layout-operations'
import { normalizeTabGroups } from './tab-groups'

const mapTabs = (node: LayoutNode, ids: ReadonlySet<string>, update: (tab: Extract<LayoutNode, { type: 'group' }>['tabs'][number]) => typeof tab): LayoutNode => {
  if (node.type === 'split') {
    const first = mapTabs(node.children[0], ids, update), second = mapTabs(node.children[1], ids, update)
    return first === node.children[0] && second === node.children[1] ? node : { ...node, children: [first, second] }
  }
  if (!node.tabs.some(tab => ids.has(tab.id))) return node
  return { ...node, tabs: node.tabs.map(tab => ids.has(tab.id) ? update(tab) : tab) }
}

/**
 * The owner had these agent tabs in front of them now (workspace clarity): a finished tab seen
 * after it finished stays in the strip. The tab being left is stamped too, since it was on screen
 * until this moment. Other tab kinds are never hidden, so they carry no stamp.
 */
export function markTabsSeen(layout: WorkspaceLayout, tabIds: readonly (string | undefined)[], now = Date.now()): WorkspaceLayout {
  const ids = new Set(tabIds.filter((id): id is string => Boolean(id)))
  if (!ids.size) return layout
  const stamp = new Date(now).toISOString()
  const root = mapTabs(layout.root, ids, tab => tab.kind === 'agent' ? { ...tab, state: { ...tab.state, [TAB_SEEN_KEY]: stamp } } : tab)
  return root === layout.root ? layout : { ...layout, root }
}

/** The MAIN leads its pane's strip (workspace clarity); a tab group it sits in moves with it. */
export function moveTabToFront(layout: WorkspaceLayout, groupId: string, tabId: string): WorkspaceLayout {
  return updateGroup(layout, groupId, group => {
    const index = group.tabs.findIndex(tab => tab.id === tabId)
    if (index <= 0) return group
    return normalizeTabGroups({ ...group, tabs: [group.tabs[index]!, ...group.tabs.slice(0, index), ...group.tabs.slice(index + 1)] })
  })
}

/** A pinned tab stays in the strip and is never closed as finished. */
export function togglePinned(layout: WorkspaceLayout, tabId: string): WorkspaceLayout {
  const root = mapTabs(layout.root, new Set([tabId]), tab => {
    const state = { ...tab.state }
    if (tabPinned(tab)) delete state[TAB_PINNED_KEY]; else state[TAB_PINNED_KEY] = true
    return { ...tab, state }
  })
  return { ...layout, root }
}
