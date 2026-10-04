import { afterEach, describe, expect, it, vi } from 'vitest'
import { authExpiredMessage, isAuthFailureMessage, outageAlert, ProviderAuthMonitor, resumeMessage, type AuthOutage, type AuthOutageTab, type AuthProbeResult, type AuthProvider, type AuthResumeResult } from './provider-auth'

afterEach(() => { vi.useRealTimers() })

describe('recognizing a lost provider login', () => {
  it('matches what the Claude and Codex CLIs say when their login is gone', () => {
    for (const text of [
      'Failed to authenticate: OAuth session expired and could not be refreshed',
      'Not logged in · Please run /login',
      'Login expired · Please run /login',
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
      'Invalid API key · Please run /login',
      'unexpected status 401 Unauthorized: Your access token could not be refreshed'
    ]) expect(isAuthFailureMessage(text), text).toBe(true)
  })

  it('leaves usage limits, overloads and ordinary failures alone', () => {
    for (const text of [
      "You've hit your session limit · resets in 2 hours",
      'API Error: 529 overloaded_error',
      'API Error: 500 Internal server error',
      'Claude turn failed',
      'Tool permission request failed: refused by policy'
    ]) expect(isAuthFailureMessage(text), text).toBe(false)
  })

  it('names the exact fix in the recorded error and the alert', () => {
    expect(authExpiredMessage('claude', 'Failed to authenticate')).toMatch(/^Claude login expired: tap Log in on the phone or in Settings > Runtimes, or run `claude auth login`/)
    expect(authExpiredMessage('codex', '401')).toMatch(/^Codex login expired: tap Log in on the phone or in Settings > Runtimes, or run `codex login`/)
    const alert = outageAlert({ provider: 'claude', since: '2026-10-01T08:38:49.074Z', message: 'Failed to authenticate', alertedAt: null, tabs: [
      { id: 'a', title: 'Worker', wizard: false, failedAt: '2026-10-01T08:40:00.000Z' },
      { id: 'w', title: 'Wizard', wizard: true, failedAt: '2026-10-01T08:38:49.074Z' }
    ] })
    expect(alert.title).toBe('Claude login expired')
    expect(alert.body).toContain('`claude auth login`')
    expect(alert.body).toContain('wizard "Wizard"')
    expect(resumeMessage('claude', 'T1', 'T2')).toMatch(/expired at T1 and was restored at T2.*timers.*re-arm/s)
  })
})

/** A monitor on fake timers with a scripted probe. */
function harness(options: { stamp?: string | null; loggedIn?: boolean; restore?: AuthOutage[] } = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-01T08:38:49.000Z'))
  const probe = { loggedIn: options.loggedIn ?? false, stamp: options.stamp === undefined ? 'mtime-1' : options.stamp, calls: 0, fail: false }
  const alerts: Array<{ title: string; body: string }> = []
  const resumed: Array<{ tab: AuthOutageTab; message: string }> = []
  const persisted = new Map<AuthProvider, AuthOutage | null>()
  let outcome: (tab: AuthOutageTab) => AuthResumeResult = () => 'sent'
  const monitor = new ProviderAuthMonitor({
    probe: async (): Promise<AuthProbeResult> => { probe.calls++; if (probe.fail) throw new Error('no CLI'); return { loggedIn: probe.loggedIn, stamp: probe.stamp } },
    alert: (_outage, text) => { alerts.push(text) },
    resume: async (tab, message) => { resumed.push({ tab, message }); return outcome(tab) },
    persist: (provider, outage) => { persisted.set(provider, outage ? JSON.parse(JSON.stringify(outage)) as AuthOutage : null) },
    restore: () => options.restore ?? [],
    intervalMs: 180_000, blindRetryMs: 1_800_000, relapseMs: 900_000
  })
  return { monitor, probe, alerts, resumed, persisted, setOutcome(next: typeof outcome) { outcome = next } }
}

