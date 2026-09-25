import { ipcRenderer } from 'electron'
import { IDEA_RUNS_IPC as channel, type IdeaRunsBridge } from '../shared/idea-runs'

export const ideaRunsBridge: IdeaRunsBridge = {
  list: query => ipcRenderer.invoke(channel.list, query),
  get: runId => ipcRenderer.invoke(channel.get, runId),
  start: input => ipcRenderer.invoke(channel.start, input),
  approve: runId => ipcRenderer.invoke(channel.approve, runId),
  decide: input => ipcRenderer.invoke(channel.decide, input),
  pause: runId => ipcRenderer.invoke(channel.pause, runId),
  resume: runId => ipcRenderer.invoke(channel.resume, runId),
  stop: runId => ipcRenderer.invoke(channel.stop, runId),
  onChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, change: { runId: string; ideaId: string }): void => callback(change)
    ipcRenderer.on(channel.changed, listener)
    return () => ipcRenderer.removeListener(channel.changed, listener)
  }
}
