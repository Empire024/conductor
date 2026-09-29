import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTROL_IDS } from '../../shared/production'
import { controlsInvalidatedBy } from './registry'
import { OWNER } from './store'
import { ENV_ID, fingerprint, seedProfile, tempStore, type TempStore } from './testkit'
import { CONDUCTOR_ACTOR, DUPLICATE_WINDOW_MS, controlsFor, requestRun, stepsFor, trigger } from './triggers'

let temp: TempStore
let now = new Date('2026-09-29T10:00:00.000Z')
beforeEach(() => { now = new Date('2026-09-29T10:00:00.000Z'); temp = tempStore(() => now); seedProfile(temp.store) })
afterEach(() => temp.close())

const owner = { kind: 'owner' as const, agentSessionId: null, title: 'Owner' }
const deps = () => ({ store: temp.store, userData: temp.dir, now: () => now })

describe('run triggers', () => {
  it('creates an audit with every step and all sixteen controls, artifacts under production-audits/<project>/<run>', () => {
    const outcome = requestRun(deps(), { projectId: 'project-a', environmentId: ENV_ID, kind: 'audit', trigger: trigger('manual', owner, now, 'Audit'), fingerprint: fingerprint() })
    expect(outcome.outcome).toBe('created')
    if (outcome.outcome !== 'created') return
    expect(outcome.run.controls).toEqual([...CONTROL_IDS])
    expect(outcome.run.steps.map(step => step.kind).filter(kind => kind !== 'control')).toEqual(['discovery', 'fingerprint', 'legal-sources', 'engineering-smokes', 'interpretation', 'report'])
    expect(outcome.run.artifactsDir.replace(/\\/g, '/')).toMatch(/production-audits\/project-a\/prun_/)
  })

  it('coalesces any number of triggers into one rerunRequested on the active run (latest wins, changes merged)', () => {
    const first = requestRun(deps(), { projectId: 'project-a', environmentId: ENV_ID, kind: 'audit', trigger: trigger('manual', owner, now, 'Audit'), fingerprint: fingerprint() })
    const second = requestRun(deps(), { projectId: 'project-a', environmentId: ENV_ID, kind: 'audit', trigger: trigger('change', CONDUCTOR_ACTOR, now, 'git moved', ['code']), fingerprint: fingerprint({ commit: 'b' }) })
    const third = requestRun(deps(), { projectId: 'project-a', environmentId: ENV_ID, kind: 'audit', trigger: trigger('change', CONDUCTOR_ACTOR, now, 'lock file', ['dependency']), fingerprint: fingerprint({ commit: 'b' }) })
    expect(second.outcome).toBe('coalesced')
    expect(third.outcome).toBe('coalesced')
    expect(temp.store.runs('project-a')).toHaveLength(1)
    const active = temp.store.run(first.run!.id)
    expect(active.rerunRequested).toMatchObject({ kind: 'change', detail: 'lock file', changes: ['code', 'dependency'] })
    // When the active run ends, exactly one follow-up can be taken.
    temp.store.transition(active.id, 'cancelled', 'test', OWNER)
    expect(temp.store.takeRerun(active.id)).toMatchObject({ changes: ['code', 'dependency'] })
    expect(temp.store.takeRerun(active.id)).toBeNull()
  })

  it('a change run carries only the controls its changes invalidate; full or profile changes carry all', () => {
    const code = controlsFor({ kind: 'audit', trigger: trigger('change', CONDUCTOR_ACTOR, now, '', ['code']) })
    expect(code).toEqual(CONTROL_IDS.filter(id => controlsInvalidatedBy(['code']).includes(id)))
    const policy = controlsFor({ kind: 'audit', trigger: trigger('change', CONDUCTOR_ACTOR, now, '', ['policy']) })
    expect(policy.length).toBeLessThan(16)
    expect(policy).not.toEqual(code)
    expect(controlsFor({ kind: 'audit', trigger: trigger('change', CONDUCTOR_ACTOR, now, '', ['policy']), full: true })).toHaveLength(16)
    expect(controlsFor({ kind: 'audit', trigger: trigger('change', CONDUCTOR_ACTOR, now, '', ['profile']) })).toHaveLength(16)
    expect(controlsFor({ kind: 'audit', trigger: trigger('drift', CONDUCTOR_ACTOR, now, '', ['policy']) })).toEqual(policy)
    const created = requestRun(deps(), { projectId: 'project-a', environmentId: ENV_ID, kind: 'audit', trigger: trigger('change', CONDUCTOR_ACTOR, now, '', ['policy']), fingerprint: fingerprint() })
    expect(created.run!.controls).toEqual(policy)
  })

  it('drops an automatic trigger on an unchanged target within ten minutes of the last completed run, never the owner\'s own', () => {
    const first = requestRun(deps(), { projectId: 'project-a', environmentId: ENV_ID, kind: 'audit', trigger: trigger('manual', owner, now, 'Audit'), fingerprint: fingerprint() })
    temp.store.transition(first.run!.id, 'running', 'test', OWNER)
    temp.store.transition(first.run!.id, 'completed', 'test', OWNER)
    const drift = requestRun(deps(), { projectId: 'project-a', environmentId: ENV_ID, kind: 'drift', trigger: trigger('drift', CONDUCTOR_ACTOR, now, '', []), fingerprint: fingerprint() })
    expect(drift).toMatchObject({ outcome: 'dropped', reason: expect.stringMatching(/unchanged since run .* dropped as a duplicate/) })
    const manual = requestRun(deps(), { projectId: 'project-a', environmentId: ENV_ID, kind: 'audit', trigger: trigger('manual', owner, now, 'Audit'), fingerprint: fingerprint() })
    expect(manual.outcome).toBe('created')
    temp.store.transition(manual.run!.id, 'cancelled', 'test', OWNER)
    now = new Date(now.getTime() + DUPLICATE_WINDOW_MS + 1_000)
    expect(requestRun(deps(), { projectId: 'project-a', environmentId: ENV_ID, kind: 'drift', trigger: trigger('drift', CONDUCTOR_ACTOR, now, '', []), fingerprint: fingerprint() }).outcome).toBe('created')
  })

  it('verify and retest runs need findings of the same environment; verify has no interpretation or legal step', () => {
    expect(() => requestRun(deps(), { projectId: 'project-a', environmentId: ENV_ID, kind: 'verify', trigger: trigger('verify', owner, now, ''), fingerprint: fingerprint(), findingIds: ['pf_nope'] })).toThrow(/needs findings/)
    expect(stepsFor('verify', ['C03']).map(step => step.kind)).toEqual(['discovery', 'fingerprint', 'control', 'report'])
    expect(stepsFor('retest', ['C03']).map(step => step.kind)).toEqual(['discovery', 'fingerprint', 'control', 'interpretation', 'report'])
  })
})
