/** Installation policy is owned by the main process, never by conversation settings. */
export interface ClaudeFullAutoState {
  enabled: boolean
  authorizedAt?: string
  changedAt?: string
  applying: boolean
  error?: string
}

export interface ClaudeFullAutoBridge {
  state(): Promise<ClaudeFullAutoState>
  setEnabled(enabled: boolean): Promise<ClaudeFullAutoState>
  onChanged(callback: (state: ClaudeFullAutoState) => void): () => void
}

export const CLAUDE_FULL_AUTO_ACTION = "Enable Full Auto for Conductor's Claude workers"
export const CLAUDE_FULL_AUTO_EXPLANATION = "Authorize current and future Claude sessions using Conductor Auto in this installation to use bypassPermissions. Claude's tool-permission classifier is not used in this mode. The process can execute commands, change or delete files, and use available credentials and services within its actual OS access. A workspace label is not a filesystem sandbox. Manual, Plan, and explicitly Guarded Auto sessions keep their selected mode. Provider managed restrictions still apply."
