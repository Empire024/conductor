import { ipcRenderer } from 'electron'
import { IDEAS_IPC as channel, type IdeasBridge, type IdeasChange } from '../shared/ideas'

export const ideasBridge: IdeasBridge = {
  list: query => ipcRenderer.invoke(channel.list, query),
  get: ideaId => ipcRenderer.invoke(channel.get, ideaId),
  capture: input => ipcRenderer.invoke(channel.capture, input),
  update: (ideaId, input) => ipcRenderer.invoke(channel.update, ideaId, input),
  work: input => ipcRenderer.invoke(channel.work, input),
  explore: input => ipcRenderer.invoke(channel.explore, input),
  createTask: input => ipcRenderer.invoke(channel.createTask, input),
  unlink: (ideaId, linkId) => ipcRenderer.invoke(channel.unlink, ideaId, linkId),
  incubator: () => ipcRenderer.invoke(channel.incubator),
  setIncubator: settings => ipcRenderer.invoke(channel.setIncubator, settings),
  openLink: (ideaId, linkId) => ipcRenderer.invoke(channel.openLink, ideaId, linkId),
  onChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, change: IdeasChange): void => callback(change)
    ipcRenderer.on(channel.changed, listener)
    return () => ipcRenderer.removeListener(channel.changed, listener)
  },
  onCapture: callback => {
    const listener = (): void => callback()
    ipcRenderer.on(channel.captureRequested, listener)
    return () => ipcRenderer.removeListener(channel.captureRequested, listener)
  }
}
