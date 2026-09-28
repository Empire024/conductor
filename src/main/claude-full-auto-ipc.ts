import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { ClaudeFullAutoPolicy } from './claude-full-auto'

/** Deliberately absent from app-control/MCP: agent authority, even wizard authority, cannot
 * impersonate the one genuine owner activation. Only Conductor's trusted top-level UI can. */
export function registerClaudeFullAutoIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, policy: ClaudeFullAutoPolicy, authorize: (event: IpcMainInvokeEvent) => void): () => void {
  ipc.handle('claude-full-auto:state', event => { authorize(event); return policy.state() })
  ipc.handle('claude-full-auto:set-enabled', (event, enabled: unknown) => {
    authorize(event)
    if (typeof enabled !== 'boolean') throw new Error('Full Auto authorization must be a boolean')
    return policy.setEnabled(enabled)
  })
  return () => { ipc.removeHandler('claude-full-auto:state'); ipc.removeHandler('claude-full-auto:set-enabled') }
}
