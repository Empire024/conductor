import { IDEA_RUN_DEFAULT_WEEKLY_CAPS } from '../../../shared/idea-runs'
import type { AgentProviderId } from '../../../shared/models'
import {
  REPUTATION_POLICY, capabilityRank, modelKeyId, type Decider, type DeciderOutcome, type DecisionKind, type DecisionRequest, type RegistryRecord,
  type ReputationScore, type RouteCandidate, type RouteConstraints, type TaskFeatures
} from '../../../shared/model-routing'

/**
 * The deterministic system-one decider for kinds route and fallback (docs/model-routing.md):
 * hard filters, then utility = success − cost − latency − load − behaviour, then softmax at T.
 * scoreCandidates does the work from registry facts; the Decider only turns the utilities the
 * router put on each option into probabilities, so the verdict is reproducible from the journal.
 */

export const SCORER_TEMPERATURE = 0.08
export const SCORER_ID = 'scorer'
/**
 * Local candidates are judged on a Wilson interval (z = 1) of their category success, blended with
 * `priorWeight` pseudo-outcomes at the capability prior, so 0 outcomes, 3 of 5 and 5 of 8 sit on one
 * smooth, monotone scale: a local model is excluded once the interval's upper bound falls below
 * `threshold` (it is shown to be bad), and it takes hard or high-risk work only once the lower bound
 * reaches `threshold` with at least `provenEvidence` outcomes (it is shown to be good).
 */
export const LOCAL_EXCLUSION = { threshold: 0.5, z: 1, priorWeight: 4, provenEvidence: 5 } as const
/** Success expected of a capability rank (0 local .. 3 frontier) with no Conductor evidence, and how
 *  much of it each complexity step above 3 takes away: weaker models lose more on hard work. */
export const CAPABILITY_PRIOR = { base: [0.55, 0.65, 0.72, 0.8], hardStep: [0.1, 0.07, 0.04, 0.01] } as const
/** Evidence behaviour penalties reach full weight at. */
const BEHAVIOUR_EVIDENCE = 5
export const LOAD_PENALTY = 0.05
export const BEHAVIOUR_WEIGHT = 0.25
/** Absolute log scales from a floor to a ceiling (0..1): every tenfold step in cost or time weighs the
 *  same, and filtering one candidate out never reprices the others. */
export const COST_SCALE_USD = { floor: 0.001, ceiling: 10 } as const
export const LATENCY_SCALE_MS = { floor: 100, ceiling: 600_000 } as const
const NEUTRAL = 0.5
const logScale = (value: number | null, scale: { floor: number; ceiling: number }) => value == null ? NEUTRAL : Math.min(1, Math.log10(1 + value / scale.floor) / Math.log10(1 + scale.ceiling / scale.floor))
const TURNS_BY_COMPLEXITY = [1, 2, 4, 8, 14] as const
const OUTPUT_BY_COMPLEXITY = [800, 1_500, 3_000, 6_000, 10_000] as const
const BASE_CONTEXT = 12_000

/** The facts one registry record contributes to a route, merged with live state by the router. */
export interface CandidateFacts {
  record: RegistryRecord
  effort: string | null
  /** Category reputation (module B), null when none is known. */
  reputation: ReputationScore | null
  loopTendency: ReputationScore | null
  falseCompletion: ReputationScore | null
  usagePercent: number | null
  usageStopPercent: number
  /** Set when the app judged usage per key: why a current window blocks it now, or null. The percent is then informational. */
  usageBlocked?: string | null
  /** Local only: a llama.cpp server holds this model, it fits the VRAM, it can be admitted now. */
  local?: { loaded: boolean; fitsVram: boolean; admissible: boolean; reason?: string }
}

export const defaultUsageStop = (provider: string): number => (IDEA_RUN_DEFAULT_WEEKLY_CAPS as Record<string, number>)[provider] ?? 95
export const isLocal = (record: RegistryRecord): boolean => record.key.provider === 'local'
export const rankOf = (record: RegistryRecord): number => record.capabilityRank ?? capabilityRank(record.key.provider as AgentProviderId, record.key.model)
export function capabilityPrior(rank: number, features: TaskFeatures): number {
  const index = Math.min(3, Math.max(0, Math.round(rank)))
  return CAPABILITY_PRIOR.base[index]! - Math.max(0, features.complexity - 3) * CAPABILITY_PRIOR.hardStep[index]!
}
/** Beta successes a score's posterior implies (evidence-weighted), recovered from its mean and prior. */
const impliedSuccesses = (score: ReputationScore): number => Math.min(score.evidence, Math.max(0, score.mean * (REPUTATION_POLICY.priorWeight + score.evidence) - REPUTATION_POLICY.priorWeight * score.priorMean))
const Z10 = 1.2815515655446004
/**
 * The reputation routing uses. A benchmark or family prior is real information and stays; a default
 * prior (or no score at all) is replaced by the capability prior with the same Conductor evidence, so
 * a fresh install still tells Opus from a small local model.
 */
