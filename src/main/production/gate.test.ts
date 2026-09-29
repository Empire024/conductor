import { describe, expect, it } from 'vitest'
import type { AuditRun, ControlId, ControlResult, ControlResultStatus, Finding, OwnerQuestion, Waiver } from '../../shared/production'
import { computeGate, controlStatus, gateSummary, type GateInput } from './gate'
import { emptyLedger } from './store'
import { ENV_ID, fingerprint } from './testkit'

const NOW = new Date('2026-09-29T12:00:00.000Z')

function run(id: string, status: AuditRun['status'], createdAt: string, overrides: Partial<AuditRun> = {}): AuditRun {
  return {
    id, projectId: 'p', kind: 'audit', environmentId: ENV_ID, trigger: { kind: 'manual', by: { kind: 'owner', agentSessionId: null, title: null }, at: createdAt, changes: [], detail: '' },
    parentRunId: null, verifies: [], fingerprint: fingerprint(), status, statusReason: status === 'failed' ? 'browser crashed' : status === 'blocked' ? 'intended operation unresolved' : null,
    controls: ['C03', 'C04', 'C13'], steps: [], checkpoint: { nextStepIndex: 0, doneStepIds: [], at: createdAt }, budget: { maxTokens: 1, maxModelCalls: 1, maxRequests: 1, maxDurationMs: 1, requestsPerSecondPerOrigin: 1, maxCostUsdPerCall: 1 },
    ledger: emptyLedger(), coverage: { tested: [], sampled: [], excluded: [], unobservable: [] }, artifactsDir: '', reportPaths: null, createdAt, startedAt: createdAt,
    finishedAt: ['completed', 'failed', 'cancelled'].includes(status) ? createdAt : null, rerunRequested: null, ...overrides,
  }
}

function result(controlId: ControlId, status: ControlResultStatus, overrides: Partial<ControlResult> = {}): ControlResult {
  return {
    runId: 'r1', controlId, status, applicability: { status: status === 'NOT_APPLICABLE' ? 'not-applicable' : 'applicable', rationale: 'r', factsUsed: [], ruleIndex: null },
    rationale: `${controlId} ${status}`, evidence: [], findingIds: [], humanReview: [], checks: [], coverage: { tested: [], sampled: [], excluded: [], unobservable: [] }, provenance: [], ...overrides,
  }
}

function finding(id: string, controlId: ControlId, overrides: Partial<Finding> = {}): Finding {
  return {
    id, projectId: 'p', environmentId: ENV_ID, controlId, checkId: 'c', key: id, route: '/', component: null, scope: 'page', category: 'legal', severity: 'high', confidence: 'confirmed',
    title: `finding ${id}`, expected: '', observed: '', reproduction: [], evidence: [], proposedFix: '', owner: 'engineering', legal: null, sources: [],
    applicability: { status: 'applicable', rationale: '', factsUsed: [], ruleIndex: null }, status: 'open', verification: null, firstSeenRunId: 'r1', lastSeenRunId: 'r1',
    lastSeenFingerprint: fingerprint(), occurrences: 1, taskId: null, waiverId: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...overrides,
  }
}

function waiver(id: string, findingId: string, expiresAt: string, revokedAt: string | null = null): Waiver {
  return { id, projectId: 'p', findingId, reason: 'accepted risk', scope: 'site', owner: 'owner', grantedBy: { kind: 'owner', agentSessionId: null, title: null }, grantedAt: NOW.toISOString(), expiresAt, revokedAt, revokedReason: null }
}

const question = (status: OwnerQuestion['status'], blocks: ControlId[] = ['C08']): OwnerQuestion => ({ id: 'q', factKey: 'emailMarketing', question: 'Do you send marketing email?', why: '', blocksControls: blocks, status, answer: null, answeredAt: null, answeredBy: null, createdAt: NOW.toISOString() })

const completed = run('r1', 'completed', '2026-09-29T10:00:00.000Z')
const clean: ControlResult[] = [result('C03', 'PASS'), result('C04', 'PASS'), result('C13', 'NOT_APPLICABLE')]

function gate(overrides: Partial<GateInput>) {
  return computeGate({ projectId: 'p', environmentId: ENV_ID, runs: [completed], results: clean, findings: [], waivers: [], questions: [], currentFingerprint: fingerprint(), now: NOW, ...overrides })
}

