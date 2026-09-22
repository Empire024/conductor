import { ipcMain } from 'electron'
import type { DeliveryRequest } from '../shared/delivery'
import type { DeliveryService } from './delivery'

export const deliveryIpcChannels = ['delivery:status', 'delivery:current', 'delivery:ship', 'delivery:cancel'] as const

export function registerDeliveryIpc(options: {
  service: DeliveryService
  authorize(event: Electron.IpcMainInvokeEvent, projectId: string): void
  projectPath(projectId: string): string
}): () => void {
  ipcMain.handle('delivery:status', (event, projectId: string) => {
    options.authorize(event, projectId); return options.service.status(projectId, options.projectPath(projectId))
  })
  ipcMain.handle('delivery:current', (event, projectId: string) => { options.authorize(event, projectId); return options.service.current(projectId) })
  ipcMain.handle('delivery:ship', (event, request: DeliveryRequest) => {
    options.authorize(event, request?.projectId)
    // Only the owner's own window reaches this channel; agents ship through the control server.
    return options.service.ship(request.projectId, options.projectPath(request.projectId), { message: request.message, ...(request.paths ? { paths: request.paths } : {}) }, { kind: 'owner' })
  })
  ipcMain.handle('delivery:cancel', (event, projectId: string) => { options.authorize(event, projectId); return options.service.cancel(projectId) })
  return () => { for (const channel of deliveryIpcChannels) ipcMain.removeHandler(channel) }
}
