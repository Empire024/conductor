import { describe, expect, it } from 'vitest'
import { encodeRestartInitiator, encodeRestartRequest, launchRestartInitiator, parseRestartRequest, RESTART_INITIATOR_MAX_AGE_MS, RESTART_REQUEST_MAX_AGE_MS, takeRestartInitiator, wizardTabsToResume } from './restart-initiator'

/* B1 contract (conductor-task:988100e6). Only the wizard tab that started a restart is brought back
   and told to continue. The owner's own restart (Restart to update, the owner credential, the quit
   dialog) records no initiator and resumes no wizard tab. A stale initiator is ignored. */

const now = new Date('2026-09-24T18:00:00.000Z')
const minutesAgo = (minutes: number): string => new Date(now.getTime() - minutes * 60_000).toISOString()

describe('restart initiator', () => {
  it('a wizard-initiated restart round-trips and resumes only that tab', () => {
    const raw = encodeRestartInitiator({ agentSessionId: 'wizard-a', method: 'app.update.install', at: minutesAgo(2) })
    const initiator = takeRestartInitiator(raw, now)
    expect(initiator).toEqual({ agentSessionId: 'wizard-a', method: 'app.update.install', at: minutesAgo(2) })
    const tabs = [{ resourceId: 'wizard-a' }, { resourceId: 'wizard-b' }, { resourceId: undefined }]
    expect(wizardTabsToResume(tabs, initiator)).toEqual([{ resourceId: 'wizard-a' }])
  })

  it('an owner-initiated restart records nothing and resumes no wizard tab', () => {
    expect(encodeRestartInitiator(undefined)).toBe('')
    expect(takeRestartInitiator('', now)).toBeNull()
    expect(takeRestartInitiator(null, now)).toBeNull()
    expect(takeRestartInitiator(undefined, now)).toBeNull()
    expect(wizardTabsToResume([{ resourceId: 'wizard-a' }, { resourceId: 'wizard-b' }], null)).toEqual([])
  })

  it('ignores a stale or malformed initiator', () => {
    expect(RESTART_INITIATOR_MAX_AGE_MS).toBe(15 * 60_000)
    expect(takeRestartInitiator(encodeRestartInitiator({ agentSessionId: 'wizard-a', method: 'app.restart', at: minutesAgo(16) }), now)).toBeNull()
    expect(takeRestartInitiator(encodeRestartInitiator({ agentSessionId: 'wizard-a', method: 'app.restart', at: minutesAgo(14) }), now)).toMatchObject({ agentSessionId: 'wizard-a' })
    // A clock that moved backwards is not a fresh restart either.
    expect(takeRestartInitiator(encodeRestartInitiator({ agentSessionId: 'wizard-a', method: 'app.restart', at: minutesAgo(-5) }), now)).toBeNull()
    expect(takeRestartInitiator('not json', now)).toBeNull()
    expect(takeRestartInitiator(JSON.stringify({ agentSessionId: '', method: 'app.restart', at: minutesAgo(1) }), now)).toBeNull()
    expect(takeRestartInitiator(JSON.stringify({ agentSessionId: 'wizard-a', method: 'app.quit', at: minutesAgo(1) }), now)).toBeNull()
  })
})

/* conductor-task:wizard-restart-request. A wizard that cannot restart itself asks the owner with
   app.restart.request. The request lives until the next launch or 24 h; the launch after it resumes
   that wizard exactly like a self-started one, and a restart with no request still resumes none. */
describe('requested restart', () => {
  const request = { agentSessionId: 'wizard-a', title: 'Overnight wizard', reason: 'Install 0.1.54 to continue the batch', at: minutesAgo(60) }

  it('round-trips a request and resumes its wizard on the next launch', () => {
    const raw = encodeRestartRequest(request)
    expect(parseRestartRequest(raw, now)).toEqual(request)
    const initiator = launchRestartInitiator(encodeRestartInitiator(undefined), raw, now)
    expect(initiator).toEqual({ agentSessionId: 'wizard-a', method: 'app.restart.request', at: request.at })
    expect(wizardTabsToResume([{ resourceId: 'wizard-a' }, { resourceId: 'wizard-b' }], initiator)).toEqual([{ resourceId: 'wizard-a' }])
  })

  it('a self-started restart wins over a pending request', () => {
    const own = encodeRestartInitiator({ agentSessionId: 'wizard-b', method: 'app.restart', at: minutesAgo(1) })
    expect(launchRestartInitiator(own, encodeRestartRequest(request), now)).toMatchObject({ agentSessionId: 'wizard-b', method: 'app.restart' })
  })

  it('expires after 24 hours and ignores malformed requests', () => {
    expect(RESTART_REQUEST_MAX_AGE_MS).toBe(24 * 60 * 60_000)
    expect(parseRestartRequest(encodeRestartRequest({ ...request, at: minutesAgo(24 * 60 + 1) }), now)).toBeNull()
    expect(parseRestartRequest(encodeRestartRequest({ ...request, at: minutesAgo(-5) }), now)).toBeNull()
    expect(parseRestartRequest(JSON.stringify({ ...request, reason: 7 }), now)).toBeNull()
    expect(parseRestartRequest(encodeRestartRequest(null), now)).toBeNull()
    expect(launchRestartInitiator('', '', now)).toBeNull()
  })
})
