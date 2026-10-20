import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { claudeInChromeEnabled, parseClaudeInChromeMode, type ClaudeInChromeMode, type ClaudeInChromeState } from '../shared/claude-in-chrome'

/** The database setting that holds the owner's choice ('on' | 'off'; absent = auto). */
export const CLAUDE_IN_CHROME_SETTING = 'claudeInChrome'
const HOST = 'com.anthropic.claude_code_browser_extension.json'

/**
 * Where Claude Code registers the extension's native messaging host manifest for this user. On
 * Windows the registry key (HKCU\Software\Google\Chrome\NativeMessagingHosts\…) points at the file
 * under %APPDATA%\Claude Code; elsewhere the browsers read it from their own folders.
 */
export function claudeInChromeHostPaths(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  if (platform === 'win32') return [join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude Code', 'ChromeNativeHost', HOST)]
  const browsers = platform === 'darwin'
    ? ['Google/Chrome', 'Google/Chrome Beta', 'Chromium', 'Microsoft Edge', 'BraveSoftware/Brave-Browser'].map(dir => join(home, 'Library', 'Application Support', dir))
    : ['google-chrome', 'google-chrome-beta', 'chromium', 'microsoft-edge', 'BraveSoftware/Brave-Browser'].map(dir => join(env.XDG_CONFIG_HOME ?? join(home, '.config'), dir))
  return browsers.map(dir => join(dir, 'NativeMessagingHosts', HOST))
}

export function claudeInChromeHostInstalled(paths = claudeInChromeHostPaths(), exists: (path: string) => boolean = existsSync): boolean {
  return paths.some(path => { try { return exists(path) } catch { return false } })
}

export function claudeInChromeState(getSetting: (key: string) => string | null, hostInstalled = claudeInChromeHostInstalled()): ClaudeInChromeState {
  const mode = parseClaudeInChromeMode(getSetting(CLAUDE_IN_CHROME_SETTING))
  return { mode, hostInstalled, enabled: claudeInChromeEnabled(mode, hostInstalled) }
}

/** Settings > Runtimes: the owner's window reads and sets the mode. It applies to Claude tabs
 *  started or resumed afterwards; a running CLI cannot take a new MCP server. */
export function registerClaudeInChromeIpc(ipc: IpcMain, settings: { getSetting(key: string): string | null; setSetting(key: string, value: string): void; deleteSetting?(key: string): void }, authorize: (event: IpcMainInvokeEvent) => void): void {
  ipc.handle('claude-in-chrome:state', event => { authorize(event); return claudeInChromeState(key => settings.getSetting(key)) })
  ipc.handle('claude-in-chrome:set-mode', (event, mode: unknown) => {
    authorize(event)
    if (mode !== 'auto' && mode !== 'on' && mode !== 'off') throw new Error('Claude in Chrome mode must be auto, on or off')
    settings.setSetting(CLAUDE_IN_CHROME_SETTING, mode as ClaudeInChromeMode)
    return claudeInChromeState(key => settings.getSetting(key))
  })
}
