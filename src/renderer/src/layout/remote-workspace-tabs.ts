import type { PaneTab, ProjectRecord, WorkspaceLayout } from '../../../shared/models'
import type { RemoteAttachedTab, RemoteHostMirror, RemoteWorkspaceTab } from '../../../shared/remote-control'
import { LOCAL_MACHINE_ID } from '../../../shared/remote-control'
import { createPaneTab } from '../panes/pane-factory'
import { activateTab, addTab, findGroup, listGroups, replaceTab } from './layout-operations'

/**
 * The machine a tab runs on, for the label on its tab: the name a mirrored tab carries, or the
 * host's for a tab of a project that lives there. Null for a tab of this computer's, and when the
 * title already ends with the name (a tab opened from the launcher's list is titled "… · MAIN").
 */
export function tabMachineLabel(tab: Pick<PaneTab, 'title' | 'state'>, project: Pick<ProjectRecord, 'remote'> | null | undefined): string | null {
  const machineId = tab.state?.machineId
  if (typeof machineId !== 'string' || !machineId || machineId === LOCAL_MACHINE_ID) return null
  const named = typeof tab.state?.machineName === 'string' && tab.state.machineName ? tab.state.machineName
    : project?.remote?.machineId === machineId && project.remote.machineName ? project.remote.machineName : null
  if (!named || tab.title.endsWith(` · ${named}`)) return null
  return named
}

/**
 * The one line a project that lives on another machine shows when that machine is not mirroring
 * everything here, saying why and what to click. Null when it is mirroring, or not known yet.
 */
export function mirrorOffLine(hostName: string, mirror: RemoteHostMirror | null | undefined): string | null {
  if (mirror === undefined) return null
  if (mirror === null) return `${hostName} runs an older Conductor that does not mirror its chats here. Update Conductor on ${hostName}; until then open them below.`
  if (mirror.mirror) return null
  const here = mirror.peerName || 'this computer'
  return `${hostName} is not mirroring everything to ${here}. On ${hostName}, open Settings → Remote control and switch on “Mirror everything” for ${here}.`
}

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
