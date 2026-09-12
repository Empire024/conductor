export const AGENT_CONTROL_SETTINGS_CHANGED = 'conductor:agent-control-settings-changed'

export interface AgentControlSettingsChange {
  agentSessionId: string
  model: string
  effort?: string
}

/** Emitted only after main has durably accepted agents.configure. Layout preparation and rollback
 * never emit it, so pane-local state cannot briefly adopt a failed control request. */
export function announceAgentControlSettings(change: AgentControlSettingsChange): void {
  window.dispatchEvent(new CustomEvent<AgentControlSettingsChange>(AGENT_CONTROL_SETTINGS_CHANGED, { detail: change }))
}

/** One-hook pane integration: updates only model/effort for the exact mounted conversation. */
export function onAgentControlSettings(agentSessionId: string, apply: (change: Pick<AgentControlSettingsChange, 'model' | 'effort'>) => void): () => void {
  const listener = (event: Event): void => {
    const change = (event as CustomEvent<AgentControlSettingsChange>).detail
    if (change?.agentSessionId === agentSessionId) apply({ model: change.model, effort: change.effort })
  }
  window.addEventListener(AGENT_CONTROL_SETTINGS_CHANGED, listener)
  return () => window.removeEventListener(AGENT_CONTROL_SETTINGS_CHANGED, listener)
}
