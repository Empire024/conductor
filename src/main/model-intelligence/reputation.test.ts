import { describe, expect, it } from 'vitest'
import { REPUTATION_POLICY, type BenchmarkResult, type ExecutionOutcome, type ModelKey, type ReputationScore, type TaskCategory } from '../../shared/model-routing'
import { outcome } from './capture/common'
import { isProven, outcomeValue, priorFor, recencyWeight, score } from './reputation'

const NOW = Date.parse('2026-09-28T12:00:00Z'), DAY = 86_400_000
const key: ModelKey = { provider: 'claude', model: 'opus' }
let seq = 0
const run = (result: ExecutionOutcome['result'], category: TaskCategory = 'debugging', daysAgo = 0, extra: Partial<ExecutionOutcome> = {}): ExecutionOutcome =>
  outcome({ key, source: 'turn', ref: `t${seq++}`, category, at: new Date(NOW - daysAgo * DAY).toISOString(), result, ...extra })
const flat = { mean: REPUTATION_POLICY.defaultPrior, source: 'default' as const }

describe('reputation.score', () => {
  it('returns the prior with no evidence', () => {
    const result = score(flat, [], 'debugging', NOW, key)
    expect(result).toMatchObject({ mean: 0.6, evidence: 0, priorMean: 0.6, priorSource: 'default', lastOutcomeAt: null, key })
    expect(result.lower).toBeLessThan(result.mean)
  })
  it('outcomes move the score both ways', () => {
    const up = score(flat, Array.from({ length: 10 }, () => run('success')), 'debugging', NOW)
    const down = score(flat, Array.from({ length: 10 }, () => run('failure')), 'debugging', NOW)
    expect(up.mean).toBeGreaterThan(0.8); expect(down.mean).toBeLessThan(0.3)
    expect(up.evidence).toBeCloseTo(10); expect(up.lower).toBeLessThan(up.mean)
    const partial = score(flat, [run('partial'), run('partial')], 'debugging', NOW)
    expect(partial.mean).toBeCloseTo((4.8 + 1) / 10)
  })
  it('skips cancelled outcomes', () => {
    expect(score(flat, [run('cancelled'), run('cancelled')], 'debugging', NOW).evidence).toBe(0)
  })
  it('keeps categories distinct', () => {
    const outcomes = [...Array.from({ length: 6 }, () => run('success', 'simple-coding')), ...Array.from({ length: 6 }, () => run('failure', 'architecture'))]
    const simple = score(flat, outcomes, 'simple-coding', NOW), arch = score(flat, outcomes, 'architecture', NOW), other = score(flat, outcomes, 'research', NOW)
    expect(simple.mean).toBeGreaterThan(0.7); expect(arch.mean).toBeLessThan(0.4)
    expect(other).toMatchObject({ mean: 0.6, evidence: 0 })
  })
  it('two failures do not sink a strong prior', () => {
    const result = score({ mean: 0.9, source: 'benchmark' }, [run('failure'), run('failure')], 'debugging', NOW)
    // (8·0.9) / (8 + 2) = 0.72
    expect(result.mean).toBeCloseTo(0.72)
    expect(result.mean).toBeGreaterThan(REPUTATION_POLICY.defaultPrior)
    expect(result.priorSource).toBe('benchmark')
  })
  it('recency decay makes old failures matter less', () => {
    const recent = score(flat, Array.from({ length: 5 }, () => run('failure', 'debugging', 1)), 'debugging', NOW)
    const old = score(flat, Array.from({ length: 5 }, () => run('failure', 'debugging', 120)), 'debugging', NOW)
    expect(old.mean).toBeGreaterThan(recent.mean)
    expect(old.evidence).toBeCloseTo(5 / 16)
    expect(recencyWeight(new Date(NOW - 30 * DAY).toISOString(), NOW)).toBeCloseTo(0.5)
    // old failures, recent successes: the successes dominate
    const mixed = score(flat, [...Array.from({ length: 4 }, () => run('failure', 'debugging', 90)), ...Array.from({ length: 4 }, () => run('success', 'debugging', 0))], 'debugging', NOW)
    expect(mixed.mean).toBeCloseTo((4.8 + 4) / (8 + 4 + 0.5)) // undecayed it would be (4.8 + 4) / 16 = 0.55
    expect(mixed.lastOutcomeAt).toBe(new Date(NOW).toISOString())
  })
  it('ignores other keys when a key is given', () => {
    const foreign = outcome({ key: { provider: 'codex', model: 'gpt-6' }, source: 'turn', ref: 'x', category: 'debugging', at: new Date(NOW).toISOString(), result: 'failure' })
    expect(score(flat, [foreign], 'debugging', NOW, key).evidence).toBe(0)
  })
  it('lower is clamped to 0..1', () => {
    const result = score({ mean: 0, source: 'default' }, Array.from({ length: 3 }, () => run('failure')), 'debugging', NOW)
    expect(result.lower).toBe(0)
  })
})

