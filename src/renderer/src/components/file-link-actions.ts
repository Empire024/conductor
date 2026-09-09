import type { FileLinkMenuAction } from './file-link-menu'
import { openWorkspaceFile } from './workspace-files-state'

export interface FileLinkTarget { projectId: string; path: string; line?: number }

/** Everything a "file sent to us by an agent" menu can do, shared by the open-tab context menu
 *  (WorkspaceFiles) and the agent-message file-link menu (StructuredAgentRenderers) so the two
 *  can never drift apart. Only "edit" takes a callback: WorkspaceFiles opens its own tab
 *  directly, while an agent's message hands off through the pane's stat-checked onOpenFile —
 *  matching exactly what a plain click on that link already does. The other five actions need
 *  nothing host-specific, so there is exactly one implementation of each. */
export function runFileLinkAction(action: FileLinkMenuAction, target: FileLinkTarget, edit: (path: string, line?: number) => void, notify: (message: string) => void): void {
  if (action === 'edit') edit(target.path, target.line)
  else if (action === 'live-preview') openWorkspaceFile(target.projectId, target.path, 'browser', target.line)
  else if (action === 'preview') openWorkspaceFile(target.projectId, target.path, 'preview', target.line)
  else if (action === 'default-browser') void window.conductor.files.openInBrowser(target.projectId, target.path).catch((reason: unknown) => notify(String(reason)))
  else if (action === 'reveal-explorer') window.dispatchEvent(new CustomEvent('conductor:reveal-in-explorer', { detail: { projectId: target.projectId, relativePath: target.path } }))
  else if (action === 'show-os-explorer') void window.conductor.files.reveal(target.projectId, target.path).catch((reason: unknown) => notify(String(reason)))
}
