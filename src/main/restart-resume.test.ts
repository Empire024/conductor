import { describe, expect, it } from 'vitest'
import { coworkerResumeMessage, encodeRestartIntent, restartLine, mayInstallOnQuit, parseRestartIntent, RESTART_INTENT_MAX_AGE_MS, resumePlan, restartReason, watchChanged, wizardResumeMessage, workingSet, type RestartIntent, type RestartKind } from './restart-resume'

/* resume-after-any-restart: every restart kind brings back the wizards that were working or waiting
   on their coworkers, tells each "Conductor restarted (<reason>, <old> -> <new>); continue." and
   resumes the coworkers whose turns were cut. "Stop work" in the quit dialog resumes nobody. */

const now = new Date('2026-09-25T18:00:00.000Z')
const minutesAgo = (minutes: number): string => new Date(now.getTime() - minutes * 60_000).toISOString()
const intent = (kind: RestartKind, extra: Partial<RestartIntent> = {}): RestartIntent => ({ kind, fromVersion: '0.1.52', at: minutesAgo(1), resume: true, wizards: ['wizard'], coworkers: ['worker-a'], ...extra })
const roundTrip = (value: RestartIntent): RestartIntent | null => parseRestartIntent(encodeRestartIntent(value), now)

describe('working set', () => {
  const candidates = [
    { id: 'working-wizard', wizard: true, working: true },
    { id: 'waiting-wizard', wizard: true, working: false },
    { id: 'idle-wizard', wizard: true, working: false },
    { id: 'plain-tab', wizard: false, working: true },
    { id: 'worker-a', wizard: false, working: true, controller: 'waiting-wizard' },
    { id: 'worker-b', wizard: false, working: false, controller: 'waiting-wizard' },
    { id: 'worker-c', wizard: false, working: true, controller: 'plain-tab' },
    { id: 'idle-worker', wizard: false, working: false, controller: 'idle-wizard' }
  ]
  it('takes working wizards, wizards waiting on a working coworker, and only those coworkers that were working', () => {
    expect(workingSet(candidates)).toEqual({ wizards: ['working-wizard', 'waiting-wizard'], coworkers: ['worker-a'] })
  })
  it('is empty when nothing runs', () => {
    expect(workingSet(candidates.map(candidate => ({ ...candidate, working: false })))).toEqual({ wizards: [], coworkers: [] })
  })
})

describe('restart intent record', () => {
  it.each<RestartKind>(['running', 'quit', 'update-on-quit', 'update-install', 'restart'])('round-trips a %s record', kind => {
    expect(roundTrip(intent(kind, { toVersion: '0.1.53' }))).toEqual(intent(kind, { toVersion: '0.1.53' }))
  })
  it('ignores stale, future, malformed and empty records', () => {
    expect(roundTrip(intent('quit', { at: new Date(now.getTime() - RESTART_INTENT_MAX_AGE_MS - 1).toISOString() }))).toBeNull()
    expect(roundTrip(intent('quit', { at: new Date(now.getTime() + 60_000).toISOString() }))).toBeNull()
    expect(parseRestartIntent('{"kind":"reboot"}', now)).toBeNull()
    expect(parseRestartIntent(JSON.stringify({ ...intent('quit'), wizards: [''] }), now)).toBeNull()
    expect(parseRestartIntent('not json', now)).toBeNull()
    expect(parseRestartIntent('', now)).toBeNull()
    expect(parseRestartIntent(null, now)).toBeNull()
  })
  it('the live record is rewritten when the working set changes or it is ten minutes old', () => {
    const live = intent('running', { at: minutesAgo(5) })
    expect(watchChanged(null, live)).toBe(true)
    expect(watchChanged(live, { ...live, at: minutesAgo(4) })).toBe(false)
    expect(watchChanged(live, { ...live, at: minutesAgo(4), coworkers: [] })).toBe(true)
    expect(watchChanged(live, { ...live, at: new Date(now.getTime() + 5 * 60_000).toISOString() })).toBe(true)
  })
})

