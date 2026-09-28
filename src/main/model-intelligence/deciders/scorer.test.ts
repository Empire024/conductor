import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTE_CONSTRAINTS, REPUTATION_POLICY, type RegistryRecord, type ReputationScore, type TaskFeatures } from '../../../shared/model-routing'
import { capabilityPrior, createScorerDecider, effectiveReputation, estimateTokens, expectedCost, hardFilter, scoreCandidates, softmax, stakes, wilson, type CandidateFacts } from './scorer'

const record = (provider: string, model: string, extra: Partial<RegistryRecord> = {}): RegistryRecord => ({
  key: { provider, model }, status: 'proven', displayName: model, family: null, releasedAt: null, deprecatedAt: null, contextTokens: 200_000, maxOutputTokens: null,
  modalities: ['text'], toolUse: true, efforts: [], pricing: null, latencyMs: null, tokensPerSecond: null, availability: 'available', capabilities: [], local: null,
  provenance: {}, firstSeenAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z', stale: false, ...extra,
})
const reputation = (mean: number, lower: number, evidence: number): ReputationScore => ({ key: { provider: 'x', model: 'x' }, dimension: 'simple-coding', mean, lower, evidence, priorMean: 0.6, priorSource: 'default', lastOutcomeAt: null })
const facts = (entry: RegistryRecord, extra: Partial<CandidateFacts> = {}): CandidateFacts => ({ record: entry, effort: null, reputation: null, loopTendency: null, falseCompletion: null, usagePercent: null, usageStopPercent: 85, ...extra })
const features: TaskFeatures = { category: 'simple-coding', complexity: 2, risk: 'low', toolsRequired: ['Bash'], contextTokens: 30_000 }

