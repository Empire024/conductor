/** Moving tabs from one workspace of a project to another (feature-list ee0fbf15): the pure
 * layout half, and the one piece of drag state the sidebar needs while a tab is in flight.
 * The main process rebinds the moved conversations and writes both layouts in one call
 * (`sessions:move-tabs`), so nothing about a conversation restarts and nothing waits for an
 * autosave to reach the disk. */
import type { PaneTab, SessionRecord } from '../../../shared/models'
import { addTab, closeTab, findGroup, listGroups } from './layout-operations'

/** A tab row dragged out of the sidebar's workspace tree. It is deliberately not the pane
 * strip's CROSS_WINDOW_TAB_MIME: a pane would graft that into its own layout as a foreign tab. */
export const WORKSPACE_TAB_MIME = 'application/x-conductor-workspace-tab'

/** Which tabs are in flight and where from. `dataTransfer` is unreadable until the drop, so a
 * drop target asks this during dragover to say yes or no before the owner lets go. Only a drag
 * that started in this window sets it; a tab dragged in from a detached window has none and is
 * not offered to a workspace. */
export interface WorkspaceTabDrag {
  projectId: string
  sessionId: string
  tabIds: string[]
}

let current: WorkspaceTabDrag | null = null
export const beginWorkspaceTabDrag = (drag: WorkspaceTabDrag): void => { current = drag }
export const currentWorkspaceTabDrag = (): WorkspaceTabDrag | null => current
export const endWorkspaceTabDrag = (): void => { current = null }
if (typeof document !== 'undefined') {
  // dragend fires wherever the drag started, whatever took the drop; the capture listener
  // clears the state after the source's own handlers, which read it first.
  document.addEventListener('dragend', () => { window.setTimeout(endWorkspaceTabDrag, 0) }, true)
}

/** The attribute every workspace drop zone carries, so a pane's document-wide drag listeners
 * know to stand aside while the pointer is over one. */
export const WORKSPACE_DROP_ATTRIBUTE = 'data-workspace-drop'
export const overWorkspaceDrop = (target: EventTarget | null): boolean =>
  typeof Element !== 'undefined' && target instanceof Element && Boolean(target.closest(`[${WORKSPACE_DROP_ATTRIBUTE}]`))

/** 'move' to another workspace of the same project; 'same' is the workspace it came from (a
 * no-op); 'foreign' is another project, refused with a not-allowed cursor; 'none' is no tab drag. */
export type WorkspaceDropVerdict = 'move' | 'same' | 'foreign' | 'none'
export const workspaceDropVerdict = (drag: WorkspaceTabDrag | null, target: { projectId: string; id: string }): WorkspaceDropVerdict =>
  !drag || !drag.tabIds.length ? 'none' : drag.projectId !== target.projectId ? 'foreign' : drag.sessionId === target.id ? 'same' : 'move'

export interface WorkspaceTabMove {
  source: SessionRecord
  target: SessionRecord
  /** The tabs that left `source`, in the order they now sit in `target`. */
  moved: PaneTab[]
  /** The pane of `target` they landed in. */
  groupId: string
}

/** Lifts `tabIds` out of `source` and appends them to one pane of `target` (`groupId`, else the
 * target's first pane that shows a tab, else its first), the first of them active. Tab ids,
 * titles, resource ids and state are kept exactly, so the conversation, its draft (keyed by the
 * conversation) and its control links (keyed by tab id) all follow. A tab-strip group belongs
 * to the pane it was made in and stays behind. Moving the last tab leaves `source` empty rather
 * than gone; unknown ids are skipped, and nothing found means nothing changes. */
export function moveTabsToWorkspace(source: SessionRecord, target: SessionRecord, tabIds: readonly string[], groupId?: string): WorkspaceTabMove | null {
  if (source.id === target.id || source.projectId !== target.projectId) return null
  let layout = source.layout
  const moved: PaneTab[] = []
  for (const id of new Set(tabIds)) {
    const pane = listGroups(layout.root).find(group => group.tabs.some(tab => tab.id === id))
    if (!pane) continue
    const result = closeTab(layout, pane.id, id)
    if (!result.closed) continue
    layout = result.layout
    const { tabGroupId: _dropped, ...tab } = result.closed
    moved.push(tab)
  }
  if (!moved.length) return null
  const groups = listGroups(target.layout.root)
  const pane = (groupId ? findGroup(target.layout.root, groupId) : null) ?? groups.find(group => group.tabs.length > 0) ?? groups[0]!
  const targetLayout = moved.reduceRight((next, tab) => addTab(next, pane.id, tab, pane.tabs.length), target.layout)
  const maximizedGroupId = source.maximizedGroupId && findGroup(layout.root, source.maximizedGroupId) ? source.maximizedGroupId : null
  return {
    source: { ...source, layout, maximizedGroupId },
    target: { ...target, layout: targetLayout },
    moved,
    groupId: pane.id
  }
}

/** Every agent conversation among `tabs`: the main process moves these to the new workspace. */
export const movedConversationIds = (tabs: readonly PaneTab[]): string[] =>
  tabs.flatMap(tab => tab.kind === 'agent' && tab.resourceId ? [tab.resourceId] : [])
