import { describe, expect, it } from 'vitest'
import type { DecisionRecord, DecisionRequest } from '../../../shared/model-routing'
import { DecisionService } from '../decision-service'
import { approvalReviewFrontier, createFrontierDecider, reviewTokens, type ApprovalReviewAnswer } from './frontier'

const approval: DecisionRequest = { kind: 'approval', question: 'Allow this Bash call?', options: ['allow', 'deny', 'escalate'].map(id => ({ id, label: id })), state: { requestKey: 'r1' }, impact: 'routine', requester: 'approval-gate' }
let clock = 0
const now = () => (clock += 100)

describe('frontier decider', () => {
  it('turns a choice into a one-hot verdict and passes probabilities through', async () => {
    const choosing = createFrontierDecider({ ask: async () => ({ choice: 'deny', rationale: 'Deletes the repo', model: 'opus' }) }, { now })
    expect(await choosing.decide(approval)).toEqual({ ok: true, verdict: { decider: 'frontier:opus', probabilities: { allow: 0, deny: 1, escalate: 0 }, rationale: 'Deletes the repo', tokens: null, elapsedMs: 100 } })
    const weighing = createFrontierDecider({ ask: async () => ({ probabilities: { allow: 0.6, escalate: 0.4 }, rationale: 'Probably fine' }) }, { kinds: ['approval'] })
    expect(weighing.supports('route')).toBe(false)
    expect(await weighing.decide(approval)).toMatchObject({ ok: true, verdict: { decider: 'frontier', probabilities: { allow: 0.6, escalate: 0.4 } } })
  })
  it('fails on a throw, an unknown choice or an empty answer', async () => {
    expect(await createFrontierDecider({ ask: async () => { throw new Error('Reviewer tab closed') } }).decide(approval)).toEqual({ ok: false, decider: 'frontier', reason: 'Reviewer tab closed' })
    expect(await createFrontierDecider({ ask: async () => ({ choice: 'maybe', rationale: '' }) }).decide(approval)).toMatchObject({ ok: false, reason: expect.stringMatching(/not an option/) })
    expect(await createFrontierDecider({ ask: async () => ({ rationale: 'x' }) as never }).decide(approval)).toMatchObject({ ok: false, reason: expect.stringMatching(/neither/) })
  })
})

describe('approval reviewer adapter', () => {
  const action = { tool: 'Bash', arguments: { command: 'npm test' } }
  const bound = new Map([['r1', { action, digest: 'd1' }]])
  const subject = (request: DecisionRequest) => bound.get(String(request.state.requestKey))
  it('maps the reviewer result to an approval verdict with its tokens', async () => {
    const calls: Array<[unknown, string]> = []
    const decider = approvalReviewFrontier(async (asked, digest): Promise<ApprovalReviewAnswer> => { calls.push([asked, digest]); return { decision: 'escalate', rationale: 'Needs the owner', model: 'claude-opus-5-5', digest, usage: { run: { tokens: { inputTokens: 1200, outputTokens: 80 } } } } }, subject)
    expect(decider.supports('approval') && !decider.supports('retry')).toBe(true)
    expect(await decider.decide(approval)).toMatchObject({ ok: true, verdict: { decider: 'approval-reviewer:claude-opus-5-5', probabilities: { allow: 0, deny: 0, escalate: 1 }, rationale: 'Needs the owner', tokens: 1280 } })
    expect(calls).toEqual([[action, 'd1']])
  })
  it('refuses an unbound request, a different digest and an unknown decision', async () => {
    const ok = async (): Promise<ApprovalReviewAnswer> => ({ decision: 'allow', rationale: 'fine', model: 'opus', digest: 'd1' })
    expect(await approvalReviewFrontier(ok, () => null).decide(approval)).toMatchObject({ ok: false, reason: expect.stringMatching(/No reviewable action/) })
    expect(await approvalReviewFrontier(async () => ({ ...(await ok()), digest: 'other' }), subject).decide(approval)).toMatchObject({ ok: false, reason: expect.stringMatching(/different action digest/) })
    expect(await approvalReviewFrontier(async () => ({ ...(await ok()), decision: 'maybe' as never }), subject).decide(approval)).toMatchObject({ ok: false, reason: expect.stringMatching(/Unknown review decision/) })
  })
  it('reads reviewer token usage like the gate does', () => {
    expect(reviewTokens({ conversation: { tokens: { totalTokens: 900 } } })).toBe(900)
    expect(reviewTokens(undefined)).toBeNull()
  })
  it('decides a shadow approval through DecisionService: the reviewer decides, the local verdict is journaled', async () => {
    const journal: DecisionRecord[] = []
    const local = { id: 'local-llm', tier: 'system-one' as const, supports: () => true, decide: async () => ({ ok: true as const, verdict: { decider: 'local-llm', probabilities: { allow: 0.95, deny: 0, escalate: 0.05 }, rationale: 'Routine', elapsedMs: 5 } }) }
    const decisions = new DecisionService({ deciders: [local], journal: { record: record => { journal.push(record) } }, settings: { getSetting: () => null, setSetting: () => {} } })
    const reviewer = approvalReviewFrontier(async () => ({ decision: 'deny', rationale: 'Pushes to main', model: 'opus', digest: 'd1' }), subject)
    const record = await decisions.decide(approval, { frontier: reviewer })
    expect(record).toMatchObject({ choice: 'deny', decidedBy: 'approval-reviewer:opus', escalationReason: 'mode shadow' })
    expect(journal[0]!.verdicts.map(verdict => verdict.decider)).toEqual(['local-llm', 'approval-reviewer:opus'])
  })
})
