import type { SessionRecord } from '../../../shared/models'
import { makeLauncherTab } from '../../../shared/models'
import { activateTab, addTab, assignTabsToGroup, closeTab, closeTabGroup, collapseTabGroup, duplicateTab, editTabGroup, findGroup, groupTabs, listGroups, splitGroup, ungroupTabGroup, updateTab } from './layout-operations'
import type { TabGroupAction } from './tab-groups'

export type WorkspaceTabAction = 'focus' | 'left' | 'right' | 'above' | 'below' | 'duplicate' | 'detach' | 'show' | 'maximize' | 'continuation' | 'reopen' | 'close'

/** Operates on the requested workspace, even when another workspace is active. */
export function applyWorkspaceTabAction(session: SessionRecord, groupId: string, tabId: string, action: WorkspaceTabAction): { session: SessionRecord; focusedGroupId: string } {
  const group = findGroup(session.layout.root, groupId)
  const tab = group?.tabs.find(item => item.id === tabId)
  if (!group || !tab) throw new Error('This tab is no longer in the workspace.')
  let layout = session.layout
  let closedTabs = session.closedTabs
  let maximizedGroupId = session.maximizedGroupId
  let focusedGroupId = groupId
  if (action === 'focus') { layout = activateTab(layout, groupId, tabId); maximizedGroupId = null }
  if (['left', 'right', 'above', 'below'].includes(action)) {
    const launcher = makeLauncherTab()
    layout = splitGroup(layout, groupId, action as 'left' | 'right' | 'above' | 'below', launcher)
    focusedGroupId = listGroups(layout.root).find(item => item.tabs.some(candidate => candidate.id === launcher.id))!.id
    maximizedGroupId = null
  }
  if (action === 'duplicate') layout = addTab(layout, groupId, duplicateTab(tab))
  if (action === 'close' || action === 'detach' || action === 'show') {
    layout = closeTab(layout, groupId, tabId).layout
    if (action === 'close') closedTabs = [...closedTabs, tab].slice(-20)
    if (!findGroup(layout.root, groupId)) { focusedGroupId = listGroups(layout.root)[0]?.id ?? ''; maximizedGroupId = null }
  }
  if (action === 'maximize') { layout = activateTab(layout, groupId, tabId); maximizedGroupId = maximizedGroupId === groupId ? null : groupId }
  if (action === 'continuation') layout = updateTab(layout, groupId, tabId, current => ({ ...current, state: { ...current.state, continueOnLimit: !(current.state?.continueOnLimit === undefined ? session.continueOnLimit : Boolean(current.state.continueOnLimit)) } }))
  if (action === 'reopen' && closedTabs.length) { layout = addTab(layout, groupId, closedTabs.at(-1)!); closedTabs = closedTabs.slice(0, -1) }
  return { session: { ...session, layout, closedTabs, maximizedGroupId }, focusedGroupId }
}


/** The group half of the tab menus, applied to a whole session so the tab strip and the
 * sidebar's workspace list drive groups through one implementation. `tabGroupId` reports the
 * group a 'new-group' action just minted, which the caller uses to open its name editor. */
export function applyTabGroupAction(session: SessionRecord, groupId: string, tabId: string, action: TabGroupAction): { session: SessionRecord; tabGroupId: string } {
  const pane = findGroup(session.layout.root, groupId)
  const tab = pane?.tabs.find(item => item.id === tabId)
  if (!pane || !tab) throw new Error('This tab is no longer in the workspace.')
  let layout = session.layout
  let closedTabs = session.closedTabs
  let tabGroupId = ''
  if (action.kind === 'new-group') {
    const created = groupTabs(layout, groupId, [tabId], { title: '' })
    layout = created.layout
    tabGroupId = created.tabGroupId
  }
  if (action.kind === 'join-group') layout = assignTabsToGroup(layout, groupId, [tabId], action.tabGroupId)
  if (action.kind === 'leave-group') layout = assignTabsToGroup(layout, groupId, [tabId], null)
  if (action.kind === 'rename') layout = editTabGroup(layout, groupId, action.tabGroupId, { title: action.title })
  if (action.kind === 'recolor') layout = editTabGroup(layout, groupId, action.tabGroupId, { color: action.color })
  if (action.kind === 'collapse') layout = collapseTabGroup(layout, groupId, action.tabGroupId, action.collapsed)
  if (action.kind === 'ungroup') layout = ungroupTabGroup(layout, groupId, action.tabGroupId)
  if (action.kind === 'new-tab-in-group') {
    // Straight after the group's last tab, so it joins the run rather than landing at the end
    // of the strip and being dragged back in.
    const after = pane.tabs.map(item => item.tabGroupId).lastIndexOf(action.tabGroupId)
    layout = addTab(layout, groupId, { ...makeLauncherTab(), tabGroupId: action.tabGroupId }, after + 1)
  }
  if (action.kind === 'close-group') {
    const result = closeTabGroup(layout, groupId, action.tabGroupId)
    layout = result.layout
    closedTabs = [...closedTabs, ...result.closed].slice(-20)
  }
  return { session: { ...session, layout, closedTabs }, tabGroupId }
}
