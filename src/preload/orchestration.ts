import { ipcRenderer } from 'electron'
import type { OrchestrationBridge } from '../shared/orchestration'

/** Add this object as `orchestration` on the existing context-bridge payload. */
export const orchestrationBridge: OrchestrationBridge = {
  snapshot: (projectId) => ipcRenderer.invoke('orchestration:snapshot', projectId),
  agents: {
    save: (input) => ipcRenderer.invoke('orchestration:agents:save', input),
    remove: (id) => ipcRenderer.invoke('orchestration:agents:remove', id)
  },
  tasks: {
    create: (input) => ipcRenderer.invoke('orchestration:tasks:create', input),
    update: (id, input) => ipcRenderer.invoke('orchestration:tasks:update', id, input),
    remove: (id) => ipcRenderer.invoke('orchestration:tasks:remove', id)
  },
  routines: {
    save: (input) => ipcRenderer.invoke('orchestration:routines:save', input),
    remove: (id) => ipcRenderer.invoke('orchestration:routines:remove', id),
    start: (id) => ipcRenderer.invoke('orchestration:routines:start', id)
  }
}
