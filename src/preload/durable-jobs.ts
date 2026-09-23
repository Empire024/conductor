import { ipcRenderer } from 'electron'
import type { DurableJobSummary } from '../shared/durable-jobs'
import { DURABLE_JOB_CHANNELS as channel, type DurableJobsBridge } from '../shared/durable-jobs-bridge'

export const durableJobsBridge: DurableJobsBridge = {
  list: (projectId, status) => ipcRenderer.invoke(channel.list, projectId, status),
  status: (projectId, jobId) => ipcRenderer.invoke(channel.status, projectId, jobId),
  detail: (projectId, jobId) => ipcRenderer.invoke(channel.detail, projectId, jobId),
  events: (projectId, jobId, afterId, limit) => ipcRenderer.invoke(channel.events, projectId, jobId, afterId, limit),
  create: input => ipcRenderer.invoke(channel.create, input.projectId, input),
  pause: (projectId, jobId, reason) => ipcRenderer.invoke(channel.pause, projectId, jobId, reason),
  resume: (projectId, jobId) => ipcRenderer.invoke(channel.resume, projectId, jobId),
  cancel: (projectId, jobId, reason) => ipcRenderer.invoke(channel.cancel, projectId, jobId, reason),
  report: (projectId, jobId) => ipcRenderer.invoke(channel.report, projectId, jobId),
  reveal: (projectId, jobId, target) => ipcRenderer.invoke(channel.reveal, projectId, jobId, target),
  onChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, summary: DurableJobSummary): void => callback(summary)
    ipcRenderer.on(channel.changed, listener)
    return () => ipcRenderer.removeListener(channel.changed, listener)
  }
}
