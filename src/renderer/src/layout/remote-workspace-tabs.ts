import type { WorkspaceLayout } from '../../../shared/models'
import type { RemoteAttachedTab, RemoteWorkspaceTab } from '../../../shared/remote-control'
import { createPaneTab } from '../panes/pane-factory'
import { activateTab, addTab, findGroup, listGroups, replaceTab } from './layout-operations'

/** A conversation on the host, named the way `remote.attachTab` needs it. */
export interface RemoteConversationChoice {
  remoteSessionId: string
  tab: RemoteWorkspaceTab
}

/**
 * What "Open all" in a host workspace opens: every conversation there that is not already
 * mirrored on this computer. One already shown here is left where it is rather than opened twice.
 */
export function conversationsToOpen(remoteSessionId: string, tabs: readonly RemoteWorkspaceTab[]): RemoteConversationChoice[] {
  return tabs.filter(tab => !tab.localSessionId).map(tab => ({ remoteSessionId, tab }))
}

/**
 * Puts mirrored host conversations into one group of this workspace. A conversation already shown
 * by a tab anywhere in the layout is selected instead of duplicated; one already mirrored into a
 * different workspace here is reported, never moved (its history is bound to that workspace). The
 * first new tab takes the launcher's place, the rest join the same group, and the last one opened
 * is selected.
 */
export function placeAttachedTabs(
  layout: WorkspaceLayout,
  groupId: string,
  launcherTabId: string | null,
  sessionId: string,
  attached: readonly RemoteAttachedTab[]
): { layout: WorkspaceLayout; elsewhere: string[] } {
  let next = layout
  let launcher = launcherTabId && findGroup(layout.root, groupId)?.tabs.some(tab => tab.id === launcherTabId) ? launcherTabId : null
  const elsewhere: string[] = []
  for (const conversation of attached) {
    const shown = listGroups(next.root).flatMap(group => group.tabs.filter(tab => tab.kind === 'agent' && tab.resourceId === conversation.localSessionId).map(tab => ({ group, tab })))[0]
    if (shown) { next = activateTab(next, shown.group.id, shown.tab.id); continue }
    if (conversation.existingWorkspaceId && conversation.existingWorkspaceId !== sessionId) { elsewhere.push(conversation.title); continue }
    const tab = createPaneTab('agent', {
      provider: conversation.provider,
      machineId: conversation.machineId,
      resourceId: conversation.localSessionId,
      title: `${conversation.title} · ${conversation.machineName}`
    })
    if (launcher) { next = replaceTab(next, groupId, launcher, tab); launcher = null }
    else next = addTab(next, groupId, tab)
  }
  return { layout: next, elsewhere }
}
