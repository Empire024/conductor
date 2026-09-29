import { ipcRenderer } from 'electron'
import type { AttentionSnapshot, NeedsAttentionBridge } from '../shared/needs-attention'

export const needsAttentionBridge: NeedsAttentionBridge = {
  snapshot: () => ipcRenderer.invoke('attention:snapshot'),
  onChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: AttentionSnapshot): void => callback(snapshot)
    ipcRenderer.on('attention:changed', listener)
    return () => ipcRenderer.removeListener('attention:changed', listener)
  }
}
