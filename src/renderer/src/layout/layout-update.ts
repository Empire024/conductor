import type { PaneTab, WorkspaceLayout } from '../../../shared/models'
import { findGroup, listGroups, updateGroup, updateTab } from './layout-operations'

export type LayoutUpdate = WorkspaceLayout | ((latest: WorkspaceLayout) => WorkspaceLayout)

export function applyLayoutUpdate(latest: WorkspaceLayout, update: LayoutUpdate): WorkspaceLayout {
  return typeof update === 'function' ? update(latest) : update
}

export function patchTabState(groupId: string, tabId: string, patch: Record<string, unknown>): (layout: WorkspaceLayout) => WorkspaceLayout {
  return layout => {
    const tab = findGroup(layout.root, groupId)?.tabs.find(item => item.id === tabId)
    if (!tab || Object.entries(patch).every(([key, value]) => tab.state?.[key] === value)) return layout
    return updateTab(layout, groupId, tabId, item => ({ ...item, state: { ...item.state, ...patch } }))
  }
}

/** Merge a delayed save repair without undoing tabs, selection, or explicit closes made since. */
export function restoreTabs(latest: WorkspaceLayout, repairedLayout: WorkspaceLayout, restoredTabIds: string[], closedTabs: PaneTab[]): WorkspaceLayout {
  const restored = new Set(restoredTabIds)
  const groups = listGroups(latest.root)
  const present = new Set([...groups.flatMap(group => group.tabs.map(tab => tab.id)), ...closedTabs.map(tab => tab.id)])
  const resources = new Set(groups.flatMap(group => group.tabs.filter(tab => tab.kind === 'agent').map(tab => tab.resourceId)))
  for (const savedGroup of listGroups(repairedLayout.root)) for (const tab of savedGroup.tabs) {
    if (!restored.has(tab.id) || present.has(tab.id) || tab.kind === 'agent' && resources.has(tab.resourceId)) continue
    const target = findGroup(latest.root, savedGroup.id) ?? listGroups(latest.root)[0]
    if (!target) continue
    latest = updateGroup(latest, target.id, group => ({ ...group, tabs: [...group.tabs, tab], activeTabId: group.activeTabId || tab.id }))
    present.add(tab.id)
    if (tab.kind === 'agent') resources.add(tab.resourceId)
  }
  return latest
}
