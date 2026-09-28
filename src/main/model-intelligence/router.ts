import {
  DEFAULT_ROUTE_CONSTRAINTS, REPUTATION_POLICY, modelKeyId, type BehaviourDimension, type DecisionRecord, type DecisionRequest, type ModelKey,
  type RegistryRecord, type ReputationScore, type RouteCandidate, type RouteConstraints, type RouteDecision, type RoutingProvider, type TaskCategory, type TaskFeatures
} from '../../shared/model-routing'
import type { DecideOptions } from './decision-service'
import { SCORER_ID, capabilityPrior, conservative, defaultUsageStop, isLocal, percent, scoreCandidates, softmax, type CandidateFacts } from './deciders/scorer'

/**
 * route(features, constraints, ports): candidates from the registry and live state, the scorer's
 * probabilities, DecisionService's decision (a close call may go to the frontier), then fallback,
 * escalation and the reasons behind all of it. The model is ranked by key; when a family is served
 * by several providers, why this provider is its own reason.
 */

/** Live facts module E reads from the running app. */
export interface RouteLiveFacts {
  /** The provider is enabled in models.list; records of other providers are not candidates at all. */
  providerEnabled(provider: RoutingProvider): boolean
  /** The provider's usage-limit percent (the binding window), or null when unknown. */
  usagePercent(provider: RoutingProvider): number | null
  /** The owner's stop threshold; defaults to the idea-run weekly caps (claude 85, codex 95), else 95. */
  usageStopPercent?(provider: RoutingProvider): number
  /** Per key: the binding current window's percent and, when a window blocks this key now, why. Replaces
   *  usagePercent/usageStopPercent where given (reset and other models' windows are already left out). */
  usage?(key: ModelKey): { percent: number | null; blocked: string | null }
  /** Model names a llama.cpp server holds right now (local.servers). */
  loadedLocalModels(): string[]
  /** Whether a local model fits the VRAM and could be admitted now (no interactive turn holds the GPU). */
  localAdmission?(record: RegistryRecord): { fitsVram: boolean; admissible: boolean; reason?: string }
}
type RouteTarget = NonNullable<RouteDecision['fallback']>
export interface RouterPorts {
  records(): RegistryRecord[]
  /** Module B's reputation, null when none is known. */
  reputation(key: ModelKey, dimension: TaskCategory | BehaviourDimension): ReputationScore | null
  live: RouteLiveFacts
  decisions: { decide(request: DecisionRequest, options?: DecideOptions): Promise<DecisionRecord> }
}
export interface RouteOptions {
  requester?: string
  projectId?: string
  agentSessionId?: string
  contextStrategy?: RouteDecision['contextStrategy']
  signal?: AbortSignal
}

/** No candidate passed the hard filters; `candidates` says why each was excluded. */
export class RouteUnavailableError extends Error {
  constructor(message: string, readonly candidates: RouteCandidate[]) { super(message) }
}

const ROUTE_OPTIONS_MAX = 12
const EXCLUDED_REASONS_MAX = 4

export function pickEffort(efforts: string[], features: TaskFeatures): string | null {
  if (!efforts.length) return null
  const want = features.complexity >= 4 || features.risk === 'high' ? ['high', 'xhigh', 'max'] : features.complexity <= 2 ? ['low', 'minimal', 'medium'] : ['medium']
  return want.map(effort => efforts.find(offered => offered.toLowerCase() === effort)).find(Boolean)
    ?? (features.complexity >= 4 ? efforts[efforts.length - 1]! : features.complexity <= 2 ? efforts[0]! : efforts[Math.floor(efforts.length / 2)]!)
}

