/**
 * Model intelligence and routing: the shared contract (docs/model-routing.md).
 *
 * Every module of src/main/model-intelligence/ and every caller outside it speaks these types.
 * A model is only ever identified together with the provider that serves it (ModelKey): the same
 * weights behind two providers are two records with separate prices, limits and reputations.
 */
import type { AgentProviderId } from './models'
import { promotedRank } from './promoted-models'

/** Capability comes before quota. This intentionally classifies names conservatively. */
export function capabilityRank(provider: AgentProviderId, modelId: string): 0 | 1 | 2 | 3 {
  const id = modelId.toLowerCase()
  if (provider === 'local' || id.startsWith('local/')) return 0
  // A model the owner accepted through an auto model upgrade ranks as the one it replaced.
  const promoted = promotedRank(provider, modelId)
  if (promoted !== null) return promoted
  // GPT-6.1 Sol is the frontier workhorse ("near-Astra performance at a lower cost", codex-cli 0.159.1
  // model/list); the owner prefers it over Astra, so it ranks with the frontier despite its tier name.
  if (/gpt-6\.1-sol/.test(id)) return 3
  // Tier names first: a generation prefix (gpt-6) says nothing about the tier within it.
  if (/astra|opus/.test(id)) return 3
  if (/terra|sonnet/.test(id)) return 2
  if (/luna|\bsol\b|haiku|mini|cheap/.test(id)) return 1
  if (/gpt-6/.test(id)) return 3
  if (/gpt-5\.5/.test(id)) return 2
  return 2
}

export function coordinatorEffort(efforts: readonly string[] | undefined, fallback?: string): string | undefined {
  if (!efforts?.length) return undefined
  if (efforts.includes('high')) return 'high'
  if (fallback && efforts.includes(fallback)) return fallback
  return efforts.includes('xhigh') ? 'xhigh' : efforts[0]
}

export type RoutingProvider = 'claude' | 'codex' | 'grok' | 'gemini' | 'qwen' | 'kimi' | 'local' | 'cloud' | (string & {})

export interface ModelKey { provider: RoutingProvider; model: string }
/** Stable string form, `provider/model`, used as the storage key; a local model id that already carries `local/` is not doubled. */
export const modelKeyId = (key: ModelKey): string => key.provider === 'local' && key.model.startsWith('local/') ? key.model : `${key.provider}/${key.model}`

// ---------------------------------------------------------------------------------------------
// Registry

/** Who said it. Higher authority wins for factual fields; benchmarks never overwrite creator facts. */
export type SourceKind = 'creator' | 'provider-docs' | 'cli' | 'config' | 'aggregator' | 'benchmark' | 'conductor'
export const SOURCE_AUTHORITY: Record<SourceKind, number> = { cli: 6, creator: 5, 'provider-docs': 4, config: 3, conductor: 3, aggregator: 2, benchmark: 1 }

export interface SourceRef { kind: SourceKind; name: string; url?: string }

/** One observed value of one field of one model, with provenance. Never overwritten: a new value
 *  is a new observation, and the effective record is derived (authority, then recency). */
export interface FieldObservation {
  key: ModelKey
  field: RegistryField
  value: RegistryValue
  source: SourceRef
  observedAt: string
}

export type RegistryField =
  | 'displayName' | 'family' | 'releasedAt' | 'deprecatedAt' | 'contextTokens' | 'maxOutputTokens'
  | 'modalities' | 'toolUse' | 'efforts' | 'priceInputPerMTok' | 'priceOutputPerMTok' | 'priceCachedInputPerMTok'
  | 'latencyMs' | 'tokensPerSecond' | 'availability' | 'capabilities'
  | 'localSizeGb' | 'localQuant' | 'localVramGb' | 'localGpuLayers'
export type RegistryValue = string | number | boolean | string[] | null

export type Availability = 'available' | 'limited' | 'unavailable' | 'deprecated' | 'unknown'
/** unproven: registered, no Conductor evidence yet. evaluating: an evaluation run is in flight.
 *  proven: enough Conductor evidence (see REPUTATION_POLICY.provenSamples). retired: gone from every source. */