describe('computeGate states', () => {
  it('NOT_AUDITED with no environment or no completed run', () => {
    expect(gate({ environmentId: null }).state).toBe('NOT_AUDITED')
    expect(gate({ runs: [] })).toMatchObject({ state: 'NOT_AUDITED', reasons: ['No audit of this environment has completed yet.'] })
  })

  it('AUDITING while a run is queued, running, paused or recovering, above everything else', () => {
    for (const status of ['queued', 'running', 'paused', 'recovering'] as const) {
      const result = gate({ runs: [run('r2', status, '2026-09-29T11:00:00.000Z'), completed], findings: [finding('f', 'C03')] })
      expect(result).toMatchObject({ state: 'AUDITING', runId: 'r2' })
    }
    expect(gate({ runs: [run('r0', 'running', '2026-09-29T09:00:00.000Z')] }).state).toBe('AUDITING')
  })

  it('NOT_AUDITED beats BLOCKED when nothing ever completed, and names the failure', () => {
    const result = gate({ runs: [run('r0', 'failed', '2026-09-29T09:00:00.000Z')] })
    expect(result.state).toBe('NOT_AUDITED')
    expect(result.reasons[1]).toMatch(/The last run r0 failed: browser crashed/)
  })

  it('BLOCKED when the newest run failed or is blocked after a completed one; a cancelled run is ignored', () => {
    expect(gate({ runs: [run('r2', 'failed', '2026-09-29T11:00:00.000Z'), completed] })).toMatchObject({ state: 'BLOCKED', runId: 'r2', reasons: ['Run r2 failed: browser crashed'] })
    expect(gate({ runs: [run('r2', 'blocked', '2026-09-29T11:00:00.000Z'), completed] }).reasons[0]).toMatch(/is blocked: intended operation unresolved/)
    expect(gate({ runs: [run('r2', 'cancelled', '2026-09-29T11:00:00.000Z'), completed] }).state).toBe('VERIFIED')
  })

  it('BLOCKED beats STALE and NEEDS_REVIEW', () => {
    const result = gate({ runs: [run('r2', 'failed', '2026-09-29T11:00:00.000Z'), completed], currentFingerprint: fingerprint({ commit: 'moved' }), findings: [finding('f', 'C03')] })
    expect(result.state).toBe('BLOCKED')
  })

  it('STALE when the target moved, listing only the controls the change invalidates', () => {
    const policy = gate({ currentFingerprint: fingerprint({ policyHash: 'new' }), findings: [finding('f', 'C03')] })
    expect(policy.state).toBe('STALE')
    expect(policy.reasons[0]).toMatch(/changed since run r1 \(policy\)/)
    expect(policy.staleControls.every(id => ['C03', 'C04', 'C13'].includes(id))).toBe(true)
    // A profile or registry change invalidates every audited control.
    expect(gate({ currentFingerprint: fingerprint({ profileVersion: 2 }) }).staleControls).toEqual(['C03', 'C04', 'C13'])
    // A staging fingerprint never satisfies this environment.
    expect(gate({ currentFingerprint: fingerprint({ environmentId: 'staging' }) }).state).toBe('STALE')
    // Unknown current target: not stale.
    expect(gate({ currentFingerprint: null }).state).toBe('VERIFIED')
  })

  it('NEEDS_REVIEW for a confirmed critical/high open finding, an UNVERIFIED or NEEDS_HUMAN_REVIEW control, a blocking question, an expired waiver, or an unwaived FAIL/WARN', () => {
    const confirmed = gate({ results: [result('C03', 'FAIL', { findingIds: ['f'] })], findings: [finding('f', 'C03')] })
    expect(confirmed).toMatchObject({ state: 'NEEDS_REVIEW', openCriticalOrHigh: 1 })
    expect(confirmed.reasons[0]).toMatch(/1 open confirmed critical\/high finding/)

    const unverified = gate({ results: [result('C03', 'UNVERIFIED', { rationale: 'budget exhausted (maxRequests)' })] })
    expect(unverified).toMatchObject({ state: 'NEEDS_REVIEW', unverifiedControls: ['C03'] })
    expect(unverified.reasons[0]).toMatch(/C03 could not be verified: budget exhausted/)

    const review = gate({ results: [result('C01', 'NEEDS_HUMAN_REVIEW', { humanReview: [{ id: 'C01:x', controlId: 'C01', question: 'adequate?', why: '', route: null, evidence: [] }] })] })
    expect(review).toMatchObject({ state: 'NEEDS_REVIEW', humanReviewPending: 1 })

    expect(gate({ questions: [question('open')] }).reasons[0]).toMatch(/Owner question open \(blocks C08\)/)
    expect(gate({ questions: [question('answered')] }).state).toBe('VERIFIED')

    const expired = gate({ results: [result('C04', 'WARN')], findings: [finding('w', 'C04', { status: 'waived', waiverId: 'wv', severity: 'medium' })], waivers: [waiver('wv', 'w', '2026-09-28T00:00:00.000Z')] })
    expect(expired.state).toBe('NEEDS_REVIEW')
    expect(expired.reasons.join('\n')).toMatch(/waiver of C04 .* expired/)

    // A likely (not confirmed) high finding on a FAIL control still needs review: it is not waived.
    const likely = gate({ results: [result('C03', 'FAIL')], findings: [finding('l', 'C03', { confidence: 'likely' })] })
    expect(likely.state).toBe('NEEDS_REVIEW')
    expect(likely.reasons[0]).toMatch(/C03 is FAIL with 1 unwaived finding/)
    // A WARN with no finding at all is not silently VERIFIED either.
    expect(gate({ results: [result('C04', 'WARN', { rationale: 'remote fonts' })] }).reasons[0]).toMatch(/C04 is WARN: remote fonts/)
  })

  it('VERIFIED_WITH_WAIVERS when every FAIL/WARN finding has a live waiver; a revoked waiver does not count', () => {
    const waived = finding('f', 'C03', { status: 'waived', waiverId: 'wv' })
    const withWaiver = gate({ results: [result('C03', 'FAIL', { findingIds: ['f'] }), result('C04', 'PASS')], findings: [waived], waivers: [waiver('wv', 'f', '2026-12-31T00:00:00.000Z')] })
    expect(withWaiver).toMatchObject({ state: 'VERIFIED_WITH_WAIVERS', activeWaivers: 1, openCriticalOrHigh: 0 })
    const revoked = gate({ results: [result('C03', 'FAIL', { findingIds: ['f'] })], findings: [waived], waivers: [waiver('wv', 'f', '2026-12-31T00:00:00.000Z', NOW.toISOString())] })
    expect(revoked.state).toBe('NEEDS_REVIEW')
  })

  it('VERIFIED otherwise, with no reasons, a fixed finding ignored, and the scope wording (never a percentage or certification)', () => {
    const verified = gate({ findings: [finding('fx', 'C03', { status: 'fixed' })] })
    expect(verified).toMatchObject({ state: 'VERIFIED', reasons: [], runId: 'r1' })
    expect(verified.results).toEqual([{ controlId: 'C03', status: 'PASS' }, { controlId: 'C04', status: 'PASS' }, { controlId: 'C13', status: 'NOT_APPLICABLE' }])
    const line = gateSummary(verified)
    expect(line).toBe('Passed the configured audit scope at commit c0ffee000000.')
    for (const state of ['NOT_AUDITED', 'AUDITING', 'BLOCKED', 'STALE', 'NEEDS_REVIEW', 'VERIFIED', 'VERIFIED_WITH_WAIVERS'] as const) {
      const text = gateSummary({ state, fingerprint: fingerprint() })
      expect(text).not.toMatch(/%|certif|secure|guarantee/i)
    }
  })
})

