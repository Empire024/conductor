import { describe, expect, it } from 'vitest'
import type { Decider, DeciderOutcome, DecisionKind, DecisionRecord, DecisionRequest } from '../../shared/model-routing'
import { DEFAULT_THRESHOLDS, DecisionService, THRESHOLDS_SETTING, normaliseProbabilities, topChoice } from './decision-service'

const settings = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial))
  return { values, getSetting: (key: string) => values.get(key) ?? null, setSetting: (key: string, value: string) => { values.set(key, value) } }
}
const fixed = (id: string, tier: Decider['tier'], answer: Record<string, number> | string, kinds?: DecisionKind[]): Decider & { calls: number } => {
  const decider = {
    id, tier, calls: 0,
    supports: (kind: DecisionKind) => !kinds || kinds.includes(kind),
    async decide(): Promise<DeciderOutcome> {
      decider.calls++
      return typeof answer === 'string' ? { ok: false, decider: id, reason: answer } : { ok: true, verdict: { decider: id, probabilities: answer, rationale: `${id} says so`, elapsedMs: 3 } }
    },
  }
  return decider
}
const request = (kind: DecisionKind, extra: Partial<DecisionRequest> = {}): DecisionRequest => ({
  kind, question: 'What now?', options: kind === 'approval' ? [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }, { id: 'escalate', label: 'Ask the owner' }] : [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
  state: {}, impact: 'routine', requester: 'test', ...extra,
})
const service = (deciders: Decider[], initial?: Record<string, string>) => {
  const journal: DecisionRecord[] = [], store = settings(initial)
  return { journal, store, service: new DecisionService({ deciders, journal: { record: record => { journal.push(record) } }, settings: store, now: () => new Date('2026-09-28T12:00:00Z') }) }
}

describe('probabilities', () => {
  it('normalises over the option ids and drops unknown or invalid values', () => {
    expect(normaliseProbabilities({ a: 2, b: 2, ghost: 5 }, ['a', 'b'])).toEqual({ a: 0.5, b: 0.5 })
    expect(normaliseProbabilities({ a: -1, b: Number.NaN, c: 1 }, ['a', 'b', 'c'])).toEqual({ a: 0, b: 0, c: 1 })
    expect(normaliseProbabilities({ ghost: 1 }, ['a'])).toBeNull()
  })
  it('reads the top choice, its confidence and margin, ties by option order', () => {
    expect(topChoice({ a: 0.2, b: 0.7, c: 0.1 }, ['a', 'b', 'c'])).toEqual({ choice: 'b', confidence: 0.7, margin: expect.closeTo(0.5, 9) })
    expect(topChoice({ a: 0.5, b: 0.5 }, ['a', 'b'])).toMatchObject({ choice: 'a', margin: 0 })
  })
})

describe('DecisionService validation and thresholds', () => {
  it('rejects empty, duplicate and oversized requests', async () => {
    const { service: decisions } = service([])
    await expect(decisions.decide(request('retry', { options: [] }))).rejects.toThrow(/at least one option/)
    await expect(decisions.decide(request('retry', { options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'again' }] }))).rejects.toThrow(/unique/)
    await expect(decisions.decide(request('retry', { state: { blob: 'x'.repeat(7000) } }))).rejects.toThrow(/exceeds 6000/)
  })
  it('has the documented defaults per kind', () => {
    const { service: decisions } = service([])
    expect(decisions.thresholds('route')).toEqual({ mode: 'live', minConfidence: 0.55, minMargin: 0.15, highImpact: 'escalate-when-unsure', frontierOnly: [] })
    expect(decisions.thresholds('approval')).toEqual({ mode: 'shadow', minConfidence: 0.9, minMargin: 0.3, highImpact: 'always-escalate', frontierOnly: ['deny'] })
    for (const kind of ['retry', 'escalate', 'completion', 'fallback'] as const) expect(decisions.thresholds(kind)).toMatchObject({ mode: 'live', minConfidence: 0.7, minMargin: 0.2 })
    expect(decisions.thresholds('classify')).toMatchObject({ mode: 'live', minConfidence: 0.5, minMargin: 0 })
  })
  it('stores validated patches under the settings key, ignores corrupt settings and resets with null', () => {
    const { service: decisions, store } = service([], { [THRESHOLDS_SETTING]: '{"approval":{"mode":"live","minConfidence":7}}' })
    expect(decisions.thresholds('approval')).toMatchObject({ mode: 'live', minConfidence: 0.9 })
    expect(decisions.setThresholds('approval', { minMargin: 0.4 })).toMatchObject({ mode: 'live', minMargin: 0.4 })
    expect(JSON.parse(store.values.get(THRESHOLDS_SETTING)!)).toEqual({ approval: { mode: 'live', minMargin: 0.4 } })
    expect(() => decisions.setThresholds('approval', { minConfidence: 2 })).toThrow(/minConfidence/)
    expect(decisions.setThresholds('approval', null)).toEqual(DEFAULT_THRESHOLDS.approval)
    store.values.set(THRESHOLDS_SETTING, 'not json')
    expect(decisions.allThresholds().route).toEqual(DEFAULT_THRESHOLDS.route)
  })
})

