import type { PaneTab } from './models'

export type AgentControlUiAction = 'tabs.list' | 'tabs.open' | 'tabs.close' | 'tabs.focus' | 'tabs.focus-origin' | 'tabs.split' | 'tabs.rename' | 'tabs.detach' | 'agents.configure' | 'agents.configure-confirmed' | 'files.open' | 'workspace.rename' | 'workspace.focus'
export interface AgentControlScope { projectId: string; sessionId: string; agentSessionId: string }
export interface AgentControlUiRequest extends AgentControlScope {
  id: string
  action: AgentControlUiAction
  params: Record<string, unknown>
}
export interface AgentControlUiResponse { id: string; result?: unknown; error?: string }
export interface AgentControlTab extends PaneTab { groupId: string; detachedId?: string; uri: string }
/**
 * A file that changed, wherever it changed. `projectId` is always *this* computer's id for the
 * project, so every existing listener keeps matching on the one field it already used. The two
 * optional fields are set only when the change happened on a paired host: `machineId` names that
 * host, and `remoteProjectId` is the host's own id for the project - which is what a pane opened
 * against a host-resident project is keyed by, and is not an id this computer would otherwise
 * recognise. A listener that ignores both still behaves exactly as it did, which is why they are
 * additive rather than a second channel.
 */
export interface AgentFileChange { projectId: string; path: string; agentSessionId?: string; machineId?: string; remoteProjectId?: string }
/** projectId/sessionId locate the controlled tab. A controller in another open project records
 *  where it sits as well, so ownership survives even though the cable is only drawn in one workspace. */
export interface AgentControlLink { projectId: string; sessionId: string; controllerAgentSessionId: string; targetAgentSessionId: string; controllerTabId: string; controlledTabId: string; controllerProjectId?: string; controllerSessionId?: string; controllerTitle?: string; controlledTitle?: string }
export interface AgentControlBridge {
  openUri(uri: string): Promise<void>
  onRequest(callback: (request: AgentControlUiRequest) => void): () => void
  respond(response: AgentControlUiResponse): void
  links(projectId: string, sessionId: string): Promise<AgentControlLink[]>
  release(targetAgentSessionId: string): Promise<void>
  focusTab(projectId: string, sessionId: string, tabId: string): Promise<void>
  /** Owner-facing transcript navigation only. It resolves an exact durable agent session ID; it
   * never gives the calling agent control over that agent. */
  focusOrigin(agentSessionId: string): Promise<void>
  onLinksChanged(callback: (scope: { projectId: string; sessionId: string }) => void): () => void
}

export const conductorUri = (projectId: string, kind: 'tab' | 'file' | 'workspace', id: string): string =>
  `conductor://${encodeURIComponent(projectId)}/${kind}/${encodeURIComponent(id)}`
