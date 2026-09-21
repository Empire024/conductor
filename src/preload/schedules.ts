import { ipcRenderer } from 'electron'
import type { SchedulesBridge } from '../shared/schedules'

export const schedulesBridge: SchedulesBridge = {
  snapshot: projectId => ipcRenderer.invoke('schedules:snapshot', projectId),
  create: input => ipcRenderer.invoke('schedules:create', input),
  update: (projectId, scheduleId, input) => ipcRenderer.invoke('schedules:update', projectId, scheduleId, input),
  runNow: (projectId, scheduleId) => ipcRenderer.invoke('schedules:run-now', projectId, scheduleId),
  openArtifact: (projectId, runId) => ipcRenderer.invoke('schedules:open-artifact', projectId, runId),
  onChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, projectId: string): void => callback(projectId)
    ipcRenderer.on('schedules:changed', listener)
    return () => ipcRenderer.removeListener('schedules:changed', listener)
  }
}