export function effectiveReputation(score: ReputationScore | null, record: RegistryRecord, features: TaskFeatures): ReputationScore {
  if (score && score.priorSource !== 'default') return score
  const prior = capabilityPrior(rankOf(record), features), weight = REPUTATION_POLICY.priorWeight
  const evidence = score?.evidence ?? 0, successes = score ? impliedSuccesses(score) : 0
  const alpha = weight * prior + successes, beta = weight * (1 - prior) + evidence - successes, total = alpha + beta
  const mean = alpha / total, sd = Math.sqrt(alpha * beta / (total * total * (total + 1)))
  return { key: record.key, dimension: features.category, mean, lower: Math.min(1, Math.max(0, mean - Z10 * sd)), evidence, priorMean: prior, priorSource: 'default', lastOutcomeAt: score?.lastOutcomeAt ?? null }
}
/** Wilson interval of a success rate blended with pseudo-outcomes at a prior. */
export function wilson(successes: number, evidence: number, prior: number, z: number = LOCAL_EXCLUSION.z, priorWeight: number = LOCAL_EXCLUSION.priorWeight): { lower: number; upper: number; rate: number } {
  const n = evidence + priorWeight, rate = (successes + priorWeight * prior) / n, z2 = z * z
  const centre = (rate + z2 / (2 * n)) / (1 + z2 / n), half = z * Math.sqrt(rate * (1 - rate) / n + z2 / (4 * n * n)) / (1 + z2 / n)
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half), rate }
}
/** The local model's category record on the Wilson scale (see LOCAL_EXCLUSION). */
export function localRecord(score: ReputationScore | null, record: RegistryRecord, features: TaskFeatures): { lower: number; upper: number; evidence: number; successes: number } {
  const evidence = score?.evidence ?? 0, successes = score ? impliedSuccesses(score) : 0
  return { ...wilson(successes, evidence, capabilityPrior(rankOf(record), features)), evidence, successes }
}

/** Tokens one task of these features is expected to read and write, over all its turns. */
export function estimateTokens(features: TaskFeatures): { input: number; output: number } {
  const step = features.complexity - 1
  return { input: Math.max(features.contextTokens ?? 0, BASE_CONTEXT) * TURNS_BY_COMPLEXITY[step]!, output: OUTPUT_BY_COMPLEXITY[step]! }
}
export function expectedCost(record: RegistryRecord, features: TaskFeatures): number | null {
  if (isLocal(record)) return 0
  const price = record.pricing
  if (price?.inputPerMTok == null || price.outputPerMTok == null) return null
  const tokens = estimateTokens(features)
  return (tokens.input * price.inputPerMTok + tokens.output * price.outputPerMTok) / 1_000_000
}
export function expectedLatency(record: RegistryRecord, features: TaskFeatures): number | null {
  if (record.latencyMs == null && record.tokensPerSecond == null) return null
  const tokens = estimateTokens(features)
  return (record.latencyMs ?? 0) * TURNS_BY_COMPLEXITY[features.complexity - 1]! + (record.tokensPerSecond ? tokens.output / record.tokensPerSecond * 1000 : 0)
}
/** How much success is worth against cost: trivial low-risk work lets cost win, hard high-risk work does not. */
export function stakes(features: TaskFeatures): number {
  const value = 1 + (features.complexity - 3) * 0.25 + (features.risk === 'high' ? 0.5 : features.risk === 'low' ? -0.25 : 0)
  return Math.min(2, Math.max(0.25, value))
}
/** The conservative estimate for hard or risky work, the mean otherwise. */
export const conservative = (features: TaskFeatures): boolean => features.risk === 'high' || features.complexity >= 4
export function expectedSuccess(reputation: ReputationScore | null, features: TaskFeatures): number {
  if (!reputation) return REPUTATION_POLICY.defaultPrior
  return conservative(features) ? reputation.lower : reputation.mean
}
const behaviourPenalty = (score: ReputationScore | null): number => score ? BEHAVIOUR_WEIGHT * (1 - score.mean) * Math.min(1, score.evidence / BEHAVIOUR_EVIDENCE) : 0
const tokenCount = (tokens: number) => tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
export const percent = (value: number): string => `${Math.round(value * 100)}%`

