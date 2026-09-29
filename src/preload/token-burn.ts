import { ipcRenderer } from 'electron'
import type { TokenBurnBridge, TokenBurnSnapshot } from '../shared/token-burn'

export const tokenBurnBridge: TokenBurnBridge = {
  snapshot: () => ipcRenderer.invoke('token-burn:snapshot'),
  alertPerHour: () => ipcRenderer.invoke('token-burn:alert'),
  setAlertPerHour: value => ipcRenderer.invoke('token-burn:set-alert', value),
  onChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: TokenBurnSnapshot): void => callback(snapshot)
    ipcRenderer.on('token-burn:changed', listener)
    return () => ipcRenderer.removeListener('token-burn:changed', listener)
  }
}
