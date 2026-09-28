import { describe, expect, it } from 'vitest'
import type { ReviewPhase, ReviewRecord } from '../../approval-review'
import { captureApprovalReview, inferReviewerProvider } from './approval-review'

const record = (phases: Array<[ReviewPhase, string?]>, extra: Partial<ReviewRecord> = {}): ReviewRecord => {
  const history = phases.map(([phase, rationale], index) => ({ at: `2026-09-28T10:00:0${index}Z`, phase, rationale: rationale ?? `${phase} because` }))
  return {
    id: 'rev-1', digest: 'd', requestKey: 'rk', operationKey: 'ok', targetKeys: ['t'], projectId: 'p1', machineId: 'm', workerId: 'w1', runtimeId: 'rt', requestId: 'req',
    phase: history.at(-1)?.phase ?? 'reviewing', rationale: history.at(-1)?.rationale ?? 'Waiting', grantScope: 'exact-action', createdAt: '2026-09-28T09:59:59Z', updatedAt: history.at(-1)?.at ?? '2026-09-28T09:59:59Z', history,
    reviewerId: 'reviewer-tab', reviewerModel: 'claude-opus-5-5', reviewerTurnId: 'rt-turn', reviewerElapsedMs: 8_000, reviewerUsage: { inputTokens: 3_000, outputTokens: 200, costUsd: 0.05 },
    ...extra,
  }
}

describe('captureApprovalReview', () => {
  it('a reviewer allow that stood is a successful decision', () => {
    expect(captureApprovalReview({ record: record([['approved'], ['responding'], ['executed']]) })).toMatchObject({
      key: { provider: 'claude', model: 'claude-opus-5-5' }, source: 'approval-review', ref: 'rev-1', category: 'decision', result: 'success', ownerCorrected: false,
      durationMs: 8_000, tokens: 3_200, costUsd: 0.05, agentSessionId: 'reviewer-tab', at: '2026-09-28T10:00:00Z',
    })
  })
  it('an owner or wizard overriding the reviewer is ownerCorrected', () => {
    const wizard = record([['denied'], ['responded', 'Wizard tab answered allow: the path is inside the worktree']], { answeredBy: 'Wizard tab' })
    expect(captureApprovalReview({ record: wizard })).toMatchObject({ result: 'failure', ownerCorrected: true })
    expect(captureApprovalReview({ record: record([['approved']]), ownerDecision: 'deny' })).toMatchObject({ result: 'failure', ownerCorrected: true })
    expect(captureApprovalReview({ record: record([['denied']], { ownerAnswer: 'deny' }) })).toMatchObject({ result: 'success', ownerCorrected: false })
  })
  it('an escalation is scored by what the owner answered, and waits for it', () => {
    expect(captureApprovalReview({ record: record([['owner']]) })).toBeNull()
    expect(captureApprovalReview({ record: record([['owner'], ['denied']], { ownerAnswer: 'deny' }) })).toMatchObject({ result: 'success', escalated: true })
    expect(captureApprovalReview({ record: record([['owner'], ['responding']], { ownerAnswer: 'allow' }) })).toMatchObject({ result: 'partial', escalated: true })
  })
  it('a native boundary the reviewer would have allowed counts as allow', () => {
    expect(captureApprovalReview({ record: record([['blocked', 'The reviewer cannot approve this native owner boundary. Explicit escalation is required. fine']]) })).toMatchObject({ result: 'success' })
  })
  it('a failed reviewer turn is a failure', () => {
    expect(captureApprovalReview({ record: record([['paused', 'Reviewer timed out after 120s']]) })).toMatchObject({ result: 'failure', timedOut: true })
    expect(captureApprovalReview({ record: record([['paused', 'Review result lacks a matching digest']]) })).toMatchObject({ result: 'failure', invalidOutput: true })
  })
  it('ignores records no reviewer model decided', () => {
    expect(captureApprovalReview({ record: record([['approved']], { coveredBy: 'rule-1' }) })).toBeNull()
    expect(captureApprovalReview({ record: record([['denied', 'A durable denial covers this target']], { reviewerModel: undefined }) })).toBeNull()
    expect(captureApprovalReview({ record: record([]) })).toBeNull()
    expect(captureApprovalReview({ record: record([['approved']], { reviewerModel: 'mystery' }) })).toBeNull()
    expect(captureApprovalReview({ record: record([['approved']], { reviewerModel: 'mystery' }), reviewerProvider: 'codex' })!.key).toEqual({ provider: 'codex', model: 'mystery' })
  })
  it('infers the reviewer provider', () => {
    expect(inferReviewerProvider('opus[1m]')).toBe('claude'); expect(inferReviewerProvider('gpt-6-astra')).toBe('codex'); expect(inferReviewerProvider('grok-4.7')).toBe('grok')
  })
})