describe('DecisionService escalation', () => {
  it('lets a confident system-one decide in live mode and journals it', async () => {
    const local = fixed('local', 'system-one', { a: 0.9, b: 0.1 }), frontier = fixed('frontier', 'frontier', { b: 1 })
    const { service: decisions, journal } = service([local, frontier])
    const record = await decisions.decide(request('retry'))
    expect(record).toMatchObject({ choice: 'a', confidence: 0.9, decidedBy: 'local', escalated: false, escalationReason: null, at: '2026-09-28T12:00:00.000Z' })
    expect(frontier.calls).toBe(0)
    expect(journal).toEqual([record])
  })
  it('escalates low confidence and a narrow margin to the frontier, which decides', async () => {
    const { service: decisions } = service([fixed('local', 'system-one', { a: 0.55, b: 0.45 }), fixed('frontier', 'frontier', { b: 1 })])
    const record = await decisions.decide(request('retry'))
    expect(record).toMatchObject({ choice: 'b', confidence: 1, decidedBy: 'frontier', escalated: true })
    expect(record.escalationReason).toMatch(/confidence 0\.55 < 0\.70; margin 0\.10 < 0\.20/)
    expect(record.verdicts.map(verdict => verdict.decider)).toEqual(['local', 'frontier'])
  })
  it('forces escalation when system-one picks a frontier-only option', async () => {
    const frontier = fixed('frontier', 'frontier', { allow: 1 })
    const { service: decisions } = service([fixed('local', 'system-one', { allow: 0.01, deny: 0.98, escalate: 0.01 }), frontier], { [THRESHOLDS_SETTING]: '{"approval":{"mode":"live"}}' })
    const record = await decisions.decide(request('approval'))
    expect(record).toMatchObject({ choice: 'allow', decidedBy: 'frontier', escalated: true, escalationReason: "'deny' is frontier-only" })
    expect(frontier.calls).toBe(1)
  })
  it('in shadow mode journals both verdicts but the frontier decides', async () => {
    const local = fixed('local', 'system-one', { allow: 0.97, deny: 0.02, escalate: 0.01 }), frontier = fixed('opus-reviewer', 'frontier', { escalate: 1 })
    const { service: decisions, journal } = service([local, frontier])
    const record = await decisions.decide(request('approval'))
    expect(record).toMatchObject({ choice: 'escalate', decidedBy: 'opus-reviewer', escalated: true, escalationReason: 'mode shadow' })
    expect(record.verdicts).toEqual([
      expect.objectContaining({ decider: 'local', probabilities: { allow: 0.97, deny: 0.02, escalate: 0.01 } }),
      expect.objectContaining({ decider: 'opus-reviewer', probabilities: { allow: 0, deny: 0, escalate: 1 } }),
    ])
    expect(journal[0]).toBe(record)
    expect([local.calls, frontier.calls]).toEqual([1, 1])
  })
  it('always escalates a high-impact decision when the kind says so', async () => {
    const { service: decisions } = service([fixed('local', 'system-one', { allow: 1 }), fixed('frontier', 'frontier', { allow: 1 })], { [THRESHOLDS_SETTING]: '{"approval":{"mode":"live","frontierOnly":[]}}' })
    expect(await decisions.decide(request('approval', { impact: 'high' }))).toMatchObject({ escalated: true, escalationReason: 'high-impact decision', decidedBy: 'frontier' })
    expect(await decisions.decide(request('approval'))).toMatchObject({ escalated: false, decidedBy: 'local' })
  })
  it('lets the frontier decide when system-one fails, and returns choice null when both fail', async () => {
    const { service: decisions } = service([fixed('local', 'system-one', 'bad JSON'), fixed('frontier', 'frontier', { a: 0.2, b: 0.8 })])
    expect(await decisions.decide(request('retry'))).toMatchObject({ choice: 'b', escalationReason: 'system-one failed: bad JSON' })
    const { service: broken, journal } = service([fixed('local', 'system-one', 'timed out'), fixed('frontier', 'frontier', 'reviewer unavailable')])
    const record = await broken.decide(request('retry'))
    expect(record).toMatchObject({ choice: null, confidence: 0, decidedBy: 'none', escalated: true, probabilities: {} })
    expect(record.verdicts).toEqual([{ decider: 'local', failed: 'timed out' }, { decider: 'frontier', failed: 'reviewer unavailable' }])
    expect(record.rationale).toMatch(/frontier failed: reviewer unavailable/)
    expect(journal).toHaveLength(1)
  })
  it('returns choice null when escalation is needed and no frontier exists', async () => {
    const { service: decisions } = service([fixed('local', 'system-one', { a: 0.5, b: 0.5 })])
    expect(await decisions.decide(request('retry'))).toMatchObject({ choice: null, verdicts: [expect.objectContaining({ decider: 'local' }), { decider: 'frontier', failed: 'no frontier decider for retry' }] })
  })
  it('keeps the scorer top for a close route call with no frontier configured, journaled for audit', async () => {
    const { service: decisions, journal } = service([fixed('scorer', 'system-one', { a: 0.52, b: 0.48 })])
    const record = await decisions.decide(request('route'))
    expect(record).toMatchObject({ choice: 'a', decidedBy: 'scorer', escalated: false, escalationReason: 'close call, no frontier configured' })
    expect(record.rationale).toMatch(/confidence 0\.52 < 0\.55; margin 0\.04 < 0\.15/)
    expect(journal).toEqual([record])
    const { service: shadowed } = service([fixed('scorer', 'system-one', { a: 0.52, b: 0.48 })], { [THRESHOLDS_SETTING]: '{"route":{"mode":"shadow"}}' })
    expect(await shadowed.decide(request('route'))).toMatchObject({ choice: null })
  })
  it('treats a verdict with no known option as a failure and a throwing decider as failed', async () => {
    const thrower: Decider = { id: 'thrower', tier: 'frontier', supports: () => true, decide: async () => { throw new Error('boom') } }
    const { service: decisions } = service([fixed('local', 'system-one', { ghost: 1 }), thrower])
    const record = await decisions.decide(request('retry'))
    expect(record.verdicts).toEqual([{ decider: 'local', failed: 'No probability for any offered option' }, { decider: 'thrower', failed: 'boom' }])
  })
  it('skips system-one in off mode and uses a per-call frontier', async () => {
    const local = fixed('local', 'system-one', { a: 1 }), bound = fixed('bound', 'frontier', { b: 1 })
    const { service: decisions } = service([local, fixed('frontier', 'frontier', { a: 1 })], { [THRESHOLDS_SETTING]: '{"retry":{"mode":"off"}}' })
    expect(await decisions.decide(request('retry'), { frontier: bound })).toMatchObject({ choice: 'b', decidedBy: 'bound', escalationReason: 'mode off' })
    expect(local.calls).toBe(0)
  })
  it('records the system-one verdict on every decision, whatever decided', async () => {
    const { service: decisions } = service([fixed('local', 'system-one', { allow: 0.97, deny: 0.02, escalate: 0.01 }), fixed('reviewer', 'frontier', { deny: 1 })])
    expect(await decisions.decide(request('approval'))).toMatchObject({ choice: 'deny', decidedBy: 'reviewer', systemOne: { decider: 'local', choice: 'allow', confidence: 0.97 } })
    const { service: failing } = service([fixed('local', 'system-one', 'timed out'), fixed('reviewer', 'frontier', { allow: 1 })])
    expect((await failing.decide(request('approval'))).systemOne).toEqual({ decider: 'local', choice: null, confidence: 0, failed: 'timed out' })
    const { service: none } = service([fixed('reviewer', 'frontier', { a: 1 })])
    expect((await none.decide(request('retry'))).systemOne).toBeNull()
  })
  it('keeps the decision when the journal fails', async () => {
    const failures: unknown[] = []
    const decisions = new DecisionService({ deciders: [fixed('local', 'system-one', { a: 1 })], journal: { record: () => { throw new Error('database is locked') } }, settings: settings(), journalFailed: error => failures.push(error) })
    expect(await decisions.decide(request('retry'))).toMatchObject({ choice: 'a' })
    expect(failures).toHaveLength(1)
  })
})