describe('resume plan for each restart kind', () => {
  const reasons: Array<[RestartKind, RegExp]> = [
    ['update-on-quit', /update installed on quit/],
    ['update-install', /^update installed$/],
    ['running', /crash relaunch/],
    ['quit', /owner quit and reopened/],
    ['restart', /^restart$/]
  ]
  it.each(reasons)('%s brings back the working wizard and its cut coworkers', (kind, reason) => {
    const plan = resumePlan(intent(kind, { toVersion: '0.1.53' }), null)
    expect(plan).toMatchObject({ wizards: ['wizard'], coworkers: ['worker-a'], fromVersion: '0.1.52' })
    expect(plan!.reason).toMatch(reason)
    expect(wizardResumeMessage(plan!, '0.1.53', 1)).toMatch(/^\[Conductor\] Conductor restarted \(.+, 0\.1\.52 -> 0\.1\.53\); continue\. This wizard tab was brought back and 1 coworker whose turn was cut was resumed too\./)
    expect(coworkerResumeMessage(plan!, '0.1.53')).toMatch(/^\[Conductor\] Conductor restarted \(.+, 0\.1\.52 -> 0\.1\.53\); continue\./)
  })
  it('"Stop work" in the quit dialog resumes nobody', () => {
    expect(resumePlan(intent('quit', { resume: false }), null)).toBeNull()
    expect(resumePlan(intent('update-on-quit', { resume: false }), null)).toBeNull()
  })
  it('a restart with nothing working resumes nobody', () => {
    expect(resumePlan(intent('restart', { wizards: [], coworkers: [] }), null)).toBeNull()
    expect(resumePlan(null, null)).toBeNull()
  })
  it('a wizard that started the restart comes back once, even if it was idle, alongside the working ones', () => {
    const initiator = { agentSessionId: 'self', method: 'app.restart' as const, at: minutesAgo(1) }
    expect(resumePlan(intent('restart'), initiator)).toMatchObject({ wizards: ['self', 'wizard'], coworkers: ['worker-a'], reason: 'app.restart by this wizard' })
    expect(resumePlan(intent('restart', { wizards: ['self'] }), initiator)!.wizards).toEqual(['self'])
    expect(resumePlan(null, initiator)).toMatchObject({ wizards: ['self'], coworkers: [] })
    expect(resumePlan(null, initiator)).not.toHaveProperty('fromVersion')
  })
  it('a requested restart still brings its wizard back when the owner stopped the work', () => {
    const request = { agentSessionId: 'asker', method: 'app.restart.request' as const, at: minutesAgo(30) }
    expect(resumePlan(intent('quit', { resume: false }), request)).toMatchObject({ wizards: ['asker'], coworkers: [] })
    expect(restartReason(null, request)).toMatch(/asked the owner for/)
  })
  it('without coworkers the wizard message does not mention any', () => {
    const plan = resumePlan(intent('quit', { coworkers: [] }), null)!
    expect(wizardResumeMessage(plan, '0.1.52', 0)).toBe('[Conductor] Conductor restarted (the owner quit and reopened Conductor, 0.1.52 -> 0.1.52); continue. This wizard tab was brought back. Check app.state and agents.list first, then carry on from where you left off.')
    expect(wizardResumeMessage(plan, '0.1.52', 2)).toContain('2 coworkers whose turns were cut were resumed too')
  })
})

describe('the versions a restart names', () => {
  it('names the version the quitting process recorded, not the one that reads it after the update', () => {
    // 0.1.53 installs a local build on a wizard's app.update.install and records itself on the way out.
    const initiator = { agentSessionId: 'wizard', method: 'app.update.install' as const, at: minutesAgo(1) }
    const recorded = roundTrip(intent('update-install', { fromVersion: '0.1.53', toVersion: '0.1.54-local.7' }))
    const plan = resumePlan(recorded, initiator)!
    expect(plan.fromVersion).toBe('0.1.53')
    expect(wizardResumeMessage(plan, '0.1.54-local.7', 0)).toContain('Conductor restarted (update installed by this wizard, 0.1.53 -> 0.1.54-local.7); continue.')
    expect(coworkerResumeMessage(plan, '0.1.54-local.7')).toContain('0.1.53 -> 0.1.54-local.7')
  })
  it('never claims new -> new when the previous process left no record of its version', () => {
    const initiator = { agentSessionId: 'wizard', method: 'app.update.install' as const, at: minutesAgo(1) }
    const plan = resumePlan(null, initiator)!
    expect(wizardResumeMessage(plan, '0.1.54-local.7', 0)).toContain('Conductor restarted (update installed by this wizard, now 0.1.54-local.7); continue.')
    expect(restartLine('restart', undefined, '0.1.54')).toBe('Conductor restarted (restart, now 0.1.54)')
    expect(restartLine('restart', '0.1.54', '0.1.54')).toBe('Conductor restarted (restart, 0.1.54 -> 0.1.54)')
  })
})

describe('install on quit', () => {
  it('waits while work the owner was not asked about would be cut', () => {
    expect(mayInstallOnQuit({ updateReady: true, unkeptWork: true, ownerAnswered: false })).toBe(false)
  })
  it('installs when idle, when the owner answered the quit dialog, or when there is no update', () => {
    expect(mayInstallOnQuit({ updateReady: true, unkeptWork: false, ownerAnswered: false })).toBe(true)
    expect(mayInstallOnQuit({ updateReady: true, unkeptWork: true, ownerAnswered: true })).toBe(true)
    expect(mayInstallOnQuit({ updateReady: false, unkeptWork: true, ownerAnswered: false })).toBe(true)
  })
})