const bareLocal = (model: string) => model.replace(/^local\//, '')
export function candidateFacts(features: TaskFeatures, ports: Pick<RouterPorts, 'records' | 'reputation' | 'live'>): CandidateFacts[] {
  const loaded = new Set(ports.live.loadedLocalModels().map(bareLocal)), seen = new Set<string>()
  return ports.records().filter(record => {
    const id = modelKeyId(record.key)
    if (seen.has(id) || !ports.live.providerEnabled(record.key.provider)) return false
    seen.add(id)
    return true
  }).map(record => {
    const admission = isLocal(record) ? ports.live.localAdmission?.(record) ?? { fitsVram: true, admissible: true } : undefined
    const usage = ports.live.usage?.(record.key)
    return {
      record, effort: pickEffort(record.efforts, features),
      reputation: ports.reputation(record.key, features.category), loopTendency: ports.reputation(record.key, 'loop-tendency'), falseCompletion: ports.reputation(record.key, 'false-completion'),
      usagePercent: usage ? usage.percent : ports.live.usagePercent(record.key.provider), usageStopPercent: ports.live.usageStopPercent?.(record.key.provider) ?? defaultUsageStop(record.key.provider),
      ...(usage ? { usageBlocked: usage.blocked } : {}),
      ...(admission ? { local: { loaded: loaded.has(bareLocal(record.key.model)) || record.local?.loaded === true, ...admission } } : {}),
    }
  })
}

export function routeRequest(features: TaskFeatures, constraints: RouteConstraints, candidates: RouteCandidate[], options: RouteOptions = {}): DecisionRequest {
  const eligible = candidates.filter(candidate => candidate.eligible).slice(0, ROUTE_OPTIONS_MAX)
  return {
    kind: 'route', question: `Which model should take this ${features.category} task (complexity ${features.complexity}, ${features.risk} risk)?`,
    options: eligible.map(candidate => ({ id: modelKeyId(candidate.key), label: `${candidate.key.model} via ${candidate.key.provider}`,
      facts: { utility: candidate.utility, expectedSuccess: candidate.expectedSuccess, expectedCostUsd: candidate.expectedCostUsd, effort: candidate.effort,
        evidence: candidate.reputation ? Math.round(candidate.reputation.evidence * 10) / 10 : 0, priorSource: candidate.reputation?.priorSource ?? null, capabilityRank: candidate.live.capabilityRank ?? null } })),
    state: {
      features: { category: features.category, complexity: features.complexity, risk: features.risk, toolsRequired: features.toolsRequired.slice(0, 20), contextTokens: features.contextTokens, ...(features.summary ? { summary: features.summary.slice(0, 300) } : {}) },
      constraints: { costWeight: constraints.costWeight, latencyWeight: constraints.latencyWeight, maxCostUsd: constraints.maxCostUsd, localOnly: constraints.localOnly, excludeProviders: constraints.excludeProviders, urgency: constraints.urgency },
    },
    impact: features.risk === 'high' ? 'high' : 'routine',
    requester: options.requester ?? 'router',
    ...(options.projectId ?? features.projectId ? { projectId: options.projectId ?? features.projectId } : {}),
    ...(options.agentSessionId ? { agentSessionId: options.agentSessionId } : {}),
  }
}

const money = (value: number) => `$${value.toFixed(2)}`
const tokens = (value: number) => value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)