describe('behaviour dimensions', () => {
  it('score the probability of good behaviour', () => {
    expect(outcomeValue(run('failure', 'debugging', 0, { timedOut: true }), 'reliability')).toBe(0)
    expect(outcomeValue(run('success', 'debugging', 0, { toolFailures: 2 }), 'reliability')).toBe(0.5)
    expect(outcomeValue(run('success'), 'reliability')).toBe(1)
    expect(outcomeValue(run('success', 'debugging', 0, { verifier: 'pass' }), 'instruction-following')).toBe(1)
    expect(outcomeValue(run('success'), 'instruction-following')).toBeNull()
    expect(outcomeValue(run('success', 'debugging', 0, { ownerCorrected: true }), 'instruction-following')).toBe(0)
    expect(outcomeValue(run('failure', 'debugging', 0, { looped: true }), 'loop-tendency')).toBe(0)
    expect(outcomeValue(run('failure'), 'false-completion')).toBeNull()
    expect(outcomeValue(run('failure', 'debugging', 0, { falseCompletion: true }), 'false-completion')).toBe(0)
  })
  it('span categories', () => {
    const loops = [run('failure', 'debugging', 0, { looped: true }), run('failure', 'research', 0, { looped: true }), run('failure', 'frontend', 0, { looped: true })]
    const result = score(flat, loops, 'loop-tendency', NOW)
    expect(result.evidence).toBeCloseTo(3); expect(result.mean).toBeCloseTo(4.8 / 11)
  })
})

describe('priorFor', () => {
  const bench = (score: number, categories: TaskCategory[], k: ModelKey = key): BenchmarkResult => ({ key: k, benchmark: 'swe-bench', score, raw: String(score), categories, source: { kind: 'benchmark', name: 'swe' }, observedAt: '2026-09-01T00:00:00Z' })
  const fam = (model: string, mean: number, evidence: number): ReputationScore => ({ key: { provider: 'claude', model }, dimension: 'debugging', mean, lower: mean - 0.1, evidence, priorMean: 0.6, priorSource: 'default', lastOutcomeAt: null })
  it('prefers a benchmark mapped to the category', () => {
    expect(priorFor(key, 'debugging', [bench(0.8, ['debugging']), bench(0.6, ['debugging'])], [fam('sonnet', 0.2, 10)])).toEqual({ mean: 0.7, source: 'benchmark' })
  })
  it('falls back to the family, evidence-weighted, excluding itself', () => {
    expect(priorFor(key, 'debugging', [bench(0.9, ['research'])], [fam('sonnet', 0.8, 3), fam('haiku', 0.4, 1), fam('opus', 0.1, 50)])).toMatchObject({ source: 'family' })
    expect(priorFor(key, 'debugging', [], [fam('sonnet', 0.8, 3), fam('haiku', 0.4, 1)]).mean).toBeCloseTo(0.7)
  })
  it('then to the default; behaviour dimensions skip benchmarks', () => {
    expect(priorFor(key, 'debugging', [], [fam('sonnet', 0.8, 0)])).toEqual({ mean: REPUTATION_POLICY.defaultPrior, source: 'default' })
    expect(priorFor(key, 'reliability', [bench(0.9, ['debugging'])], [])).toEqual({ mean: REPUTATION_POLICY.defaultPrior, source: 'default' })
  })
})

describe('completed-unverified', () => {
  it('counts as a success at half the weight of a checked one', () => {
    const flat = { mean: 0.6, source: 'default' as const }
    const unverified = score(flat, Array.from({ length: 4 }, () => run('completed-unverified')), 'debugging', NOW)
    const verified = score(flat, Array.from({ length: 2 }, () => run('success')), 'debugging', NOW)
    expect(unverified.evidence).toBeCloseTo(2, 9)
    expect(unverified.mean).toBeCloseTo(verified.mean, 9)
    expect(outcomeValue(run('completed-unverified'), 'false-completion')).toBe(1)
  })
})

describe('isProven', () => {
  it('needs provenSamples non-cancelled outcomes within one half-life, across categories', () => {
    const categories: TaskCategory[] = ['debugging', 'research', 'frontend']
    expect(isProven(Array.from({ length: 12 }, (_, i) => run('success', categories[i % 3]!)), NOW)).toBe(true)
    expect(isProven(Array.from({ length: 11 }, () => run('failure')), NOW)).toBe(false)
    expect(isProven(Array.from({ length: 20 }, () => run('cancelled')), NOW)).toBe(false)
    expect(isProven(Array.from({ length: 20 }, () => run('success', 'debugging', 60)), NOW)).toBe(false)
  })
  it('counts exactly 12 fresh outcomes as proven and 12 old ones as not', () => {
    expect(isProven(Array.from({ length: 12 }, () => run('success', 'debugging', 1 / 1440)), NOW)).toBe(true)
    expect(isProven(Array.from({ length: 12 }, () => run('success', 'debugging', 40)), NOW)).toBe(false)
    expect(isProven([...Array.from({ length: 11 }, () => run('failure')), run('success', 'research', 29)], NOW)).toBe(true)
    expect(isProven([...Array.from({ length: 11 }, () => run('failure')), run('success', 'research', 31)], NOW)).toBe(false)
  })
})
