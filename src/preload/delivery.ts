import { ipcRenderer } from 'electron'
import type { DeliveryBridge, DeliveryRun } from '../shared/delivery'

export const deliveryBridge: DeliveryBridge = {
  status: projectId => ipcRenderer.invoke('delivery:status', projectId),
  current: projectId => ipcRenderer.invoke('delivery:current', projectId),
  ship: request => ipcRenderer.invoke('delivery:ship', request),
  cancel: projectId => ipcRenderer.invoke('delivery:cancel', projectId),
  onChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, run: DeliveryRun): void => callback(run)
    ipcRenderer.on('delivery:changed', listener)
    return () => ipcRenderer.removeListener('delivery:changed', listener)
  }
}