const rankNote = (candidate: RouteCandidate, features: TaskFeatures) => `capability rank ${candidate.live.capabilityRank ?? '?'} prior ${percent(capabilityPrior(Number(candidate.live.capabilityRank ?? 2), features))}`
function successReason(candidate: RouteCandidate, features: TaskFeatures): string {
  const reputation = candidate.reputation, basis = conservative(features) ? ' (10th percentile)' : ''
  if (!reputation || reputation.priorSource === 'default' && reputation.evidence < 0.5) return `${percent(candidate.expectedSuccess)} success on ${features.category}${basis} from the ${rankNote(candidate, features)}; no Conductor outcomes yet`
  if (reputation.priorSource === 'default') return `${percent(candidate.expectedSuccess)} success on ${features.category}${basis} (${Math.round(reputation.evidence)} weighted outcomes over the ${rankNote(candidate, features)}, ${REPUTATION_POLICY.halfLifeDays}-day half-life)`
  if (reputation.evidence < 0.5) return `${percent(candidate.expectedSuccess)} success on ${features.category}${basis} from the ${reputation.priorSource} prior; no Conductor outcomes yet`
  return `${percent(candidate.expectedSuccess)} success on ${features.category}${basis} (${Math.round(reputation.evidence)} weighted outcomes, ${REPUTATION_POLICY.halfLifeDays}-day half-life)`
}
function costReason(candidate: RouteCandidate, constraints: RouteConstraints): string {
  if (candidate.key.provider === 'local') return `local model: no per-token cost${candidate.live.loaded === true ? ', already loaded' : candidate.live.loaded === false ? ', needs a server start' : ''}`
  if (candidate.expectedCostUsd == null) return 'no per-token price known (subscription or unpriced); usage limits apply instead'
  return `expected cost ${money(candidate.expectedCostUsd)}${constraints.maxCostUsd != null ? ` within the ${money(constraints.maxCostUsd)} cap` : ''}`
}
function capabilityReason(candidate: RouteCandidate, record: RegistryRecord | undefined, features: TaskFeatures): string | null {
  const parts: string[] = []
  if (features.toolsRequired.length) parts.push(`tool use required: ${record?.toolUse === true ? 'supported' : 'not confirmed by any source'}`)
  if (features.contextTokens != null) parts.push(`${tokens(features.contextTokens)} context needed, ${record?.contextTokens != null ? tokens(record.contextTokens) + ' available' : 'window unknown'}`)
  return parts.length ? parts.join('; ') : null
}
/** Why this provider serves the family rather than another provider of the same weights. */
function providerReasons(selected: RouteCandidate, candidates: RouteCandidate[], records: Map<string, RegistryRecord>): string[] {
  const family = records.get(modelKeyId(selected.key))?.family
  if (!family) return []
  const peers = candidates.filter(candidate => candidate !== selected && candidate.key.provider !== selected.key.provider && records.get(modelKeyId(candidate.key))?.family === family)
  return peers.slice(0, 3).map(peer => {
    const why: string[] = []
    if (!peer.eligible) why.push(`${peer.key.provider} excluded: ${peer.excluded}`)
    else {
      if (selected.expectedCostUsd != null && peer.expectedCostUsd != null && selected.expectedCostUsd < peer.expectedCostUsd) why.push(`cheaper (${money(selected.expectedCostUsd)} vs ${money(peer.expectedCostUsd)})`)
      const mine = selected.live.usagePercent, theirs = peer.live.usagePercent
      if (typeof mine === 'number' && typeof theirs === 'number' && mine < theirs) why.push(`more quota left (${Math.round(mine)}% vs ${Math.round(theirs)}% used)`)
      if (selected.expectedLatencyMs != null && peer.expectedLatencyMs != null && selected.expectedLatencyMs < peer.expectedLatencyMs) why.push('faster')
      if (selected.expectedSuccess > peer.expectedSuccess) why.push(`better record here (${percent(selected.expectedSuccess)} vs ${percent(peer.expectedSuccess)})`)
      if (!why.length) why.push(`higher overall utility (${selected.utility.toFixed(3)} vs ${peer.utility.toFixed(3)})`)
    }
    return `provider ${selected.key.provider} over ${peer.key.provider} for ${family}: ${why.join(', ')}`
  })
}