export type ModelStatus = 'unproven' | 'evaluating' | 'proven' | 'retired'

export interface RegistryRecord {
  key: ModelKey
  status: ModelStatus
  displayName: string
  family: string | null
  releasedAt: string | null
  deprecatedAt: string | null
  contextTokens: number | null
  maxOutputTokens: number | null
  modalities: string[]
  toolUse: boolean | null
  efforts: string[]
  pricing: { inputPerMTok: number | null; outputPerMTok: number | null; cachedInputPerMTok: number | null; currency: 'USD' } | null
  latencyMs: number | null
  tokensPerSecond: number | null
  availability: Availability
  capabilities: string[]
  local: { sizeGb: number | null; quant: string | null; vramGb: number | null; gpuLayers: number | null; loaded: boolean } | null
  /** field -> the observation that won, for audit. */
  provenance: Partial<Record<RegistryField, { source: SourceRef; observedAt: string }>>
  firstSeenAt: string
  updatedAt: string
  /** True when no source has confirmed this record within REGISTRY_STALE_DAYS. */
  stale: boolean
  /** capabilityRank of the model or its family (0 local .. 3 frontier), for a scorer without evidence. */
  capabilityRank?: 0 | 1 | 2 | 3
}
export const REGISTRY_STALE_DAYS = 7

/** A public benchmark score: a prior, kept apart from creator claims and from Conductor evidence. */
export interface BenchmarkResult {
  key: ModelKey
  benchmark: string
  /** 0..1 after normalisation; raw keeps the published figure. */
  score: number
  raw: string
  categories: TaskCategory[]
  source: SourceRef
  observedAt: string
}

/** What one ingestion pass found; the registry applies it atomically or not at all. */
export interface IngestionBatch {
  source: SourceRef
  fetchedAt: string
  observations: FieldObservation[]
  benchmarks: BenchmarkResult[]
  /** Keys this source lists in full; a key it listed before and omits now is a removal signal. */
  complete: boolean
}
export type RegistryChangeKind = 'new-model' | 'updated' | 'deprecated' | 'removed' | 'price' | 'context' | 'capability' | 'availability' | 'new-provider'
export interface RegistryChange { kind: RegistryChangeKind; key: ModelKey; field?: RegistryField; before?: RegistryValue; after?: RegistryValue; source: SourceRef; at: string }

// ---------------------------------------------------------------------------------------------
// Tasks and telemetry

export const TASK_CATEGORIES = [
  'simple-coding', 'difficult-coding', 'large-repo', 'debugging', 'architecture', 'frontend', 'research',
  'browser-use', 'terminal-use', 'file-analysis', 'long-context', 'vision', 'tool-calling',
  'structured-output', 'summarization', 'review', 'decision', 'general',
] as const
export type TaskCategory = typeof TASK_CATEGORIES[number]
/** Behavioural dimensions every execution feeds, whatever its category. */
export const BEHAVIOUR_DIMENSIONS = ['reliability', 'instruction-following', 'loop-tendency', 'false-completion'] as const
export type BehaviourDimension = typeof BEHAVIOUR_DIMENSIONS[number]

/** The compact task state a router or decider sees; never a chat history. */
export interface TaskFeatures {
  category: TaskCategory
  /** 1 trivial .. 5 hardest. */
  complexity: 1 | 2 | 3 | 4 | 5
  risk: 'low' | 'medium' | 'high'
  toolsRequired: string[]
  contextTokens: number | null
  projectId?: string
  /** One line, at most 300 characters, for deciders that need words. */
  summary?: string
}

export type OutcomeSource = 'turn' | 'durable-job' | 'local-assist' | 'local-agent' | 'approval-review' | 'evaluation' | 'decision' | 'owner'
/** completed-unverified: a turn that ended normally with nothing checking its work (half a success). */
export type OutcomeResult = 'success' | 'failure' | 'partial' | 'cancelled' | 'completed-unverified'

