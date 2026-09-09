import type { PaneTab } from './models'

export type AgentControlUiAction = 'tabs.list' | 'tabs.open' | 'tabs.close' | 'tabs.focus' | 'tabs.split' | 'tabs.rename' | 'tabs.detach' | 'files.open' | 'workspace.rename' | 'workspace.focus'
export interface AgentControlScope { projectId: string; sessionId: string; agentSessionId: string }
export interface AgentControlUiRequest extends AgentControlScope {
  id: string
  action: AgentControlUiAction
  params: Record<string, unknown>
}
export interface AgentControlUiResponse { id: string; result?: unknown; error?: string }
export interface AgentControlTab extends PaneTab { groupId: string; detachedId?: string; uri: string }
export interface AgentFileChange { projectId: string; path: string; agentSessionId?: string }
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
  onLinksChanged(callback: (scope: { projectId: string; sessionId: string }) => void): () => void
}

export const conductorUri = (projectId: string, kind: 'tab' | 'file' | 'workspace', id: string): string =>
  `conductor://${encodeURIComponent(projectId)}/${kind}/${encodeURIComponent(id)}`