export async function route(features: TaskFeatures, constraints: Partial<RouteConstraints> | undefined, ports: RouterPorts, options: RouteOptions = {}): Promise<RouteDecision> {
  const limits: RouteConstraints = { ...DEFAULT_ROUTE_CONSTRAINTS, ...constraints }
  const facts = candidateFacts(features, ports), records = new Map(facts.map(entry => [modelKeyId(entry.record.key), entry.record]))
  const candidates = scoreCandidates(facts, features, limits)
  const eligible = candidates.filter(candidate => candidate.eligible)
  if (!eligible.length) throw new RouteUnavailableError(candidates.length ? `No model passes the route's filters: ${candidates.slice(0, 5).map(candidate => `${modelKeyId(candidate.key)} (${candidate.excluded})`).join(', ')}` : 'No enabled provider offers a registered model', candidates)

  const request = routeRequest(features, limits, candidates, options)
  const record = await ports.decisions.decide(request, options.signal ? { signal: options.signal } : {})
  const byId = new Map(eligible.map(candidate => [modelKeyId(candidate.key), candidate]))
  const chosen = record.choice ? byId.get(record.choice) : undefined
  const selected = chosen ?? eligible[0]!
  let probabilities = record.probabilities, confidence = record.confidence, decidedBy = record.decidedBy
  if (!chosen) {
    const scorer = record.verdicts.find(verdict => 'probabilities' in verdict && verdict.decider === SCORER_ID)
    const offered = eligible.slice(0, ROUTE_OPTIONS_MAX), fallback = softmax(offered.map(candidate => candidate.utility))
    probabilities = scorer && 'probabilities' in scorer ? scorer.probabilities : Object.fromEntries(offered.map((candidate, index) => [modelKeyId(candidate.key), fallback[index]!]))
    confidence = probabilities[modelKeyId(selected.key)] ?? 0
    decidedBy = `${SCORER_ID} (no decider settled it)`
  }
  // Hard or risky work falls back to the strongest model elsewhere, never merely the next-best utility.
  const rank = (candidate: RouteCandidate) => Number(candidate.live.capabilityRank ?? 0)
  const strongest = (list: RouteCandidate[]) => [...list].sort((a, b) => rank(b) - rank(a) || b.utility - a.utility)[0]
  const others = eligible.filter(candidate => candidate.key.provider !== selected.key.provider)
  // Another provider survives an outage of this one, so it is preferred; only when none is eligible does the
  // fallback stay on this provider, as its strongest other model.
  const sameProvider = !others.length
  const fallback = (sameProvider ? strongest(eligible.filter(candidate => candidate !== selected)) : conservative(features) ? strongest(others) : others[0]) ?? null
  const otherProviders = [...new Set(candidates.map(candidate => candidate.key.provider).filter(provider => provider !== selected.key.provider))]
  const whyNoOther = otherProviders.length ? otherProviders.map(provider => `${provider}: ${candidates.find(candidate => candidate.key.provider === provider)?.excluded ?? 'not eligible'}`).join('; ') : 'no other provider is offered'
  const escalation = eligible.filter(candidate => candidate !== selected && candidate.expectedSuccess > selected.expectedSuccess)
    .sort((a, b) => b.expectedSuccess - a.expectedSuccess || b.utility - a.utility)[0] ?? null
  const target = (candidate: RouteCandidate | null, reason: string): RouteTarget | null => candidate && { key: candidate.key, effort: candidate.effort, reason }
  const fallbackTarget = fallback && target(fallback, sameProvider
    ? `no other provider eligible (${whyNoOther}); same-provider fallback (capability rank ${rank(fallback)}, ${percent(fallback.expectedSuccess)} expected)`
    : conservative(features)
    ? `strongest eligible model on another provider (capability rank ${rank(fallback)}, ${percent(fallback.expectedSuccess)} expected)`
    : `best eligible model on another provider (${percent(fallback.expectedSuccess)} expected, utility ${fallback.utility.toFixed(3)})`)
  const escalationTarget = escalation && target(escalation, `higher expected success on ${features.category}: ${percent(escalation.expectedSuccess)} against ${percent(selected.expectedSuccess)}`)

  const excluded = candidates.filter(candidate => !candidate.eligible)
  const reasons = [successReason(selected, features), costReason(selected, limits),
    ...excluded.slice(0, EXCLUDED_REASONS_MAX).map(candidate => `${modelKeyId(candidate.key)} excluded: ${candidate.excluded}`),
    ...(excluded.length > EXCLUDED_REASONS_MAX ? [`${excluded.length - EXCLUDED_REASONS_MAX} more excluded`] : []),
    capabilityReason(selected, records.get(modelKeyId(selected.key)), features),
    ...providerReasons(selected, candidates, records),
    selected.effort ? `effort ${selected.effort} for complexity ${features.complexity}, ${features.risk} risk` : null,
    !chosen ? `no decider settled it (${record.rationale}); the scorer's top candidate is used` : record.escalated ? `close call escalated (${record.escalationReason}); ${record.decidedBy} chose` : record.escalationReason ? `${record.escalationReason}: the scorer's top candidate stands` : null,
  ].filter((reason): reason is string => !!reason)

  return {
    decisionId: record.id,
    selected: { key: selected.key, effort: selected.effort },
    contextStrategy: options.contextStrategy ?? 'fresh',
    fallback: fallbackTarget,
    escalation: escalationTarget,
    maxCostUsd: limits.maxCostUsd, confidence, probabilities, reasons, candidates, decidedBy, escalated: record.escalated,
  }
}