/** One meaningful execution, attributed to the model+provider that did it. Raw rows are kept
 *  (bounded by OUTCOME_RETENTION_DAYS) so every aggregate can be audited. */
export interface ExecutionOutcome {
  id: string
  key: ModelKey
  effort: string | null
  source: OutcomeSource
  /** Source-local reference: turn id, job id, review record id, evaluation run id. */
  ref: string
  category: TaskCategory
  complexity: number | null
  projectId: string | null
  agentSessionId: string | null
  decisionId: string | null
  at: string
  result: OutcomeResult
  verifier: 'pass' | 'fail' | 'none'
  durationMs: number | null
  tokens: number | null
  costUsd: number | null
  retries: number
  iterations: number | null
  toolFailures: number
  contextFailure: boolean
  looped: boolean
  timedOut: boolean
  overBudget: boolean
  invalidOutput: boolean
  falseCompletion: boolean
  escalated: boolean
  /** Another model had to repair this work, or the owner rejected/corrected it. */
  repairedBy: ModelKey | null
  ownerCorrected: boolean
  detail?: string
}
export const OUTCOME_RETENTION_DAYS = 180

// ---------------------------------------------------------------------------------------------
// Reputation

/** Beta-Bernoulli with a prior worth `priorWeight` pseudo-observations and exponential recency
 *  decay. A handful of outcomes moves the estimate but cannot overwhelm the prior. */
export const REPUTATION_POLICY = { priorWeight: 8, halfLifeDays: 30, provenSamples: 12, defaultPrior: 0.6 } as const

export interface ReputationScore {
  key: ModelKey
  dimension: TaskCategory | BehaviourDimension
  /** Posterior mean success probability. */
  mean: number
  /** 10th percentile of the posterior: what routing uses when it must be conservative. */
  lower: number
  /** Recency-weighted evidence count (excluding the prior). */
  evidence: number
  priorMean: number
  priorSource: 'benchmark' | 'family' | 'default'
  lastOutcomeAt: string | null
}

// ---------------------------------------------------------------------------------------------
// Decisions

export type DecisionKind = 'route' | 'approval' | 'retry' | 'escalate' | 'completion' | 'fallback' | 'classify'

export interface DecisionOption { id: string; label: string; /** Compact facts about this option. */ facts?: Record<string, string | number | boolean | null> }

export interface DecisionRequest {
  kind: DecisionKind
  question: string
  options: DecisionOption[]
  /** Compact structured state, at most DECISION_STATE_MAX_CHARS when serialised. */
  state: Record<string, unknown>
  /** High-impact decisions may never be settled by the local decider alone (policy per kind). */
  impact: 'routine' | 'high'
  projectId?: string
  agentSessionId?: string
  /** Whoever asked, for the journal: 'router', 'approval-gate', 'durable-jobs', ... */
  requester: string
}
export const DECISION_STATE_MAX_CHARS = 6_000

/** What one decider says. Probabilities cover every option id and sum to 1 (normalised by the service). */
export interface DeciderVerdict { decider: string; probabilities: Record<string, number>; rationale: string; tokens?: number | null; elapsedMs: number }
export type DeciderOutcome = { ok: true; verdict: DeciderVerdict } | { ok: false; decider: string; reason: string }

/** A decider: the scoring function, a small local model, a frontier model. Replaceable behind this. */
export interface Decider {
  readonly id: string
  readonly tier: 'system-one' | 'frontier'
  supports(kind: DecisionKind): boolean
  decide(request: DecisionRequest, signal?: AbortSignal): Promise<DeciderOutcome>
}

export interface DecisionThresholds {
  /** Act on the system-one answer only at or above this top probability... */
  minConfidence: number
  /** ...and when the runner-up trails by at least this much. */
  minMargin: number
  /** high: always escalate high-impact decisions; confident: escalate only when unsure. */
  highImpact: 'always-escalate' | 'escalate-when-unsure'
  /** Options the system-one decider may never choose alone (e.g. approval 'deny'). */
  frontierOnly: string[]
  /** shadow: system-one runs and is journaled but the frontier decides; live: system-one acts. */
  mode: 'off' | 'shadow' | 'live'
}