describe('ProviderAuthMonitor', () => {
  it('raises one alert per provider outage, however many tabs fail on it', async () => {
    const h = harness()
    expect(h.monitor.noteFailure('claude', { id: 'worker', title: 'Worker', wizard: false }, 'Failed to authenticate')).toBe(true)
    expect(h.monitor.noteFailure('claude', { id: 'wizard', title: 'Wizard', wizard: true }, 'Failed to authenticate')).toBe(false)
    expect(h.monitor.noteFailure('claude', { id: 'worker', title: 'Worker', wizard: false }, 'Failed to authenticate')).toBe(false)
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]!.body).toContain('`claude auth login`')
    expect(h.monitor.status()[0]!.tabs.map(tab => tab.id)).toEqual(['worker', 'wizard'])
    // Another provider's outage is its own.
    expect(h.monitor.noteFailure('codex', { id: 'codex-tab', title: 'Codex', wizard: false }, '401')).toBe(true)
    expect(h.alerts).toHaveLength(2)
    expect(h.persisted.get('claude')?.tabs).toHaveLength(2)
    h.monitor.dispose()
  })

  it('probes on an interval and resumes nothing while the login is still gone or the credentials unchanged', async () => {
    const h = harness({ loggedIn: false })
    h.monitor.noteFailure('claude', { id: 'worker', title: 'Worker', wizard: false }, 'Failed to authenticate')
    await vi.advanceTimersByTimeAsync(180_000 * 3)
    expect(h.probe.calls).toBeGreaterThanOrEqual(3)
    // A CLI whose refresh token was refused still says it is logged in: not enough on its own.
    h.probe.loggedIn = true
    await vi.advanceTimersByTimeAsync(180_000 * 3)
    expect(h.resumed).toHaveLength(0)
    expect(h.monitor.status()).toHaveLength(1)
    h.monitor.dispose()
  })

  it('resumes every stopped tab once the login is back, wizards first, with the outage times', async () => {
    const h = harness({ loggedIn: false })
    h.monitor.noteFailure('claude', { id: 'worker', title: 'Worker', wizard: false }, 'Failed to authenticate')
    await vi.advanceTimersByTimeAsync(60_000)
    h.monitor.noteFailure('claude', { id: 'wizard', title: 'Wizard', wizard: true }, 'Failed to authenticate')
    await vi.advanceTimersByTimeAsync(180_000)
    expect(h.resumed).toHaveLength(0)
    // The owner logs in again: the credentials file is rewritten.
    h.probe.loggedIn = true; h.probe.stamp = 'mtime-2'
    await vi.advanceTimersByTimeAsync(180_000)
    expect(h.resumed.map(entry => entry.tab.id)).toEqual(['wizard', 'worker'])
    expect(h.resumed[1]!.message).toContain('expired at 2026-10-01T08:38:49.000Z')
    expect(h.resumed[0]!.message).toContain('expired at 2026-10-01T08:39:49.000Z')
    expect(h.resumed[0]!.message).toMatch(/restored at 2026-10-01T08:4\d/)
    expect(h.monitor.status()).toHaveLength(0)
    expect(h.persisted.get('claude')).toBeNull()
    // Nothing more is probed or resumed once it is over.
    const calls = h.probe.calls
    await vi.advanceTimersByTimeAsync(180_000 * 4)
    expect(h.probe.calls).toBe(calls)
    expect(h.resumed).toHaveLength(2)
    h.monitor.dispose()
  })

  it('a tab failing again right after the resume reopens the same outage without a second alert', async () => {
    const h = harness({ loggedIn: false })
    h.monitor.noteFailure('claude', { id: 'wizard', title: 'Wizard', wizard: true }, 'Failed to authenticate')
    await vi.advanceTimersByTimeAsync(1)
    h.probe.loggedIn = true; h.probe.stamp = 'mtime-2'
    await vi.advanceTimersByTimeAsync(180_000)
    expect(h.resumed).toHaveLength(1)
    expect(h.monitor.noteFailure('claude', { id: 'wizard', title: 'Wizard', wizard: true }, 'Failed to authenticate')).toBe(false)
    expect(h.alerts).toHaveLength(1)
    // It waits for the next rewrite of the credentials, not the one it already used.
    await vi.advanceTimersByTimeAsync(180_000 * 2)
    expect(h.resumed).toHaveLength(1)
    h.probe.stamp = 'mtime-3'
    await vi.advanceTimersByTimeAsync(180_000)
    expect(h.resumed).toHaveLength(2)
    // A failure long after the relapse window is a new outage with its own alert.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(h.monitor.noteFailure('claude', { id: 'wizard', title: 'Wizard', wizard: true }, 'Failed to authenticate')).toBe(true)
    expect(h.alerts).toHaveLength(2)
    h.monitor.dispose()
  })

  it('without a credentials stamp it trusts the probe at most once per blind-retry window', async () => {
    const h = harness({ loggedIn: true, stamp: null })
    h.monitor.noteFailure('claude', { id: 'worker', title: 'Worker', wizard: false }, 'Failed to authenticate')
    await vi.advanceTimersByTimeAsync(180_000)
    expect(h.resumed).toHaveLength(1)
    h.monitor.noteFailure('claude', { id: 'worker', title: 'Worker', wizard: false }, 'Failed to authenticate')
    await vi.advanceTimersByTimeAsync(180_000 * 3)
    expect(h.resumed).toHaveLength(1)
    h.monitor.dispose()
  })

  it('keeps probing an outage restored from before a restart', async () => {
    const h = harness({ loggedIn: true, stamp: 'mtime-2', restore: [{ provider: 'claude', since: '2026-10-01T08:38:49.000Z', message: 'Failed to authenticate', alertedAt: '2026-10-01T08:38:49.000Z', baseline: 'mtime-1', tabs: [{ id: 'wizard', title: 'Wizard', wizard: true, failedAt: '2026-10-01T08:38:49.000Z' }] }] })
    await vi.advanceTimersByTimeAsync(180_000)
    expect(h.resumed.map(entry => entry.tab.id)).toEqual(['wizard'])
    expect(h.alerts).toHaveLength(0)
    h.monitor.dispose()
  })

  it('a probe that cannot run never counts as the login coming back', async () => {
    const h = harness({ loggedIn: true, stamp: 'mtime-2' })
    h.probe.fail = true
    h.monitor.noteFailure('claude', { id: 'worker', title: 'Worker', wizard: false }, 'Failed to authenticate')
    await vi.advanceTimersByTimeAsync(180_000 * 2)
    expect(h.resumed).toHaveLength(0)
    // The first probe that runs sets the baseline; only a later rewrite resumes.
    h.probe.fail = false
    await vi.advanceTimersByTimeAsync(180_000)
    expect(h.resumed).toHaveLength(0)
    h.probe.stamp = 'mtime-3'
    await vi.advanceTimersByTimeAsync(180_000)
    expect(h.resumed).toHaveLength(1)
    h.monitor.dispose()
  })

  it('a refused long-lived token is its own alert, and the normal login is tried once without a rewrite', async () => {
    const h = harness({ loggedIn: true, stamp: 'mtime-1' })
    h.monitor.noteFailure('claude', { id: 'worker', title: 'Worker', wizard: false }, 'API Error: 401 authentication_error', { source: 'token' })
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]!.title).toBe('Claude long-lived token rejected')
    expect(h.alerts[0]!.body).toMatch(/stopped using it and falls back to the normal Claude login/)
    expect(h.monitor.status()[0]!.source).toBe('token')
    // The first check only takes the baseline stamp; the next one resumes on the fallback.
    await vi.advanceTimersByTimeAsync(180_000)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(h.resumed.map(entry => entry.tab.id)).toEqual(['worker'])
    h.monitor.dispose()
  })

  it('a login through Conductor resumes at once on one logged-in probe, and the alert result is kept', async () => {
    const h = harness({ loggedIn: false, stamp: 'mtime-1' })
    h.monitor.noteFailure('claude', { id: 'worker', title: 'Worker', wizard: false }, 'Failed to authenticate')
    expect(await h.monitor.loginRestored('claude')).toBe(false)
    h.probe.loggedIn = true
    expect(await h.monitor.loginRestored('claude')).toBe(true)
    expect(h.resumed.map(entry => entry.tab.id)).toEqual(['worker'])
    expect(await h.monitor.loginRestored('claude')).toBe(false)
    h.monitor.dispose()
  })

  it('records what the alert reported on the persisted outage', async () => {
    vi.useFakeTimers()
    const persisted: Array<AuthOutage | null> = []
    const closed: Array<AuthOutage & { restoredAt: string }> = []
    let loggedIn = false
    const monitor = new ProviderAuthMonitor({
      probe: async () => ({ loggedIn, stamp: 'mtime-1' }),
      alert: async () => 'desktop: toast shown; phone: pushed to 1 phone; 0 open phone streams',
      resume: async () => 'sent',
      persist: (_provider, outage) => { persisted.push(outage ? JSON.parse(JSON.stringify(outage)) as AuthOutage : null) },
      closed: outage => { closed.push(outage) }
    })
    monitor.noteFailure('claude', { id: 'worker', title: 'Worker', wizard: false }, 'Failed to authenticate')
    await vi.advanceTimersByTimeAsync(0)
    expect(monitor.status()[0]!.alertResult).toBe('desktop: toast shown; phone: pushed to 1 phone; 0 open phone streams')
    expect(persisted.at(-1)?.alertResult).toContain('pushed to 1 phone')
    // Once the login is back the open outage is cleared, and the closed one is kept as evidence.
    loggedIn = true
    expect(await monitor.loginRestored('claude')).toBe(true)
    expect(persisted.at(-1)).toBeNull()
    expect(closed).toEqual([expect.objectContaining({ provider: 'claude', alertResult: expect.stringContaining('pushed to 1 phone'), restoredAt: expect.any(String) })])
    monitor.dispose()
  })
})
