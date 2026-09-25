import { ipcRenderer } from 'electron'
import { CLOUD_CHANNELS as channel, type CloudBridge, type CloudRunSummary } from '../shared/cloud'

export const cloudBridge: CloudBridge = {
  list: projectId => ipcRenderer.invoke(channel.list, projectId),
  get: (projectId, runId) => ipcRenderer.invoke(channel.get, projectId, runId),
  start: input => ipcRenderer.invoke(channel.start, input.projectId, input),
  ensure: (projectId, runId) => ipcRenderer.invoke(channel.ensure, projectId, runId),
  write: (runId, data) => ipcRenderer.send(channel.write, runId, data),
  resize: (runId, cols, rows) => ipcRenderer.send(channel.resize, runId, cols, rows),
  interrupt: (projectId, runId) => ipcRenderer.invoke(channel.interrupt, projectId, runId),
  stop: (projectId, runId) => ipcRenderer.invoke(channel.stop, projectId, runId),
  attach: (projectId, runId) => ipcRenderer.invoke(channel.attach, projectId, runId),
  fetch: (projectId, runId) => ipcRenderer.invoke(channel.fetch, projectId, runId),
  transcript: (projectId, runId, refresh) => ipcRenderer.invoke(channel.transcript, projectId, runId, refresh),
  onData: callback => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { id: string; data: string; sequence: number }): void => callback(payload)
    ipcRenderer.on(channel.data, listener)
    return () => ipcRenderer.removeListener(channel.data, listener)
  },
  onChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, summary: CloudRunSummary): void => callback(summary)
    ipcRenderer.on(channel.changed, listener)
    return () => ipcRenderer.removeListener(channel.changed, listener)
  }
}
