import { writeFile } from 'node:fs/promises'
import type { BrowserWindow, IpcMain, SaveDialogOptions } from 'electron'
import type { PhoneAccessSettings, PhoneAccessState } from '../shared/phone-access'
import type { PhoneAccessService } from './phone-access'
import type { PhoneAccessServer } from './phone-access-server'

export interface PhoneAccessIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  service: PhoneAccessService
  server: PhoneAccessServer
  window(): BrowserWindow | null
  showSaveDialog(window: BrowserWindow | null, options: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>
}

const CHANNELS = ['phone:state', 'phone:set-settings', 'phone:pair', 'phone:cancel-pairing', 'phone:check', 'phone:revoke', 'phone:rename', 'phone:save-certificate', 'phone:test-notification', 'phone:lock-set', 'phone:lock-remove', 'phone:lock-reset', 'phone:lock-idle', 'phone:lock-all'] as const

/** The desktop panel's side of phone access: every handler answers with the whole panel state. */
export function registerPhoneAccessIpc(deps: PhoneAccessIpcDependencies): () => void {
  const { ipcMain, service, server } = deps
  const state = (): PhoneAccessState => service.desktopState()
  const handle = <T>(channel: (typeof CHANNELS)[number], run: (...args: never[]) => Promise<T> | T): void => { ipcMain.handle(channel, (_event, ...args) => run(...args as never[])) }
  handle('phone:state', () => state())
  handle('phone:set-settings', async (patch: Partial<PhoneAccessSettings>) => {
    service.updateSettings(patch && typeof patch === 'object' ? patch : {})
    await server.apply()
    return state()
  })
  handle('phone:pair', (endpoint?: string) => { service.createPairing(typeof endpoint === 'string' && endpoint ? endpoint : undefined); return state() })
  handle('phone:cancel-pairing', () => { service.cancelPairing(); return state() })
  // The setup steps' "Check again": a fresh tailnet reading, no listener restart unless the bound
  // address moved. A phone that just joined the tailnet shows up here.
  handle('phone:check', async () => { await server.check(); return state() })
  handle('phone:revoke', (deviceId: string) => { service.revoke(String(deviceId)); return state() })
  handle('phone:rename', (deviceId: string, name: string) => { service.rename(String(deviceId), name); return state() })
  handle('phone:save-certificate', async () => {
    const authority = service.certificateAuthority()
    const result = await deps.showSaveDialog(deps.window(), { title: 'Save the Conductor phone certificate', defaultPath: 'conductor-phone-ca.crt', filters: [{ name: 'Certificate', extensions: ['crt', 'cer', 'pem'] }] })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, authority.certificatePem, 'utf8')
    return result.filePath
  })
  handle('phone:test-notification', (deviceId?: string) => service.testNotification(typeof deviceId === 'string' && deviceId ? deviceId : undefined))
  // The phone lock: the code crosses IPC once, to be hashed here; nothing sends it back.
  handle('phone:lock-set', async (code: string) => { await service.lock.setCode(code); return state() })
  handle('phone:lock-remove', () => { service.lock.removeCode(); return state() })
  handle('phone:lock-reset', () => { service.lock.resetAttempts(); return state() })
  handle('phone:lock-idle', (minutes: number) => { service.lock.setIdleMinutes(minutes); return state() })
  handle('phone:lock-all', () => { service.lock.lockAll(); return state() })
  return () => { for (const channel of CHANNELS) ipcMain.removeHandler(channel) }
}
