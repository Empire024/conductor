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

export const AGENT_CONTROL_GRANTS_CHANGED = 'conductor:agent-control-grants-changed'

export interface AgentControlGrantsChange {
  agentSessionId: string
  repository: boolean
  research: boolean
}

/** Emitted after main has durably saved a local conversation's grants through agents.grant, so
 * the composer toggles of that one tab follow without a remount. */
export function announceAgentControlGrants(change: AgentControlGrantsChange): void {
  window.dispatchEvent(new CustomEvent<AgentControlGrantsChange>(AGENT_CONTROL_GRANTS_CHANGED, { detail: change }))
}

export function onAgentControlGrants(agentSessionId: string, apply: (change: Pick<AgentControlGrantsChange, 'repository' | 'research'>) => void): () => void {
  const listener = (event: Event): void => {
    const change = (event as CustomEvent<AgentControlGrantsChange>).detail
    if (change?.agentSessionId === agentSessionId) apply({ repository: change.repository, research: change.research })
  }
  window.addEventListener(AGENT_CONTROL_GRANTS_CHANGED, listener)
  return () => window.removeEventListener(AGENT_CONTROL_GRANTS_CHANGED, listener)
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
