import { ipcRenderer } from 'electron'
import type { ClaudeFullAutoBridge, ClaudeFullAutoState } from '../shared/claude-full-auto'

export const claudeFullAutoBridge: ClaudeFullAutoBridge = {
  state: () => ipcRenderer.invoke('claude-full-auto:state'),
  setEnabled: enabled => ipcRenderer.invoke('claude-full-auto:set-enabled', enabled),
  onChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: ClaudeFullAutoState): void => callback(state)
    ipcRenderer.on('claude-full-auto:changed', listener)
    return () => ipcRenderer.removeListener('claude-full-auto:changed', listener)
  }
}
