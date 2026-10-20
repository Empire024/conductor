/**
 * Claude in Chrome for Conductor's Claude tabs (haf-stuff 2026-10-21: the owner's extension was on,
 * /anthropic-skills:chrome-browser loaded, and no mcp__claude-in-chrome__* tool existed). Conductor
 * runs claude in --print stream-json mode, where the CLI attaches the extension's MCP server only
 * when launched with --chrome (probed on 2.1.301: 22 tools, server "connected"); the interactive
 * CLI's claudeInChromeDefaultEnabled does not reach that mode. The owner's choice is global:
 * 'auto' (the default) turns it on whenever the extension's native messaging host is installed.
 */
export type ClaudeInChromeMode = 'auto' | 'on' | 'off'

export interface ClaudeInChromeState {
  mode: ClaudeInChromeMode
  /** The extension's native messaging host is registered for this user on this machine. */
  hostInstalled: boolean
  /** What new and resumed Claude tabs get: --chrome or not. */
  enabled: boolean
}

export interface ClaudeInChromeBridge {
  state(): Promise<ClaudeInChromeState>
  setMode(mode: ClaudeInChromeMode): Promise<ClaudeInChromeState>
}

/** Whether Claude tabs launch with --chrome: the owner's on/off, or auto = when the host is installed. */
export const claudeInChromeEnabled = (mode: ClaudeInChromeMode, hostInstalled: boolean): boolean => mode === 'on' || mode === 'auto' && hostInstalled

export const parseClaudeInChromeMode = (value: string | null | undefined): ClaudeInChromeMode => value === 'on' || value === 'off' ? value : 'auto'