describe('controlStatus', () => {
  const plain = { humanReviewAlways: false }
  const always = { humanReviewAlways: true }
  const applicable = { status: 'applicable' as const }
  it('is the worst of the checks, NOT_APPLICABLE and UNVERIFIED by applicability, UNVERIFIED with no outcome', () => {
    expect(controlStatus(plain, applicable, [{ status: 'PASS' }, { status: 'WARN' }])).toBe('WARN')
    expect(controlStatus(plain, applicable, [{ status: 'WARN' }, { status: 'UNVERIFIED' }, { status: 'FAIL' }])).toBe('FAIL')
    expect(controlStatus(plain, { status: 'not-applicable' }, [{ status: 'FAIL' }])).toBe('NOT_APPLICABLE')
    expect(controlStatus(plain, { status: 'unknown' }, [{ status: 'PASS' }])).toBe('UNVERIFIED')
    expect(controlStatus(plain, applicable, [])).toBe('UNVERIFIED')
    expect(controlStatus(plain, applicable, [{ status: 'NOT_APPLICABLE' }])).toBe('NOT_APPLICABLE')
  })
  it('never passes on an exhausted budget, and caps human-review controls at NEEDS_HUMAN_REVIEW', () => {
    expect(controlStatus(plain, applicable, [{ status: 'PASS' }], { budgetExhausted: true })).toBe('UNVERIFIED')
    expect(controlStatus(plain, applicable, [{ status: 'FAIL' }], { budgetExhausted: true })).toBe('FAIL')
    expect(controlStatus(always, applicable, [{ status: 'PASS' }])).toBe('NEEDS_HUMAN_REVIEW')
    expect(controlStatus(always, applicable, [{ status: 'WARN' }])).toBe('NEEDS_HUMAN_REVIEW')
    expect(controlStatus(always, applicable, [{ status: 'FAIL' }])).toBe('FAIL')
    expect(controlStatus(always, applicable, [{ status: 'UNVERIFIED' }])).toBe('UNVERIFIED')
  })
})
