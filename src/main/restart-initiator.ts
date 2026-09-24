export const RESTART_INITIATOR_KEY = 'restartInitiator'
export const RESTART_INITIATOR_MAX_AGE_MS = 15 * 60_000
export type RestartInitiator = { agentSessionId: string; method: 'app.restart' | 'app.update.install'; at: string }

export function encodeRestartInitiator(initiator: RestartInitiator | undefined): string {
  return initiator ? JSON.stringify(initiator) : ''
}

export function takeRestartInitiator(raw: string | null | undefined, now: Date): RestartInitiator | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const candidate = value as Partial<RestartInitiator>
    if (typeof candidate.agentSessionId !== 'string' || !candidate.agentSessionId.trim() || !['app.restart', 'app.update.install'].includes(candidate.method ?? '') || typeof candidate.at !== 'string') return null
    const age = now.getTime() - Date.parse(candidate.at)
    if (!Number.isFinite(age) || age < 0 || age > RESTART_INITIATOR_MAX_AGE_MS) return null
    return { agentSessionId: candidate.agentSessionId, method: candidate.method!, at: candidate.at }
  } catch { return null }
}

export function wizardTabsToResume<T extends { resourceId?: string }>(tabs: T[], initiator: RestartInitiator | null): T[] {
  return initiator ? tabs.filter(tab => tab.resourceId === initiator.agentSessionId) : []
}
