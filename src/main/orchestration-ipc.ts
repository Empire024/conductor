import { ipcMain } from 'electron'
import type {
  CreateOrchestrationTaskInput,
  SaveOrchestrationAgentInput,
  SaveRoutineInput,
  UpdateOrchestrationTaskInput
} from '../shared/orchestration'
import type { OrchestrationStore } from './orchestration-store'

export const orchestrationIpcChannels = [
  'orchestration:snapshot',
  'orchestration:agents:save',
  'orchestration:agents:remove',
  'orchestration:tasks:create',
  'orchestration:tasks:update',
  'orchestration:tasks:remove',
  'orchestration:routines:save',
  'orchestration:routines:remove',
  'orchestration:routines:start'
] as const

/** Register the project orchestration API and return a hot-reload friendly disposer. */
export const registerOrchestrationIpc = (store: OrchestrationStore): (() => void) => {
  ipcMain.handle('orchestration:snapshot', (_event, projectId: string) =>
    store.snapshot(projectId)
  )
  ipcMain.handle('orchestration:agents:save', (_event, input: SaveOrchestrationAgentInput) =>
    store.saveAgent(input)
  )
  ipcMain.handle('orchestration:agents:remove', (_event, id: string) =>
    store.removeAgent(id)
  )
  ipcMain.handle('orchestration:tasks:create', (_event, input: CreateOrchestrationTaskInput) =>
    store.createTask(input)
  )
  ipcMain.handle(
    'orchestration:tasks:update',
    (_event, id: string, input: UpdateOrchestrationTaskInput) => store.updateTask(id, input)
  )
  ipcMain.handle('orchestration:tasks:remove', (_event, id: string) =>
    store.removeTask(id)
  )
  ipcMain.handle('orchestration:routines:save', (_event, input: SaveRoutineInput) =>
    store.saveRoutine(input)
  )
  ipcMain.handle('orchestration:routines:remove', (_event, id: string) =>
    store.removeRoutine(id)
  )
  ipcMain.handle('orchestration:routines:start', (_event, id: string) =>
    store.startRoutine(id)
  )

  return () => {
    for (const channel of orchestrationIpcChannels) ipcMain.removeHandler(channel)
  }
}
