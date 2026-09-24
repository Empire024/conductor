export const RESTART_INITIATOR_KEY = 'restartInitiator'
export const RESTART_INITIATOR_MAX_AGE_MS = 15 * 60_000
/** `app.restart.request` is not a restart: it is a wizard asking the owner for one (see RestartRequest). */
export type RestartInitiator = { agentSessionId: string; method: 'app.restart' | 'app.update.install' | 'app.restart.request'; at: string }

export function encodeRestartInitiator(initiator: RestartInitiator | undefined): string {
  return initiator ? JSON.stringify(initiator) : ''
}

const ageOf = (at: unknown, now: Date): number => typeof at === 'string' ? now.getTime() - Date.parse(at) : NaN
const fresh = (at: unknown, now: Date, maxAge: number): boolean => { const age = ageOf(at, now); return Number.isFinite(age) && age >= 0 && age <= maxAge }

export function takeRestartInitiator(raw: string | null | undefined, now: Date): RestartInitiator | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const candidate = value as Partial<RestartInitiator>
    if (typeof candidate.agentSessionId !== 'string' || !candidate.agentSessionId.trim() || !['app.restart', 'app.update.install'].includes(candidate.method ?? '') || typeof candidate.at !== 'string') return null
    if (!fresh(candidate.at, now, RESTART_INITIATOR_MAX_AGE_MS)) return null
    return { agentSessionId: candidate.agentSessionId, method: candidate.method!, at: candidate.at }
  } catch { return null }
}

/* A wizard that cannot restart Conductor itself (app.restart.request) leaves this for the owner.
 * It is shown on the owner's Restart to update control, and the next launch, however the owner
 * restarted, brings that wizard back like a self-started restart. It is consumed by that launch
 * and lapses after a day. */
export const RESTART_REQUEST_KEY = 'restartRequest'
export const RESTART_REQUEST_MAX_AGE_MS = 24 * 60 * 60_000
export type RestartRequest = { agentSessionId: string; title: string; reason: string; at: string }

export function encodeRestartRequest(request: RestartRequest | null | undefined): string {
  return request ? JSON.stringify(request) : ''
}

export function parseRestartRequest(raw: string | null | undefined, now: Date): RestartRequest | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const { agentSessionId, title, reason, at } = value as Partial<RestartRequest>
    if (typeof agentSessionId !== 'string' || !agentSessionId.trim() || typeof title !== 'string' || typeof reason !== 'string' || typeof at !== 'string') return null
    return fresh(at, now, RESTART_REQUEST_MAX_AGE_MS) ? { agentSessionId, title, reason, at } : null
  } catch { return null }
}

/** Whose wizard tab this launch brings back: the one that restarted Conductor itself, else the one
 *  that asked the owner to. Null for any other restart. */
export function launchRestartInitiator(rawInitiator: string | null | undefined, rawRequest: string | null | undefined, now: Date): RestartInitiator | null {
  const own = takeRestartInitiator(rawInitiator, now)
  if (own) return own
  const request = parseRestartRequest(rawRequest, now)
  return request ? { agentSessionId: request.agentSessionId, method: 'app.restart.request', at: request.at } : null
}

export function wizardTabsToResume<T extends { resourceId?: string }>(tabs: T[], initiator: RestartInitiator | null): T[] {
  return initiator ? tabs.filter(tab => tab.resourceId === initiator.agentSessionId) : []
}
