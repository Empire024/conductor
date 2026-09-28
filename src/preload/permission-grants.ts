import { ipcRenderer } from 'electron'
import type { PermissionGrantsBridge, PermissionGrantsState } from '../shared/permission-grants'

export const permissionGrantsBridge: PermissionGrantsBridge = {
  state: () => ipcRenderer.invoke('permission-grants:state'),
  decide: (agentSessionId, requestId, decision) => ipcRenderer.invoke('permission-grants:decide', agentSessionId, requestId, decision),
  revoke: (agentSessionId, grantId) => ipcRenderer.invoke('permission-grants:revoke', agentSessionId, grantId),
  interrupt: (agentSessionId, grantId) => ipcRenderer.invoke('permission-grants:interrupt', agentSessionId, grantId),
  onChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: PermissionGrantsState): void => callback(state)
    ipcRenderer.on('permission-grants:changed', listener)
    return () => ipcRenderer.removeListener('permission-grants:changed', listener)
  }
}
