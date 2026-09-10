import type { PaneTab, WorkspaceLayout } from '../../../shared/models'
import { activateTab, addTab, closeTab, findGroup, listGroups } from './layout-operations'
import { createPaneTab } from '../panes/pane-factory'

export interface BrowserTabToggle {
  layout: WorkspaceLayout
  focusedGroupId: string
  /** null asks the caller to clear a maximized group so the tab is actually visible; undefined
   *  leaves it untouched (closing never needs to touch it). */
  maximizedGroupId?: null
  closedTab?: PaneTab
}

/** True only when the workspace has a browser pane tab and it is the one showing - the same
 *  surface the browser MCP tools drive (they resolve a webview by matching its pane tab id,
 *  filtered to kind 'browser', via AgentControl.tabs). A tab that exists but sits behind
 *  another tab in its group does not count: the owner cannot see it either. */
export function browserTabOpen(layout: WorkspaceLayout): boolean {
  return listGroups(layout.root).some(group => group.tabs.some(tab => tab.kind === 'browser' && group.activeTabId === tab.id))
}

/** Shared by the composer's Browser button and the @browser mention: focus the workspace's
 *  browser pane tab if it exists but isn't showing, close it if it is already showing, or
 *  create one in the focused group if the workspace has none. Creating or focusing a tab in a
 *  different group than a maximized one would otherwise hide it, so both ask to clear
 *  maximizedGroupId. */
export function toggleBrowserTab(layout: WorkspaceLayout, focusedGroupId: string): BrowserTabToggle {
  for (const group of listGroups(layout.root)) {
    const tab = group.tabs.find(item => item.kind === 'browser')
    if (!tab) continue
    if (group.activeTabId === tab.id) {
      const result = closeTab(layout, group.id, tab.id)
      return { layout: result.layout, focusedGroupId, closedTab: result.closed ?? undefined }
    }
    return { layout: activateTab(layout, group.id, tab.id), focusedGroupId: group.id, maximizedGroupId: null }
  }
  const group = findGroup(layout.root, focusedGroupId) ?? listGroups(layout.root)[0]
  if (!group) return { layout, focusedGroupId }
  return { layout: addTab(layout, group.id, createPaneTab('browser')), focusedGroupId: group.id, maximizedGroupId: null }
}
