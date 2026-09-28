/**
 * Reputation (docs/model-routing.md, module B): a Beta posterior per model key and dimension.
 * Pure: no store, no clock of its own. The prior is worth REPUTATION_POLICY.priorWeight
 * pseudo-observations, and every outcome counts 0.5^(ageDays/halfLifeDays), so a handful of
 * recent outcomes moves the estimate but cannot overwhelm a strong prior, and old ones fade.
 */
import { BEHAVIOUR_DIMENSIONS, modelKeyId, REPUTATION_POLICY, type BehaviourDimension, type BenchmarkResult, type ExecutionOutcome, type ModelKey, type ReputationScore, type TaskCategory } from '../../shared/model-routing'

export type ReputationDimension = TaskCategory | BehaviourDimension
export interface ReputationPrior { mean: number; source: ReputationScore['priorSource'] }

const DAY_MS = 86_400_000
/** A completed turn nothing verified counts as a success worth this much of a checked one. */
export const UNVERIFIED_WEIGHT = 0.5
/** z for the 10th percentile of a normal distribution. */
const Z10 = 1.2815515655446004
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))
const millis = (value: Date | string | number): number => value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)

export const isBehaviourDimension = (dimension: string): dimension is BehaviourDimension => (BEHAVIOUR_DIMENSIONS as readonly string[]).includes(dimension)

/** 0.5^(ageDays/halfLifeDays); a future or unparseable timestamp counts as now / not at all. */
export function recencyWeight(at: string, now: Date | string | number, halfLifeDays: number = REPUTATION_POLICY.halfLifeDays): number {
  const then = Date.parse(at)
  if (!Number.isFinite(then)) return 0
  return 0.5 ** (Math.max(0, millis(now) - then) / DAY_MS / halfLifeDays)
}

/** How good one outcome was on one dimension, 0..1, or null when it says nothing about it.
 *  Behaviour dimensions are the probability of *good* behaviour; cancelled work never counts. */
export function outcomeValue(outcome: ExecutionOutcome, dimension: ReputationDimension): number | null {
  if (outcome.result === 'cancelled') return null
  switch (dimension) {
    case 'reliability': return outcome.timedOut || outcome.contextFailure || outcome.invalidOutput ? 0 : outcome.toolFailures > 0 ? 0.5 : 1
    case 'instruction-following': return outcome.ownerCorrected ? 0 : outcome.verifier === 'pass' ? 1 : outcome.verifier === 'fail' ? 0 : null
    case 'loop-tendency': return outcome.looped ? 0 : 1
    // Only work that claimed to be done says anything about false completion.
    case 'false-completion': return outcome.falseCompletion ? 0 : outcome.result === 'success' || outcome.result === 'partial' || outcome.result === 'completed-unverified' ? 1 : null
    default:
      if (outcome.category !== dimension) return null
      return outcome.result === 'success' || outcome.result === 'completed-unverified' ? 1 : outcome.result === 'partial' ? 0.5 : 0
  }
}

/** The posterior for one key and dimension. `key` defaults to the outcomes' own; when given,
 *  outcomes of other keys are ignored. */
export function score(prior: ReputationPrior, outcomes: ExecutionOutcome[], dimension: ReputationDimension, now: Date | string | number, key?: ModelKey): ReputationScore {
  const id = key ? modelKeyId(key) : undefined
  const priorMean = clamp01(Number.isFinite(prior.mean) ? prior.mean : REPUTATION_POLICY.defaultPrior)
  let alpha = REPUTATION_POLICY.priorWeight * priorMean, beta = REPUTATION_POLICY.priorWeight * (1 - priorMean), evidence = 0, last: string | null = null
  for (const outcome of outcomes) {
    if (id && modelKeyId(outcome.key) !== id) continue
    const value = outcomeValue(outcome, dimension)
    if (value === null) continue
    const weight = recencyWeight(outcome.at, now) * (outcome.result === 'completed-unverified' ? UNVERIFIED_WEIGHT : 1)
    if (!weight) continue
    alpha += weight * value; beta += weight * (1 - value); evidence += weight
    if (!last || Date.parse(outcome.at) > Date.parse(last)) last = outcome.at
  }
  const total = alpha + beta
  const mean = total > 0 ? alpha / total : priorMean
  const sd = total > 0 ? Math.sqrt(alpha * beta / (total * total * (total + 1))) : 0
  return { key: key ?? outcomes[0]?.key ?? { provider: 'unknown', model: 'unknown' }, dimension, mean, lower: clamp01(mean - Z10 * sd), evidence, priorMean, priorSource: prior.source, lastOutcomeAt: last }
}

/** Benchmarks mapped to the category, else the family's other keys (evidence-weighted), else the
 *  default. Benchmarks carry no behaviour categories, so behaviour dimensions skip them. */
export function priorFor(key: ModelKey, dimension: ReputationDimension, benchmarks: BenchmarkResult[], familyScores: ReputationScore[]): ReputationPrior {
  const id = modelKeyId(key)
  const mapped = isBehaviourDimension(dimension) ? [] : benchmarks.filter(result => modelKeyId(result.key) === id && result.categories.includes(dimension) && Number.isFinite(result.score))
  if (mapped.length) return { mean: clamp01(mapped.reduce((sum, result) => sum + clamp01(result.score), 0) / mapped.length), source: 'benchmark' }
  const family = familyScores.filter(entry => modelKeyId(entry.key) !== id && entry.dimension === dimension && entry.evidence > 0 && Number.isFinite(entry.mean))
  const weight = family.reduce((sum, entry) => sum + entry.evidence, 0)
  if (weight > 0) return { mean: clamp01(family.reduce((sum, entry) => sum + entry.mean * entry.evidence, 0) / weight), source: 'family' }
  return { mean: REPUTATION_POLICY.defaultPrior, source: 'default' }
}

/** At least provenSamples non-cancelled outcomes, across every category, within one half-life. Counted,
 *  not summed by weight: summed weights stay just below the threshold at any age above zero. */
export function isProven(outcomes: ExecutionOutcome[], now: Date | string | number): boolean {
  let recent = 0
  for (const outcome of outcomes) if (outcome.result !== 'cancelled' && recencyWeight(outcome.at, now) >= 0.5) recent++
  return recent >= REPUTATION_POLICY.provenSamples
}
