import type { SessionRecord } from '../../../shared/models'
import { makeLauncherTab } from '../../../shared/models'
import { activateTab, addTab, closeTab, duplicateTab, findGroup, listGroups, splitGroup, updateTab } from './layout-operations'

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
