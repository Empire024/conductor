import { describe, expect, it } from 'vitest'
import type { ControlResult, HumanReviewItem, ReviewAnswerRecord } from '../../shared/production'
import { applyReviewAnswers } from './gate'
import { matchAnswers, meaningTokens, reviewKey } from './review-carry'
import { ENV_ID, T0, fingerprint } from './testkit'

const item = (id: string, question: string, overrides: Partial<HumanReviewItem> = {}): HumanReviewItem => ({ id, controlId: 'C01', question, why: 'raised by the interpretation step', route: null, evidence: [], ...overrides })
const answer = (source: HumanReviewItem, value: ReviewAnswerRecord['answer'], overrides: Partial<ReviewAnswerRecord> = {}): ReviewAnswerRecord => ({
  projectId: 'p', environmentId: ENV_ID, itemId: source.id, controlId: source.controlId, answer: value, note: null, answeredBy: 'wizard:agent_w', answeredAt: T0.toISOString(),
  runId: 'run-1', fingerprint: fingerprint(), question: source.question, route: source.route, reviewKey: reviewKey(source), ...overrides,
})

const PRIVACY = 'Is the privacy policy adequate for the data the contact form collects?'
const CONTROLLER = 'Does the privacy policy name the data controller and a contact address?'

describe('review meaning keys', () => {
  it('ignore case, punctuation, plurals, word order and filler words; never the item id', () => {
    expect(meaningTokens('  Is the PRIVACY policy adequate for the data the contact-form collects? ')).toEqual(meaningTokens(PRIVACY))
    expect(reviewKey(item('C01:interpretation-1', PRIVACY))).toBe(reviewKey(item('C01:interpretation-4', 'is the privacy policy adequate, for the data the contact form collects')))
    expect(reviewKey(item('C01:interpretation-1', PRIVACY))).not.toBe(reviewKey(item('C01:interpretation-1', CONTROLLER)))
    expect(reviewKey(item('x', PRIVACY))).not.toBe(reviewKey(item('x', PRIVACY, { controlId: 'C02' })))
    expect(reviewKey(item('x', PRIVACY))).not.toBe(reviewKey(item('x', PRIVACY, { route: '/contact' })))
  })
})

describe('matching answers to regenerated items', () => {
  it('follows the meaning when a new run renumbers its questions, and never applies an answer to a different question under the same id', () => {
    const old1 = item('C01:interpretation-1', PRIVACY), old2 = item('C01:interpretation-2', CONTROLLER)
    const answers = [answer(old1, 'confirmed'), answer(old2, 'rejected')]
    // Run 2 asks the same two things in the other order, one slightly reworded, plus a new one.
    const fresh = [item('C01:interpretation-1', 'Does the privacy policy name the data controller and contact address?'), item('C01:interpretation-2', PRIVACY), item('C01:interpretation-3', 'Is the cookie banner shown before any tracker loads?')]
    const matches = matchAnswers('run-2', fresh, answers)
    expect(matches.get('C01:interpretation-1')).toMatchObject({ how: 'meaning', answer: { answer: 'rejected', itemId: 'C01:interpretation-2' } })
    expect(matches.get('C01:interpretation-2')).toMatchObject({ how: 'meaning', answer: { answer: 'confirmed', itemId: 'C01:interpretation-1' } })
    expect(matches.has('C01:interpretation-3')).toBe(false)
  })

  it('serves one item per answer, prefers this run\'s own answer, and matches legacy answers by id', () => {
    const asked = item('C01:interpretation-1', PRIVACY)
    const twice = [item('C01:interpretation-1', PRIVACY), item('C01:interpretation-2', `${PRIVACY} `)]
    expect(matchAnswers('run-2', twice, [answer(asked, 'confirmed')]).size).toBe(1)
    const own = answer(item('C01:interpretation-1', PRIVACY), 'rejected', { runId: 'run-2', answeredAt: '2026-09-28T00:00:00.000Z' })
    expect(matchAnswers('run-2', [asked], [answer(asked, 'confirmed'), own]).get(asked.id)).toMatchObject({ how: 'same-item', answer: { answer: 'rejected' } })
    const legacy: ReviewAnswerRecord = { ...answer(asked, 'confirmed'), question: undefined, route: undefined, reviewKey: undefined }
    expect(matchAnswers('run-2', [asked], [legacy]).get(asked.id)).toMatchObject({ how: 'legacy-id' })
  })
})

describe('applyReviewAnswers carries answers forward by meaning', () => {
  const result = (runId: string, items: HumanReviewItem[]): ControlResult => ({
    runId, controlId: 'C01', status: 'NEEDS_HUMAN_REVIEW', applicability: { controlId: 'C01', status: 'applicable', rationale: 'r', facts: [], decidedBy: 'rule' } as never,
    rationale: 'policies: NEEDS_HUMAN_REVIEW', evidence: [], findingIds: [], humanReview: items, checks: [{ checkId: 'policies', status: 'PASS', reason: null, durationMs: 1 }], coverage: { planned: 0, visited: 0, skipped: [] } as never, provenance: [],
  })

  it('a new commit keeps the answers, marked as carried from the answering run; a policy change voids them', () => {
    const old1 = item('C01:interpretation-1', PRIVACY), old2 = item('C01:interpretation-2', CONTROLLER)
    const answers = [answer(old1, 'confirmed'), answer(old2, 'confirmed')]
    const next = result('run-2', [item('C01:interpretation-1', CONTROLLER), item('C01:interpretation-2', PRIVACY)])
    const carried = applyReviewAnswers([next], answers, fingerprint({ commit: 'feedface00000000000000000000000000000000', build: 'b2' }))[0]!
    expect(carried.status).toBe('PASS')
    expect(carried.humanReview.every(entry => entry.answer === 'confirmed' && entry.carriedFrom === 'run-1')).toBe(true)
    expect(carried.rationale).toMatch(/carried forward from run run-1/)
    const voided = applyReviewAnswers([next], answers, fingerprint({ commit: 'feedface00000000000000000000000000000000', policyHash: 'rewritten' }))[0]!
    expect(voided.status).toBe('NEEDS_HUMAN_REVIEW')
    expect(voided.humanReview.every(entry => !entry.answer)).toBe(true)
  })

  it('a legacy answer (no wording) keeps the old id rule: a code change voids it', () => {
    const asked = item('C01:legal-adequacy', PRIVACY)
    const legacy: ReviewAnswerRecord = { ...answer(asked, 'confirmed'), question: undefined, route: undefined, reviewKey: undefined }
    const next = result('run-2', [asked])
    expect(applyReviewAnswers([next], [legacy], fingerprint({ dependencyHash: 'dep2' }))[0]!.status).toBe('PASS')
    expect(applyReviewAnswers([next], [legacy], fingerprint({ commit: 'feedface00000000000000000000000000000000' }))[0]!.humanReview[0]!.answer).toBeUndefined()
  })
})