describe('scorer', () => {
  it('softmaxes at T = 0.08', () => {
    const [a, b] = softmax([0.5, 0.42])
    expect(a! / b!).toBeCloseTo(Math.E, 6)
    expect(softmax([])).toEqual([])
  })
  it('estimates cost from per-token prices, zero for local, null when unpriced', () => {
    expect(estimateTokens(features)).toEqual({ input: 60_000, output: 1_500 })
    expect(expectedCost(record('codex', 'sol', { pricing: { inputPerMTok: 1, outputPerMTok: 10, cachedInputPerMTok: null, currency: 'USD' } }), features)).toBeCloseTo(0.075, 9)
    expect(expectedCost(record('local', 'qwen'), features)).toBe(0)
    expect(expectedCost(record('claude', 'opus'), features)).toBeNull()
    expect(stakes({ ...features, complexity: 5, risk: 'high' })).toBe(2)
  })
  it('applies each hard filter', () => {
    const c = DEFAULT_ROUTE_CONSTRAINTS, cloud = record('claude', 'opus')
    expect(hardFilter(facts(record('claude', 'old', { availability: 'deprecated' })), features, c, null)).toBe('availability deprecated')
    expect(hardFilter(facts(cloud), features, { ...c, localOnly: true }, null)).toBe('local only')
    expect(hardFilter(facts(cloud), features, { ...c, excludeProviders: ['claude'] }, null)).toBe('provider claude excluded')
    expect(hardFilter(facts(cloud), features, { ...c, allow: [{ provider: 'codex', model: 'sol' }] }, null)).toBe('not in the allowed shortlist')
    expect(hardFilter(facts(record('claude', 'chat', { toolUse: false })), features, c, null)).toBe('no tool use')
    expect(hardFilter(facts(record('claude', 'small', { contextTokens: 16_000 })), features, c, null)).toBe('30k context needed, 16k available')
    expect(hardFilter(facts(cloud), features, { ...c, maxCostUsd: 0.1 }, 0.25)).toBe('expected cost $0.25 over the $0.10 cap')
    expect(hardFilter(facts(cloud, { usagePercent: 88 }), features, c, null)).toBe('usage 88% at or above the 85% stop')
    expect(hardFilter(facts(record('local', 'big'), { local: { loaded: false, fitsVram: false, admissible: true, reason: '22 GB does not fit 12 GB VRAM' } }), features, c, 0)).toBe('22 GB does not fit 12 GB VRAM')
    expect(hardFilter(facts(record('local', 'q'), { local: { loaded: false, fitsVram: true, admissible: false } }), features, c, 0)).toBe('cannot be admitted now')
    expect(hardFilter(facts(cloud), features, c, null)).toBeNull()
  })
  // D8: one smooth, monotone rule for every sample size (a Beta score of s successes in n, on the default prior).
  const outcomes = (successes: number, total: number): ReputationScore => ({ ...reputation((REPUTATION_POLICY.priorWeight * 0.6 + successes) / (REPUTATION_POLICY.priorWeight + total), 0, total), priorMean: 0.6 })
  const localFilter = (successes: number, total: number, task: TaskFeatures = features) => hardFilter(facts(record('local', 'local/qwen'), { reputation: total ? outcomes(successes, total) : null }), task, DEFAULT_ROUTE_CONSTRAINTS, 0)
  it.each([
    [0, 0, true], [3, 5, true], [5, 8, true], [2, 6, true], [1, 1, true], [0, 1, true],
    [1, 6, false], [0, 6, false], [2, 10, false], [5, 20, false],
  ])('a local model with %i of %i on simple work is eligible: %s', (successes, total, eligible) => {
    expect(localFilter(successes, total) === null).toBe(eligible)
  })
  it('local exclusion is monotone: one more success never excludes, one more failure never readmits', () => {
    for (let total = 0; total <= 30; total++) for (let successes = 0; successes < total; successes++) {
      const now = localFilter(successes, total) === null
      if (!now) continue
      expect(localFilter(successes + 1, total) === null, `${successes + 1}/${total}`).toBe(true)
      expect(localFilter(successes + 1, total + 1) === null, `${successes + 1}/${total + 1}`).toBe(true)
    }
    expect(localFilter(0, 6)).toBe('at most 37% likely success on simple-coding (0 of 6 outcomes)')
  })
  it('hard or high-risk work needs a proven local record; a cloud model is never excluded for its record', () => {
    const hardTask: TaskFeatures = { ...features, category: 'difficult-coding', complexity: 5, risk: 'high' }
    expect(localFilter(0, 0, hardTask)).toBe('no proven record on difficult-coding for complexity 5, high-risk work (0 of 0 outcomes; needs 5+ with at least 50% likely)')
    expect(localFilter(4, 5, hardTask)).toMatch(/^no proven record/)
    expect(localFilter(5, 5, hardTask)).toBeNull()
    expect(localFilter(3, 5, { ...features, risk: 'high' })).toMatch(/^no proven record/)
    expect(hardFilter(facts(record('codex', 'mini'), { reputation: outcomes(0, 9) }), hardTask, DEFAULT_ROUTE_CONSTRAINTS, null)).toBeNull()
  })
  it('replaces a default prior with the capability prior, keeps real priors, and lets evidence move it', () => {
    const hardTask: TaskFeatures = { ...features, category: 'difficult-coding', complexity: 5, risk: 'high' }
    expect(capabilityPrior(3, hardTask)).toBeCloseTo(0.78, 9)
    expect(capabilityPrior(0, hardTask)).toBeCloseTo(0.35, 9)
    const opus = record('claude', 'opus[1m]'), fresh = effectiveReputation(null, opus, hardTask)
    expect(fresh).toMatchObject({ mean: expect.closeTo(0.78, 9), evidence: 0 })
    expect(effectiveReputation(null, record('codex', 'gpt-5.6-sol'), hardTask).mean).toBeCloseTo(0.51, 9)
    expect(effectiveReputation(outcomes(0, 10), opus, hardTask).mean).toBeLessThan(0.4)
    const benchmarked = { ...reputation(0.9, 0.8, 0), priorSource: 'benchmark' as const }
    expect(effectiveReputation(benchmarked, opus, hardTask)).toBe(benchmarked)
    expect(effectiveReputation(null, { ...record('codex', 'gpt-x'), capabilityRank: 3 }, hardTask).mean).toBeCloseTo(0.78, 9)
  })
  it('wilson blends the prior into a smooth interval', () => {
    const none = wilson(0, 0, 0.55), some = wilson(3, 5, 0.55)
    expect(none.rate).toBeCloseTo(0.55, 9)
    expect(some.upper - some.lower).toBeLessThan(none.upper - none.lower)
    expect(wilson(8, 8, 0.55).lower).toBeGreaterThan(wilson(4, 4, 0.55).lower)
  })
  it('ranks eligible candidates by utility and penalises loops, false completion and an unloaded local model', () => {
    const base = reputation(0.8, 0.7, 20)
    const ranked = scoreCandidates([
      facts(record('local', 'cold'), { reputation: base, local: { loaded: false, fitsVram: true, admissible: true } }),
      facts(record('local', 'warm'), { reputation: base, local: { loaded: true, fitsVram: true, admissible: true } }),
      facts(record('local', 'loopy'), { reputation: base, loopTendency: reputation(0.5, 0.4, 10), local: { loaded: true, fitsVram: true, admissible: true } }),
      facts(record('claude', 'gone', { availability: 'unavailable' })),
    ], features, DEFAULT_ROUTE_CONSTRAINTS)
    expect(ranked.map(candidate => candidate.key.model)).toEqual(['warm', 'cold', 'loopy', 'gone'])
    expect(ranked[3]).toMatchObject({ eligible: false, excluded: 'availability unavailable' })
    expect(ranked[0]!.utility - ranked[1]!.utility).toBeCloseTo(0.05, 9)
  })
  it('keeps hard or high-risk work on rank 2+ whatever the weights, unless the weaker model has a proven record or nothing of rank 2+ is eligible (N10)', () => {
    const priced = (input: number, output: number) => ({ pricing: { inputPerMTok: input, outputPerMTok: output, cachedInputPerMTok: null, currency: 'USD' as const } })
    const opus = record('claude', 'opus', { capabilityRank: 3, ...priced(5, 25) }), luna = record('codex', 'gpt-6-luna', { capabilityRank: 1, ...priced(0.05, 0.4) })
    const costliest = { ...DEFAULT_ROUTE_CONSTRAINTS, costWeight: 1, latencyWeight: 1, urgency: 'urgent' as const }
    for (const hard of [{ ...features, category: 'difficult-coding', complexity: 5, risk: 'low' }, { ...features, category: 'debugging', complexity: 3, risk: 'high' }, { ...features, complexity: 1, risk: 'high' }] as TaskFeatures[]) {
      const ranked = scoreCandidates([facts(luna), facts(opus)], hard, costliest)
      expect(ranked[0]!.key.model, JSON.stringify(hard)).toBe('opus')
      expect(ranked[1]).toMatchObject({ eligible: false, excluded: expect.stringMatching(/^capability rank 1 below the rank-2 floor for complexity \d, \w+-risk work, and no proven record on/) })
    }
    // Easy work is left to the weights: the cheap model wins at cost weight 1.
    expect(scoreCandidates([facts(luna), facts(opus)], { ...features, complexity: 2, risk: 'low' }, costliest)[0]!.key.model).toBe('gpt-6-luna')
    // Evidence earns the exception; with nothing of rank 2+ eligible the floor is lifted.
    const hard: TaskFeatures = { ...features, category: 'difficult-coding', complexity: 5, risk: 'high' }
    expect(scoreCandidates([facts(luna, { reputation: outcomes(12, 12) }), facts(opus)], hard, costliest).find(candidate => candidate.key.model === 'gpt-6-luna')!.eligible).toBe(true)
    expect(scoreCandidates([facts(luna), facts(opus)], hard, { ...costliest, excludeProviders: ['claude'] })[0]).toMatchObject({ key: { model: 'gpt-6-luna' }, eligible: true })
    // Failing strong models are not replaced by an unproven weak one (the Claude-only case with Opus and Sonnet failing).
    const haiku = record('claude', 'haiku', { capabilityRank: 1 }), sonnet = record('claude', 'sonnet', { capabilityRank: 2 })
    const claudeOnly = scoreCandidates([facts(opus, { reputation: outcomes(0, 8) }), facts(sonnet, { reputation: outcomes(0, 8) }), facts(haiku)], hard, DEFAULT_ROUTE_CONSTRAINTS)
    expect(claudeOnly.filter(candidate => candidate.eligible).map(candidate => candidate.key.model).sort()).toEqual(['opus', 'sonnet'])
  })
  it('never scores an unpriced cloud model as cheaper than the priced models beside it (N18)', () => {
    const priced = (input: number, output: number) => ({ pricing: { inputPerMTok: input, outputPerMTok: output, cachedInputPerMTok: null, currency: 'USD' as const } })
    const fast = record('grok', 'grok-4.7-build-fast', { capabilityRank: 2 }), code = record('grok', 'grok-4.7-code', { capabilityRank: 2, ...priced(0.2, 1.5) }), heavy = record('grok', 'grok-4.7-heavy', { capabilityRank: 2, ...priced(3, 15) })
    const all = [facts(fast), facts(code), facts(heavy)]
    const ranked = scoreCandidates(all, features, { ...DEFAULT_ROUTE_CONSTRAINTS, costWeight: 1 })
    expect(ranked[0]!.key.model).toBe('grok-4.7-code')
    const unpriced = ranked.find(candidate => candidate.key.model === 'grok-4.7-build-fast')!
    // Scored at its priciest same-rank sibling; its own price stays unknown in the record.
    expect(unpriced).toMatchObject({ expectedCostUsd: null, live: { costBasis: 'grok/grok-4.7-heavy', scoredCostUsd: expectedCost(heavy, features) } })
    expect(unpriced.utility).toBeCloseTo(ranked.find(candidate => candidate.key.model === 'grok-4.7-heavy')!.utility, 9)
    // An excluded sibling still prices it, so filtering never reprices; with no priced model anywhere it stays neutral.
    expect(scoreCandidates(all, features, { ...DEFAULT_ROUTE_CONSTRAINTS, allow: [fast.key, code.key] }).find(candidate => candidate.key.model === 'grok-4.7-build-fast')!.live.costBasis).toBe('grok/grok-4.7-heavy')
    expect(scoreCandidates([facts(fast), facts(record('claude', 'opus', { capabilityRank: 3 }))], features, DEFAULT_ROUTE_CONSTRAINTS)[0]!.live).not.toHaveProperty('costBasis')
    // Another provider's same-rank price is the last resort; a local model is never a price basis.
    expect(scoreCandidates([facts(fast), facts(record('codex', 'terra', { capabilityRank: 2, ...priced(1, 8) })), facts(record('local', 'q'))], features, DEFAULT_ROUTE_CONSTRAINTS)
      .find(candidate => candidate.key.model === 'grok-4.7-build-fast')!.live.costBasis).toBe('codex/terra')
  })
  it('decides from the utilities on the options', async () => {
    const decider = createScorerDecider()
    expect(decider.supports('route') && decider.supports('fallback') && !decider.supports('approval')).toBe(true)
    const outcome = await decider.decide({ kind: 'route', question: '?', options: [{ id: 'a', label: 'A', facts: { utility: 0.5 } }, { id: 'b', label: 'B', facts: { utility: 0.42 } }], state: {}, impact: 'routine', requester: 't' })
    expect(outcome.ok && outcome.verdict.probabilities.a).toBeCloseTo(Math.E / (Math.E + 1), 9)
    expect(await decider.decide({ kind: 'route', question: '?', options: [{ id: 'a', label: 'A' }], state: {}, impact: 'routine', requester: 't' })).toMatchObject({ ok: false })
  })
})