export interface DecisionRecord {
  id: string
  kind: DecisionKind
  requester: string
  question: string
  options: DecisionOption[]
  state: Record<string, unknown>
  at: string
  choice: string | null
  confidence: number
  margin: number
  probabilities: Record<string, number>
  decidedBy: string
  escalated: boolean
  escalationReason: string | null
  verdicts: Array<DeciderVerdict | { decider: string; failed: string }>
  rationale: string
  /** Filled in later by the feedback loop: did the chosen option work out? */
  outcome: { result: OutcomeResult; at: string; detail?: string; /** The owner's chosen option id, when the owner answered. */ answer?: string } | null
  /** The system-one verdict (the local one in shadow), null when there was none. Old records derive it from verdicts[0]. */
  systemOne?: { decider: string; choice: string | null; confidence: number; failed?: string } | null
  /** The CPU decision model's verdict, asked after the decision was made and journaled beside it (shadow
   *  only: it never changed or delayed the decision). Set on decisions whose system-one is another decider (routes). */
  shadow?: ShadowVerdict
  projectId: string | null
  agentSessionId: string | null
  /** Route decisions: what the router made of the choice, stored with it (decisions.get). */
  route?: RouteDetails
  /** A models.route dry run: journaled, but left out of decisions.list by default. */
  dryRun?: boolean
}

export interface ShadowVerdict { decider: string; choice: string | null; confidence: number; probabilities: Record<string, number>; elapsedMs: number; at: string; failed?: string }

export interface RouteDetails {
  selected: { key: ModelKey; effort: string | null }
  fallback: { key: ModelKey; effort: string | null; reason?: string } | null
  escalation: { key: ModelKey; effort: string | null; reason?: string } | null
  reasons: string[]
  /** A close call escalated to the caller: the candidates it was close between. */
  closeCandidates?: Array<{ id: string; probability: number; capabilityRank: number }>
  /** Every open attempt a dispatch made for this decision (the choice, then its fallback). */
  attempts?: Array<{ key: ModelKey; ok: boolean; error?: string; at: string }>
}

// ---------------------------------------------------------------------------------------------
// Routing

export interface RouteConstraints {
  /** 0 ignore .. 1 cost dominates. Same for latency. */
  costWeight: number
  latencyWeight: number
  maxCostUsd: number | null
  localOnly: boolean
  /** Providers the caller may not use (quota exhausted, owner preference). */
  excludeProviders: RoutingProvider[]
  /** Restrict to these keys when given (the caller's shortlist). */
  allow?: ModelKey[]
  urgency: 'normal' | 'urgent'
}
export const DEFAULT_ROUTE_CONSTRAINTS: RouteConstraints = { costWeight: 0.3, latencyWeight: 0.15, maxCostUsd: null, localOnly: false, excludeProviders: [], urgency: 'normal' }

/** A candidate with everything the scorer used, so the decision can be explained. */
export interface RouteCandidate {
  key: ModelKey
  effort: string | null
  eligible: boolean
  /** Why it was filtered out, when not eligible. */
  excluded: string | null
  expectedSuccess: number
  expectedCostUsd: number | null
  expectedLatencyMs: number | null
  utility: number
  reputation: ReputationScore | null
  /** Live facts: loaded local server, usage-limit percent, provider availability. */
  live: Record<string, string | number | boolean | null>
}

export interface RouteDecision {
  decisionId: string
  selected: { key: ModelKey; effort: string | null }
  contextStrategy: 'fresh' | 'continue' | 'handoff'
  fallback: { key: ModelKey; effort: string | null; reason?: string } | null
  escalation: { key: ModelKey; effort: string | null; reason?: string } | null
  maxCostUsd: number | null
  confidence: number
  probabilities: Record<string, number>
  reasons: string[]
  candidates: RouteCandidate[]
  decidedBy: string
  escalated: boolean
}
