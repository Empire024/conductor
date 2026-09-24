import { ipcRenderer } from 'electron'
import type { SchedulesBridge } from '../shared/schedules'

export const schedulesBridge: SchedulesBridge = {
  snapshot: projectId => ipcRenderer.invoke('schedules:snapshot', projectId),
  create: input => ipcRenderer.invoke('schedules:create', input),
  update: (projectId, scheduleId, input) => ipcRenderer.invoke('schedules:update', projectId, scheduleId, input),
  remove: (projectId, scheduleId) => ipcRenderer.invoke('schedules:remove', projectId, scheduleId),
  runNow: (projectId, scheduleId) => ipcRenderer.invoke('schedules:run-now', projectId, scheduleId),
  openArtifact: (projectId, runId) => ipcRenderer.invoke('schedules:open-artifact', projectId, runId),
  openConversation: (projectId, runId) => ipcRenderer.invoke('schedules:open-conversation', projectId, runId),
  assignScripts: (projectId, scheduleId) => ipcRenderer.invoke('schedules:assign-scripts', projectId, scheduleId),
  deleteScript: (projectId, scheduleId, name) => ipcRenderer.invoke('schedules:delete-script', projectId, scheduleId, name),
  onChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, projectId: string): void => callback(projectId)
    ipcRenderer.on('schedules:changed', listener)
    return () => ipcRenderer.removeListener('schedules:changed', listener)
  }
}
