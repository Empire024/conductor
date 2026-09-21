import { ipcMain } from 'electron'
import type { CreateScheduleInput, UpdateScheduleInput } from '../shared/schedules'
import type { ScheduleRunner } from './schedule-runner'
import type { ScheduleStore } from './schedule-store'

export const scheduleIpcChannels = ['schedules:snapshot', 'schedules:create', 'schedules:update', 'schedules:run-now', 'schedules:open-artifact'] as const

export function registerScheduleIpc(options: {
  store: ScheduleStore
  runner: ScheduleRunner
  authorize(event: Electron.IpcMainInvokeEvent, projectId: string): void
  reveal(path: string): void
}): () => void {
  ipcMain.handle('schedules:snapshot', (event, projectId: string) => { options.authorize(event, projectId); return options.store.snapshot(projectId) })
  ipcMain.handle('schedules:create', (event, input: CreateScheduleInput) => { options.authorize(event, input?.projectId); return options.store.create(input) })
  ipcMain.handle('schedules:update', (event, projectId: string, scheduleId: string, input: UpdateScheduleInput) => {
    options.authorize(event, projectId); return options.store.update(projectId, scheduleId, input)
  })
  ipcMain.handle('schedules:run-now', (event, projectId: string, scheduleId: string) => {
    options.authorize(event, projectId); return options.runner.runNow(projectId, scheduleId)
  })
  ipcMain.handle('schedules:open-artifact', (event, projectId: string, runId: string) => {
    options.authorize(event, projectId)
    const run = options.store.runForProject(projectId, runId)
    if (!run.artifactPath) throw new Error('This run has no saved evidence')
    options.reveal(run.artifactPath)
  })
  return () => { for (const channel of scheduleIpcChannels) ipcMain.removeHandler(channel) }
}
