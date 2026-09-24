import { ipcRenderer } from 'electron'
import type { LogicLoopsBridge } from '../shared/logic-loops'

export const logicLoopsBridge: LogicLoopsBridge = {
  snapshot: projectId => ipcRenderer.invoke('logic-loops:snapshot', projectId),
  apply: (projectId, proposalId) => ipcRenderer.invoke('logic-loops:apply', projectId, proposalId),
  reject: (projectId, proposalId) => ipcRenderer.invoke('logic-loops:reject', projectId, proposalId),
  onChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, projectId: string): void => callback(projectId)
    ipcRenderer.on('logic-loops:changed', listener)
    return () => ipcRenderer.removeListener('logic-loops:changed', listener)
  }
}
