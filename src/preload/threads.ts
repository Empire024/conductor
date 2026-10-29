import { ipcRenderer } from 'electron'
import type { ThreadsBridge } from '../shared/threads'

export const threadsBridge: ThreadsBridge = {
  newGeneral: () => ipcRenderer.invoke('threads:new-general'),
  generalProjectId: () => ipcRenderer.invoke('threads:general-id'),
  list: query => ipcRenderer.invoke('threads:list', query),
  handoff: (agentSessionId, targetProjectId) => ipcRenderer.invoke('threads:handoff', agentSessionId, targetProjectId),
  promote: name => ipcRenderer.invoke('threads:promote', name)
}
