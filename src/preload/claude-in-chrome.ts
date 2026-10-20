import { ipcRenderer } from 'electron'
import type { ClaudeInChromeBridge } from '../shared/claude-in-chrome'

export const claudeInChromeBridge: ClaudeInChromeBridge = {
  state: () => ipcRenderer.invoke('claude-in-chrome:state'),
  setMode: mode => ipcRenderer.invoke('claude-in-chrome:set-mode', mode)
}
