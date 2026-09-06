import { ipcRenderer } from 'electron'
import type { AgentCollaborationBridge } from '../shared/agent-collaboration'

/** Add this object as `collaboration` on the existing context-bridge payload. */
export const agentCollaborationBridge: AgentCollaborationBridge = {
  snapshot: (query) => ipcRenderer.invoke('collaboration:snapshot', query),
  briefing: (agentSessionId) => ipcRenderer.invoke('collaboration:briefing', agentSessionId),
  messages: {
    post: (input) => ipcRenderer.invoke('collaboration:messages:post', input),
    list: (query) => ipcRenderer.invoke('collaboration:messages:list', query)
  },
  presence: {
    announce: (input) => ipcRenderer.invoke('collaboration:presence:announce', input),
    list: (query) => ipcRenderer.invoke('collaboration:presence:list', query),
    conflicts: (query) => ipcRenderer.invoke('collaboration:presence:conflicts', query),
    release: (agentSessionId, path) =>
      ipcRenderer.invoke('collaboration:presence:release', agentSessionId, path)
  }
}
