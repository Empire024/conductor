import { ipcRenderer } from 'electron'
import type { ProviderLoginBridge, ProviderLoginState } from '../shared/claude-login'

export const providerLoginBridge: ProviderLoginBridge = {
  state: () => ipcRenderer.invoke('provider-login:state'),
  start: request => ipcRenderer.invoke('provider-login:start', request),
  submitCode: request => ipcRenderer.invoke('provider-login:code', request),
  cancel: id => ipcRenderer.invoke('provider-login:cancel', id),
  removeToken: () => ipcRenderer.invoke('provider-login:remove-token'),
  onChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: ProviderLoginState): void => callback(state)
    ipcRenderer.on('provider-login:changed', listener)
    return () => ipcRenderer.removeListener('provider-login:changed', listener)
  }
}