/** The first hard filter a candidate fails, or null. */
export function hardFilter(facts: CandidateFacts, features: TaskFeatures, constraints: RouteConstraints, cost: number | null): string | null {
  const { record } = facts, id = modelKeyId(record.key)
  if (record.status === 'retired') return 'retired'
  if (record.availability === 'unavailable' || record.availability === 'deprecated') return `availability ${record.availability}`
  if (constraints.localOnly && !isLocal(record)) return 'local only'
  if (constraints.excludeProviders.includes(record.key.provider)) return `provider ${record.key.provider} excluded`
  if (constraints.allow && !constraints.allow.some(key => modelKeyId(key) === id)) return 'not in the allowed shortlist'
  if (features.toolsRequired.length && record.toolUse === false) return 'no tool use'
  if (features.contextTokens != null && record.contextTokens != null && features.contextTokens > record.contextTokens) return `${tokenCount(features.contextTokens)} context needed, ${tokenCount(record.contextTokens)} available`
  if (constraints.maxCostUsd != null && cost != null && cost > constraints.maxCostUsd) return `expected cost $${cost.toFixed(2)} over the $${constraints.maxCostUsd.toFixed(2)} cap`
  if (facts.usageBlocked) return `usage: ${facts.usageBlocked}`
  if (facts.usageBlocked === undefined && facts.usagePercent != null && facts.usagePercent >= facts.usageStopPercent) return `usage ${Math.round(facts.usagePercent)}% at or above the ${facts.usageStopPercent}% stop`
  if (facts.local && !facts.local.fitsVram) return facts.local.reason ?? 'does not fit the VRAM'
  if (facts.local && !facts.local.admissible) return facts.local.reason ?? 'cannot be admitted now'
  if (isLocal(record)) {
    const local = localRecord(facts.reputation, record, features), outcomes = `${Math.round(local.successes)} of ${Math.round(local.evidence)} outcomes`
    if (local.upper < LOCAL_EXCLUSION.threshold) return `at most ${percent(local.upper)} likely success on ${features.category} (${outcomes})`
    if (conservative(features) && (local.evidence < LOCAL_EXCLUSION.provenEvidence || local.lower < LOCAL_EXCLUSION.threshold))
      return `no proven record on ${features.category} for complexity ${features.complexity}, ${features.risk}-risk work (${outcomes}; needs ${LOCAL_EXCLUSION.provenEvidence}+ with at least ${percent(LOCAL_EXCLUSION.threshold)} likely)`
  }
  return null
}

/** Every candidate with its filter verdict and utility; eligible ones first, by utility. */
export function scoreCandidates(all: CandidateFacts[], features: TaskFeatures, constraints: RouteConstraints): RouteCandidate[] {
  const costs = all.map(facts => expectedCost(facts.record, features)), latencies = all.map(facts => expectedLatency(facts.record, features))
  const excluded = all.map((facts, index) => hardFilter(facts, features, constraints, costs[index]!))
  const latencyWeight = Math.min(1, constraints.latencyWeight * (constraints.urgency === 'urgent' ? 2 : 1)), weight = stakes(features)
  const candidates = all.map((facts, index): RouteCandidate => {
    const cost = costs[index]!, latency = latencies[index]!, success = expectedSuccess(effectiveReputation(facts.reputation, facts.record, features), features)
    const normCost = logScale(cost, COST_SCALE_USD), normLatency = logScale(latency, LATENCY_SCALE_MS)
    const load = facts.local && !facts.local.loaded ? LOAD_PENALTY : 0
    const utility = weight * success - constraints.costWeight * normCost - latencyWeight * normLatency - load - behaviourPenalty(facts.loopTendency) - behaviourPenalty(facts.falseCompletion)
    const live: RouteCandidate['live'] = { usagePercent: facts.usagePercent, usageStopPercent: facts.usageStopPercent, availability: facts.record.availability, status: facts.record.status, capabilityRank: rankOf(facts.record) }
    if (facts.local) Object.assign(live, { loaded: facts.local.loaded, fitsVram: facts.local.fitsVram, admissible: facts.local.admissible })
    return { key: facts.record.key, effort: facts.effort, eligible: !excluded[index], excluded: excluded[index]!, expectedSuccess: success, expectedCostUsd: cost, expectedLatencyMs: latency, utility, reputation: facts.reputation, live }
  })
  return candidates.map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => Number(b.candidate.eligible) - Number(a.candidate.eligible) || b.candidate.utility - a.candidate.utility || a.index - b.index).map(entry => entry.candidate)
}

export function softmax(utilities: number[], temperature = SCORER_TEMPERATURE): number[] {
  if (!utilities.length) return []
  const top = Math.max(...utilities), weights = utilities.map(utility => Math.exp((utility - top) / temperature)), total = weights.reduce((sum, value) => sum + value, 0)
  return weights.map(value => value / total)
}

const SCORER_KINDS: DecisionKind[] = ['route', 'fallback']
/** Reads `facts.utility` from each option (the router puts it there) and softmaxes it. */
export function createScorerDecider(temperature = SCORER_TEMPERATURE): Decider {
  return {
    id: SCORER_ID, tier: 'system-one',
    supports: kind => SCORER_KINDS.includes(kind),
    async decide(request: DecisionRequest): Promise<DeciderOutcome> {
      const started = Date.now(), utilities = request.options.map(option => option.facts?.utility)
      if (utilities.some(value => typeof value !== 'number' || !Number.isFinite(value))) return { ok: false, decider: SCORER_ID, reason: 'An option carries no numeric utility' }
      const probabilities = softmax(utilities as number[], temperature)
      const best = probabilities.indexOf(Math.max(...probabilities))
      return { ok: true, verdict: { decider: SCORER_ID, probabilities: Object.fromEntries(request.options.map((option, index) => [option.id, probabilities[index]!])),
        rationale: `Highest utility ${(utilities[best] as number).toFixed(3)}: ${request.options[best]!.label} (softmax T=${temperature})`, tokens: null, elapsedMs: Date.now() - started } }
    },
  }
}
