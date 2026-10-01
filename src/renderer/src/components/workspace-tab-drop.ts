/** Drop zones that take a dragged tab into another workspace of the project (feature-list
 * ee0fbf15): a workspace's row and tab list in the sidebar, and its tab in the session bar. They
 * mark themselves the way the sidebar's reorder targets already do, through the element's class
 * list, so a zone inside a list rendered by `map` needs no component of its own. */
import type React from 'react'
import { CROSS_WINDOW_TAB_MIME } from '../layout/tab-drag'
import { currentWorkspaceTabDrag, WORKSPACE_DROP_ATTRIBUTE, WORKSPACE_TAB_MIME, workspaceDropVerdict, type WorkspaceTabDrag } from '../layout/workspace-tab-move'
import './workspace-tab-drop.css'

const ACCEPT = 'workspace-drop-target'
const REFUSE = 'workspace-drop-refused'

const tabDrag = (event: React.DragEvent): boolean => {
  const types = event.dataTransfer?.types ?? []
  return types.includes(CROSS_WINDOW_TAB_MIME) || types.includes(WORKSPACE_TAB_MIME)
}
const clear = (element: Element): void => { element.classList.remove(ACCEPT, REFUSE) }

if (typeof document !== 'undefined') {
  // A drag that ends anywhere else leaves no zone lit.
  const clearAll = (): void => { for (const element of document.querySelectorAll(`.${ACCEPT}, .${REFUSE}`)) clear(element) }
  document.addEventListener('dragend', clearAll, true)
  document.addEventListener('drop', () => window.setTimeout(clearAll, 0), true)
}

export interface WorkspaceDropHandlers {
  [WORKSPACE_DROP_ATTRIBUTE]: string
  /** Each returns true when the event was a tab drag it handled, so a zone that also takes
   *  other drags (the sidebar row reorders workspaces) runs its own handling only otherwise. */
  onDragOver(event: React.DragEvent): boolean
  onDragLeave(event: React.DragEvent): boolean
  onDrop(event: React.DragEvent): boolean
}

/** A tab from this workspace is a no-op, one from another project (or a detached window, whose
 * drag this window cannot read) is refused with the not-allowed cursor, and one from another
 * workspace of the project lights the zone and moves on drop. */
export function workspaceDropHandlers(target: { projectId: string; id: string; name: string }, onMove: (drag: WorkspaceTabDrag) => void): WorkspaceDropHandlers {
  return {
    [WORKSPACE_DROP_ATTRIBUTE]: target.id,
    onDragOver: event => {
      if (!tabDrag(event)) return false
      const drag = currentWorkspaceTabDrag()
      const verdict = workspaceDropVerdict(drag, target)
      event.preventDefault()
      event.stopPropagation()
      const element = event.currentTarget
      if (verdict === 'move') {
        event.dataTransfer.dropEffect = 'move'
        element.classList.add(ACCEPT); element.classList.remove(REFUSE)
        element.setAttribute('title', `Move ${drag!.tabIds.length === 1 ? 'this tab' : `${drag!.tabIds.length} tabs`} to ${target.name}`)
      } else {
        event.dataTransfer.dropEffect = 'none'
        element.classList.remove(ACCEPT)
        if (verdict === 'same') element.classList.remove(REFUSE)
        else { element.classList.add(REFUSE); element.setAttribute('title', 'Tabs move only between workspaces of one project') }
      }
      return true
    },
    onDragLeave: event => {
      if (!tabDrag(event)) return false
      const next = event.relatedTarget
      if (!(next instanceof Node) || !event.currentTarget.contains(next)) { clear(event.currentTarget); event.currentTarget.removeAttribute('title') }
      return true
    },
    onDrop: event => {
      if (!tabDrag(event)) return false
      event.preventDefault()
      event.stopPropagation()
      clear(event.currentTarget)
      event.currentTarget.removeAttribute('title')
      const drag = currentWorkspaceTabDrag()
      if (workspaceDropVerdict(drag, target) === 'move') onMove(drag!)
      return true
    }
  }
}

/** The handlers as React props, for a zone that takes nothing but tabs. */
export const workspaceDropProps = (handlers: WorkspaceDropHandlers): Record<string, unknown> => ({
  [WORKSPACE_DROP_ATTRIBUTE]: handlers[WORKSPACE_DROP_ATTRIBUTE],
  onDragOver: (event: React.DragEvent) => { handlers.onDragOver(event) },
  onDragLeave: (event: React.DragEvent) => { handlers.onDragLeave(event) },
  onDrop: (event: React.DragEvent) => { handlers.onDrop(event) }
})
