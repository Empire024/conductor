import type { DatabaseSync } from 'node:sqlite'
import {
  modelKeyId, TASK_CATEGORIES, type Decider, type DeciderOutcome, type DecisionKind, type DecisionRecord, type DecisionRequest, type ExecutionOutcome, type ModelKey, type RegistryRecord,
  type RouteConstraints, type RouteDecision, type RouteDetails, type TaskCategory, type TaskFeatures
} from '../../shared/model-routing'
import { makeId } from '../../shared/models'
import type { SessionPhase, TimelineItem } from '../../shared/structured-agent'
import type { DurableJob, DurableJobStage } from '../../shared/durable-jobs'
import { localStopOf, type LocalStopReport } from '../../shared/local-stop'
import type { LocalTelemetryEntry } from '../local-models/agent'
import { usageWindowAppliesToModel, type AccountLimitWindow, type UsageWindow } from '../../shared/usage-accounting'
import type { LocalModelRunner } from '../local-assist/contract'
import type { LoopAssessment, StageConclusion, StageResultInput } from '../durable-jobs/ports'
import { createApprovalShadow, type ApprovalShadowService } from './approval-shadow'
import { captureDurableStage } from './capture/durable-job'
import { captureLocalAgentStop } from './capture/local-agent'
import { captureTurn } from './capture/turn'
import { categorize } from './categorize'
import { DecisionService, normaliseProbabilities, topChoice, type ThresholdSettings } from './decision-service'
import { LAYA_DECIDER_ID } from './deciders/laya'
import { createFrontierDecider, type FrontierPort } from './deciders/frontier'
import { createLocalLlmDecider } from './deciders/local-llm'
import { createScorerDecider, defaultUsageStop, SCORER_TEMPERATURE, softmax } from './deciders/scorer'
import defaultSuite from './suites/default.json'
import { batchJobTokens, evaluate, refusedBeforeTurn, validateSuite, type CommandRequest, type CommandResult, type EvaluationJob, type EvaluationOptions, type EvaluationPorts, type EvaluationResult, type EvaluationRun, type EvaluationSuite } from './evaluation'
import { DEFAULT_FIXED_OVERHEAD_TOKENS, EvaluationTurnError, isRefusal, type CloudRun, type EvaluationScope } from './evaluation-ports'
import { explainRoute } from './explain'
import { refreshAll, type IngestionPorts, type IngestionSourceName, type RefreshResult } from './ingest'
import { linkedBatch } from './ingest/linked'
import { createLiveBoundaries } from './live-boundaries'
import { ModelRegistry, rankOf } from './registry'
import { ReputationService } from './reputation-service'
import { route, type RouteLiveFacts, type RouteOptions } from './router'
import { BINDING_TTL_DAYS, ModelIntelligenceStore, type EvaluationSpend, type StoredBinding } from './store'

/**
 * Module E's service (docs/model-routing.md): one object over the store, registry, reputation,
 * DecisionService, router and evaluation, with the background refresh, outcome capture and the
 * approval shadow. Nothing here throws into the app: failures are logged and the caller keeps its
 * old behaviour.
 */

const HOUR_MS = 3_600_000
const DAILY_MS = 24 * HOUR_MS
const LAST_DAILY_SETTING = 'model-intelligence:last-daily-refresh'
export const EVALUATION_CAPS_SETTING = 'model-intelligence:evaluation-caps'
/** The last measured fixed input overhead of a cloud evaluation turn, per provider: {provider: {tokens, measured, at, profile}}. */
export const EVALUATION_OVERHEAD_SETTING = 'model-intelligence:evaluation-overhead'
/** The launch profile evaluation turns run on (AgentSpec.profile 'evaluation', version 1: no Conductor briefing,
 *  MCP servers, settings, skills or tools, an empty working directory). A stored overhead measured under any
 *  other preamble (an entry without it was a full native tab, ~51k) is stale: ignored until one run measures again. */
export const EVALUATION_OVERHEAD_PROFILE = 'lean-1'
const STARTUP_SOURCES: IngestionSourceName[] = ['configured', 'runtime']
const DAILY_SOURCES: IngestionSourceName[] = ['configured', 'runtime', 'openrouter', 'latest-models', 'benchmarks']
const SETTLED: ReadonlySet<SessionPhase> = new Set(['completed', 'failed', 'interrupted'])
/** The prompt origin durable-jobs/structured-runtime.ts gives a stage; stageSettled captures those turns. */
const DURABLE_JOB_ORIGIN = 'durable-job'
export const CALLER_DECIDER_ID = 'caller'
export const LOCAL_DECIDER_UNAVAILABLE = 'local decider unavailable: no local model server is running'
/** Shadow decisions in flight at once; more are skipped (logged once), never queued behind real work. */
export const SHADOW_PENDING_MAX = 32
const SHADOW_TEXT_MAX = 1_500
const clipText = (text: string, max = SHADOW_TEXT_MAX): string => text.length > max ? text.slice(0, max - 1) + '…' : text

/** Model keys routing and evaluation never use: a JSON array of glob patterns (`*`, `?`) on the key
 *  id (`provider/model`), matched case-insensitively. The owner wants no Fable spend. */
export const EXCLUDED_MODELS_SETTING = 'model-intelligence:excluded-models'
export const DEFAULT_EXCLUDED_MODELS: readonly string[] = ['claude/claude-fable-5-1*', 'claude/*fable*']
export const EXCLUDED_BY_OWNER = 'excluded by owner setting'
const EXCLUDED_REASONS_MAX = 4
export function excludedMatcher(patterns: readonly string[]): (key: ModelKey) => string | null {
  const compiled = patterns.map(pattern => ({ pattern, regex: new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i') }))
  return key => compiled.find(entry => entry.regex.test(modelKeyId(registryKey(key))))?.pattern ?? null
}

/** The owner's cloud evaluation caps (owner decisions 2026-09-28), overridable in settings. */
export interface EvaluationCaps { perRunTokens: number; perDayEvaluations: number; perDayTokens: number; /** The smallest run cap worth starting; less left of the day refuses the run. */ minRunTokens: number; weeklyStop: Record<string, number> }
/** The owner's weekly usage stop per provider, one source for routing and evaluation (owner decisions 2026-09-28):
 *  at or above it a provider's weekly window blocks routing to it and evaluating on it. Setting
 *  'model-intelligence:weekly-stop' overrides it per provider; routing treats a provider without one as 95. */
export const WEEKLY_STOP_SETTING = 'model-intelligence:weekly-stop'
export const DEFAULT_WEEKLY_STOP: Readonly<Record<string, number>> = { claude: 85, codex: 55 }
export const ROUTING_FALLBACK_STOP = 95
export const DEFAULT_EVALUATION_CAPS: EvaluationCaps = { perRunTokens: 60_000, perDayEvaluations: 3, perDayTokens: 150_000, minRunTokens: DEFAULT_FIXED_OVERHEAD_TOKENS + 5_000, weeklyStop: { ...DEFAULT_WEEKLY_STOP } }
/** The learned fixed overhead of a cloud turn is kept within [OVERHEAD_MIN_TOKENS, the per-run cap less the
 *  suite's smallest one-shot job], so batching always has room for one job (N14); admission decides on the raw measurement (N19). */
export const OVERHEAD_MIN_TOKENS = 5_000
/** How long a raw overhead measurement decides admission (N19). The native preamble (the CLI's system prompt
 *  and tools, Conductor's MCP tools, the project context) changes with a CLI or Conductor update, not between
 *  runs, so within this window a run the measurement says cannot hold a job is refused instead of cut off;
 *  after it, one run is admitted on the banded value and measures the preamble again. */
export const OVERHEAD_TRUST_MS = DAILY_MS
/** What the smallest job a cloud run can grade adds to its batched turn (a command-graded job only where a
 *  command runner checks its answer); null when the suite has none. */
export function smallestCloudJob(jobs: EvaluationJob[], commands = false): number | null {
  const sizes = jobs.filter(job => commands || job.grader.kind !== 'command').map(batchJobTokens)
  return sizes.length ? Math.min(...sizes) : null
}

export interface ModelIntelligenceOptions {
  dbPath: string | DatabaseSync
  settings: ThresholdSettings
  /** The local-assist runner (local-assist/wiring.ts), shared: its admission rules are the local decider's. */
  localRunner?: LocalModelRunner | null
  /** Whether a local model server is already running. The local decider only ever uses one that
   *  is; it never starts one. Absent: the decider may start a server as the runner allows. */
  localServerRunning?(): boolean
  /** The CPU decision model (deciders/laya.ts over local-models/decider-server.ts): the system-one decider for every
   *  kind the scorer does not decide (it replaces the local-llm decider), and a shadow verdict beside every route. */
  decider?: Decider | null
  /** Whether the decision model is set up on this machine; its server starts on the first decision. */
  deciderAvailable?(): boolean
  /** A one-shot frontier call for non-approval kinds. Without one, route and fallback close calls
   *  go to the caller (CALLER_DECIDER_ID): no model is asked. */
  frontier?: FrontierPort | null
  clock?: () => Date
  log?: (message: string, error?: unknown) => void
  sources?: Omit<IngestionPorts, 'now'>
  evaluation?: EvaluationWiring
  /** Test seam for the daily timer. */
  timers?: { every(ms: number, run: () => void): () => void; after(ms: number, run: () => void): () => void }
}

export interface EvaluationWiring {
  /** One job on one local model: a one-shot answer through the local runner. */
  runLocal?(key: ModelKey, job: EvaluationJob, signal: AbortSignal, budget?: { maxTokens: number }): Promise<EvaluationRun>
  /** One job on one cloud model through the native provider path, at its lowest effort. `budget` is
   *  the job's token budget (evaluation.ts): the turn is stopped past it where it can be, and a turn
   *  that fails or reports no usage counts it as spent (the error carries `tokens`). */
  runCloud?(key: ModelKey, job: EvaluationJob, signal: AbortSignal, budget?: { maxTokens: number }, context?: { scope?: EvaluationScope }): Promise<CloudRun>
  /** The provider's current weekly usage percent, null when unknown (then a cloud evaluation is skipped). */
  usage?(provider: string): number | null
  /** A grader command with no network (the docker sandbox, else a confined host `node` check), or null where
   *  neither is available (command jobs are then not gradable here). */
  command?(): Promise<((request: CommandRequest) => Promise<CommandResult>) | null>
  /** Why this key cannot be evaluated now (another model holds the GPU), or null. */
  precheck?(key: ModelKey): Promise<string | null> | string | null
  writeReport?(name: string, markdown: string): void
  /** The report a run wrote (writeReport), by its runId; null when there is none. */
  readReport?(runId: string): string | null
  suites(): Record<string, EvaluationSuite>
}

export type DispatchBinding = StoredBinding
export interface RouteResult { decision: RouteDecision; explanation: string }
export interface EvaluationHandle { runId: string; key: ModelKey; suite: string; state: 'running' | 'done' | 'failed'; startedAt: string; notGradable: string[]; maxTokens?: number; result?: EvaluationResult; error?: string }

/** Registry keys keep models.list ids (`local/<id>`); capture adapters may hand a bare local id. */
export const registryKey = (key: ModelKey): ModelKey => key.provider === 'local' && !key.model.startsWith('local/') ? { provider: 'local', model: `local/${key.model}` } : key
const normalise = (outcome: ExecutionOutcome): ExecutionOutcome => ({ ...outcome, key: registryKey(outcome.key), ...(outcome.repairedBy ? { repairedBy: registryKey(outcome.repairedBy) } : {}) })
export const parseKeyId = (id: string): ModelKey | null => { const slash = id.indexOf('/'); return slash > 0 && slash < id.length - 1 ? registryKey({ provider: id.slice(0, slash), model: id.slice(slash + 1) }) : null }

const defaultTimers = {
  every: (ms: number, run: () => void) => { const timer = setInterval(run, ms); timer.unref?.(); return () => clearInterval(timer) },
  after: (ms: number, run: () => void) => { const timer = setTimeout(run, ms); timer.unref?.(); return () => clearTimeout(timer) }
}

export const CLOSE_CANDIDATES_MAX = 3

/** What the decision model reads about a durable-job stage: its objective and criteria, what the attempt said and did. */
function stageState(stage: DurableJobStage, observation: StageResultInput['observation']): Record<string, unknown> {
  return {
    stage: clipText(`${stage.title}: ${stage.objective}`, 600), criteria: stage.completionCriteria.slice(0, 6).map(criterion => clipText(criterion, 200)), attempt: stage.attempt,
    lastAnswer: clipText(observation.lastAnswer), stop: observation.stop ? `${observation.stop.reason}: ${clipText(observation.stop.detail, 300)}` : null,
    filesChanged: observation.filesChanged.length, ...(observation.lastError ? { lastError: clipText(observation.lastError, 400) } : {})
  }
}
/** The close set of a route request: at most CLOSE_CANDIDATES_MAX options whose utility is within
 *  `minMargin` of the top utility, best first; `probability` is each one's scorer softmax. */
export function closeCandidates(request: Pick<DecisionRequest, 'options'>, minMargin: number, rank: (id: string) => number): Array<{ id: string; probability: number; capabilityRank: number; utility: number }> {
  const utilities = request.options.map(option => typeof option.facts?.utility === 'number' ? option.facts.utility : NaN)
  if (!utilities.length || utilities.some(value => !Number.isFinite(value))) return []
  const probabilities = softmax(utilities, SCORER_TEMPERATURE), top = Math.max(...utilities)
  return request.options.map((option, index) => ({ id: option.id, probability: probabilities[index]!, capabilityRank: rank(option.id), utility: utilities[index]! }))
    .filter(entry => top - entry.utility <= minMargin).sort((a, b) => b.utility - a.utility).slice(0, CLOSE_CANDIDATES_MAX)
}

/** Hard or high-risk work, by the route request's features: only then does a close call go to the most capable. */
const hardWork = (request: Pick<DecisionRequest, 'state'>): boolean => {
  const features = request.state?.features as { complexity?: unknown; risk?: unknown } | undefined
  return typeof features?.complexity === 'number' && features.complexity >= 4 || features?.risk === 'high'
}

/** A distribution in which `chosen` keeps its own probability and is still the top: the others share
 *  the rest in proportion, none above it (water-filled). Where its probability is too small for that
 *  (at or below 1/n), it leads a near-uniform split. */
export function chosenOnTop(probabilities: Record<string, number>, chosen: string): Record<string, number> {
  const ids = Object.keys(probabilities), own = probabilities[chosen] ?? 0, others = ids.filter(id => id !== chosen)
  if (!others.length) return { [chosen]: 1 }
  const cap = own * (1 - 1e-6)
  if (own <= 1 / ids.length || cap * others.length < 1 - own) {
    const lead = 1 / ids.length + 1e-6
    return Object.fromEntries(ids.map(id => [id, id === chosen ? lead : (1 - lead) / others.length]))
  }
  const result: Record<string, number> = { [chosen]: own }
  let open = [...others], mass = 1 - own
  for (;;) {
    const total = open.reduce((sum, id) => sum + (probabilities[id] ?? 0), 0)
    const scale = (id: string) => total > 0 ? (probabilities[id] ?? 0) * mass / total : mass / open.length
    const over = open.filter(id => scale(id) > cap)
    if (!over.length) { for (const id of open) result[id] = scale(id); return result }
    for (const id of over) result[id] = cap
    mass -= cap * over.length
    open = open.filter(id => !over.includes(id))
  }
}

/**
 * The frontier for route and fallback when no model is wired as one: the caller (an Opus or Astra
 * controller, or router.dispatch) is the frontier. A close call is escalated to it with the close
 * candidates (by utility); the default it records is the most capable of them for hard (complexity
 * 4+) or high-risk work, else the top-utility one, so a cheaper model wins a close easy call. The
 * verdict carries the chosen candidate's own scorer probability as its confidence. No model is asked.
 */
export function callerFrontier(minMargin: () => number, rank: (id: string) => number): Decider {
  return {
    id: CALLER_DECIDER_ID, tier: 'frontier', supports: kind => kind === 'route' || kind === 'fallback',
    async decide(request): Promise<DeciderOutcome> {
      const close = closeCandidates(request, minMargin(), rank)
      if (!close.length) return { ok: false, decider: CALLER_DECIDER_ID, reason: 'no scored options to choose between' }
      const hard = hardWork(request)
      const chosen = hard ? [...close].sort((a, b) => b.capabilityRank - a.capabilityRank || b.utility - a.utility)[0]! : close[0]!
      const list = close.map(entry => `${entry.id} (${entry.probability.toFixed(2)}, capability ${entry.capabilityRank})`).join(', ')
      const softmaxOf = softmax(request.options.map(option => option.facts!.utility as number), SCORER_TEMPERATURE)
      const probabilities = chosenOnTop(Object.fromEntries(request.options.map((option, index) => [option.id, softmaxOf[index]!])), chosen.id)
      return { ok: true, verdict: { decider: CALLER_DECIDER_ID, probabilities,
        rationale: `Close call between ${list}; the caller decides. Default: ${hard ? `the most capable for hard or high-risk work, ${chosen.id}` : `the top utility, ${chosen.id}, as the work is not hard or high-risk`}.`, tokens: null, elapsedMs: 0 } }
    }
  }
}

/** A provider's usage as routing sees it (D5): only current windows, a model-scoped window only for
 *  the models it selects, and each window against its own threshold: a weekly window against the
 *  weekly stop, any shorter one against 100 % (exhausted). */
export function usageVerdict(windows: AccountLimitWindow[], model: { id: string; label?: string }, weeklyStop: number): { percent: number | null; blocked: string | null } {
  const applicable = windows.filter(window => window.state !== 'reset' && usageWindowAppliesToModel({ scope: window.scope, ...(window.models ? { modelSelectors: window.models } : {}) } as UsageWindow, model))
  if (!applicable.length) return { percent: null, blocked: null }
  const over = applicable.find(window => window.usedPercent >= (window.kind === 'weekly' ? weeklyStop : 100))
  const weekly = applicable.filter(window => window.kind === 'weekly')
  return {
    percent: Math.max(...(weekly.length ? weekly : applicable).map(window => window.usedPercent)),
    blocked: over ? `${over.label} usage ${Math.round(over.usedPercent)}% at or above ${over.kind === 'weekly' ? `the ${weeklyStop}% weekly stop` : 'its limit'}` : null
  }
}

/** Routing's live usage facts from the providers' limit windows under the weekly stop: each window
 *  against its own threshold (usageVerdict), and the stop itself for keys without a per-key verdict. */
export function routeUsage(windows: (provider: string) => AccountLimitWindow[], label: (key: ModelKey) => string, weeklyStop: (provider: string) => number): Pick<RouteLiveFacts, 'usagePercent' | 'usage' | 'usageStopPercent'> {
  return {
    usagePercent: provider => weeklyUsage(windows(provider)),
    usage: key => usageVerdict(windows(key.provider), { id: key.model, label: label(key) }, weeklyStop(key.provider)),
    usageStopPercent: provider => weeklyStop(provider)
  }
}

export function createModelIntelligence(options: ModelIntelligenceOptions) {
  const clock = options.clock ?? (() => new Date())
  const log = options.log ?? ((message: string, error?: unknown) => console.warn(`[model-intelligence] ${message}`, error ?? ''))
  const timers = options.timers ?? defaultTimers
  const store = new ModelIntelligenceStore(options.dbPath, clock)
  const registry = new ModelRegistry(store)
  const reputation = new ReputationService(store, { now: () => clock().getTime() })
  const localAvailable = (): boolean => { try { return options.localServerRunning ? options.localServerRunning() : true } catch { return false } }
  // The shared runner, guarded so the decider never starts a server (D6): the quick check skips the
  // queue when none runs, and noStart makes the runner itself refuse to start one, so a server that
  // stops between the check and the ask is never replaced. Only ask is exposed: the runner's
  // measurements locate a server and could start one.
  const localRunner: LocalModelRunner | null = options.localRunner
    ? { ask: request => localAvailable() ? options.localRunner!.ask({ ...request, noStart: true }) : Promise.resolve({ ok: false, reason: LOCAL_DECIDER_UNAVAILABLE }) } : null
  const rank = (id: string): number => { const key = parseKeyId(id); if (!key) return 0; const record = registry.get(key); return record?.capabilityRank ?? rankOf(key, record?.family ?? null) }
  let decisions: DecisionService
  const decider = options.decider ?? null
  const deciderReady = (): boolean => { try { return Boolean(decider) && (options.deciderAvailable?.() ?? true) } catch { return false } }
  const deciders = [createScorerDecider(), ...(decider ? [decider] : localRunner ? [createLocalLlmDecider(localRunner)] : []),
    ...(options.frontier ? [createFrontierDecider(options.frontier, { kinds: ['route', 'retry', 'escalate', 'completion', 'fallback', 'classify'] })] : [callerFrontier(() => decisions.thresholds('route').minMargin, rank)])]
  decisions = new DecisionService({
    deciders, settings: options.settings, now: clock,
    journal: { record: record => store.recordDecision(record) },
    journalFailed: (error, record) => log(`decision ${record.id} was not journaled`, error)
  })
  const countersBefore = new Map<string, DurableJob['counters']>()
  const evaluations = new Map<string, EvaluationHandle>()
  /** Each running evaluation's journaled cumulative spend, for the rest of its reservation. */
  const runSpend = new Map<string, number>()
  const disposers: Array<() => void> = []
  let refreshing: Promise<unknown> = Promise.resolve()

  /** Stores the outcome (idempotent), lets reputation see it, gives its decision a first outcome,
   *  and promotes the key once its evidence is proven (D10: not evaluation only). */
  const recordOutcome = (raw: ExecutionOutcome | null): ExecutionOutcome | null => {
    if (!raw) return null
    try {
      const { outcome, inserted } = store.recordOutcome(normalise(raw))
      if (inserted) {
        reputation.outcomeRecorded(outcome)
        if (outcome.decisionId && outcome.result !== 'cancelled' && store.decision(outcome.decisionId)?.outcome === null)
          store.updateDecisionOutcome(outcome.decisionId, { result: outcome.result, at: outcome.at, detail: `${outcome.source} ${outcome.ref}` })
        promoteIfProven(outcome.key)
      }
      return outcome
    } catch (error) { log('outcome not recorded', error); return null }
  }
  const promoteIfProven = (key: ModelKey): void => {
    try {
      const record = registry.get(key)
      if (record && record.status === 'unproven' && reputation.proven(key)) registry.promote(key)
    } catch (error) { log('status not promoted', error) }
  }

  /** The linked pass after every refresh: CLI keys take family, price and context from OpenRouter. */
  const link = (): RefreshResult['changes'] => {
    try {
      const batch = linkedBatch(registry.list({ limit: 5_000 }), clock().toISOString())
      return batch ? registry.applyBatch(batch).changes : []
    } catch (error) { log('linked pass failed', error); return [] }
  }
  const refresh = (sources: IngestionSourceName[] = DAILY_SOURCES): Promise<RefreshResult> => {
    const run = refreshing.then(() => refreshAll(registry, { ...options.sources, now: clock }, sources)).then(result => ({ ...result, changes: [...result.changes, ...link()] }))
    refreshing = run.catch(() => undefined)
    return run.then(result => {
      for (const entry of result.results) if (entry.status === 'failed') log(`${entry.source} refresh failed: ${entry.errors.join('; ')}`)
      return result
    })
  }
  const quietly = (sources: IngestionSourceName[]): void => { void refresh(sources).catch(error => log('refresh failed', error)) }
  const dailyDue = (): boolean => {
    const last = Date.parse(options.settings.getSetting(LAST_DAILY_SETTING) ?? '')
    return !Number.isFinite(last) || clock().getTime() - last >= DAILY_MS
  }
  const daily = (): void => {
    if (!dailyDue()) return
    try { options.settings.setSetting(LAST_DAILY_SETTING, clock().toISOString()) } catch (error) { log('daily refresh time not saved', error) }
    quietly(DAILY_SOURCES)
  }

  const liveBoundaries = createLiveBoundaries({ store, decisions, settings: options.settings, now: clock, log })
  const shadow: ApprovalShadowService = createApprovalShadow({ decisions, store, recordOutcome, log, now: clock, localAvailable: () => decider ? deciderReady() : Boolean(localRunner) && localAvailable(), boundaries: liveBoundaries })

  /** Shadow decisions run after the real one, in the background, at most SHADOW_PENDING_MAX at a time; a failure
   *  is logged and journaled as the verdict's failure, never raised into the caller. */
  const pendingShadows = new Set<Promise<unknown>>()
  let shadowsDropped = 0
  const inBackground = (what: string, work: () => Promise<unknown>): void => {
    if (!deciderReady()) return
    if (pendingShadows.size >= SHADOW_PENDING_MAX) { if (!shadowsDropped++) log(`shadow ${what} skipped: ${SHADOW_PENDING_MAX} shadow decisions are still running`); return }
    const running: Promise<unknown> = Promise.resolve().then(work).catch(error => log(`shadow ${what} failed`, error)).finally(() => { pendingShadows.delete(running) })
    pendingShadows.add(running)
  }
  /** The decision model's verdict on a decision already made and journaled (a route): stored beside it. */
  const shadowVerdict = (decisionId: string): void => inBackground('route verdict', async () => {
    const record = store.decision(decisionId)
    if (!record || !decider?.supports(record.kind)) return
    const started = clock().getTime(), ids = record.options.map(option => option.id)
    const request: DecisionRequest = { kind: record.kind, question: record.question, options: record.options, state: record.state, impact: 'routine', requester: record.requester }
    let outcome: DeciderOutcome
    try { outcome = await decider.decide(request) } catch (error) { outcome = { ok: false, decider: decider.id, reason: error instanceof Error ? error.message : String(error) } }
    const probabilities = outcome.ok ? normaliseProbabilities(outcome.verdict.probabilities, ids) : null
    const at = clock().toISOString()
    if (outcome.ok && probabilities) {
      const top = topChoice(probabilities, ids)
      store.recordShadowVerdict(decisionId, { decider: outcome.verdict.decider, choice: top.choice, confidence: top.confidence, probabilities, elapsedMs: outcome.verdict.elapsedMs, at })
    } else store.recordShadowVerdict(decisionId, { decider: outcome.ok ? outcome.verdict.decider : outcome.decider, choice: null, confidence: 0, probabilities: {}, elapsedMs: clock().getTime() - started, at, failed: outcome.ok ? 'no probability for any option' : outcome.reason })
  })
  /** A decision the app made its own way (the durable-job controller, the dispatch classifier, a settled turn), journaled
   *  with the decision model's verdict as system-one and the app's choice as the frontier verdict: shadow only. */
  const shadowDecide = (request: DecisionRequest, actual: { choice: string; by: string; rationale: string }): void => {
    if (!request.options.some(option => option.id === actual.choice)) { log(`shadow ${request.kind}: the actual choice ${actual.choice} is not an option`); return }
    const made: Decider = { id: actual.by, tier: 'frontier', supports: () => true,
      decide: async () => ({ ok: true, verdict: { decider: actual.by, probabilities: Object.fromEntries(request.options.map(option => [option.id, option.id === actual.choice ? 1 : 0])), rationale: actual.rationale.slice(0, 600), tokens: null, elapsedMs: 0 } }) }
    inBackground(request.kind, () => decisions.decide(request, { frontier: made, mode: 'shadow' }))
  }

  /** The weekly stops, defaults overlaid with the setting's valid percents; an unreadable setting keeps the defaults. */
  const weeklyStops = (): Record<string, number> => {
    try { return { ...DEFAULT_WEEKLY_STOP, ...validStops(JSON.parse(options.settings.getSetting(WEEKLY_STOP_SETTING) ?? '{}')) } }
    catch { return { ...DEFAULT_WEEKLY_STOP } }
  }
  const weeklyStop = (provider: string): number => weeklyStops()[provider] ?? ROUTING_FALLBACK_STOP
  const evaluationCaps = (): EvaluationCaps => {
    try {
      const stored = JSON.parse(options.settings.getSetting(EVALUATION_CAPS_SETTING) ?? '{}') as Partial<EvaluationCaps>
      const count = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
      return {
        perRunTokens: count(stored.perRunTokens, DEFAULT_EVALUATION_CAPS.perRunTokens), perDayEvaluations: count(stored.perDayEvaluations, DEFAULT_EVALUATION_CAPS.perDayEvaluations),
        perDayTokens: count(stored.perDayTokens, DEFAULT_EVALUATION_CAPS.perDayTokens), minRunTokens: count(stored.minRunTokens, DEFAULT_EVALUATION_CAPS.minRunTokens), weeklyStop: { ...weeklyStops(), ...validStops(stored.weeklyStop) }
      }
    } catch { return { ...DEFAULT_EVALUATION_CAPS, weeklyStop: weeklyStops() } }
  }
  /** Each provider's last measured fixed overhead of a cloud evaluation turn (N9): what a native turn
   *  reads before the job itself. Kept in settings so it survives a restart; DEFAULT_FIXED_OVERHEAD_TOKENS until measured.
   *  Only entries measured on the current launch profile (EVALUATION_OVERHEAD_PROFILE) count. */
  type OverheadEntry = { tokens: number; measured?: number; at: string; profile?: string }
  const overheads = (): Record<string, OverheadEntry> => {
    try {
      const stored: unknown = JSON.parse(options.settings.getSetting(EVALUATION_OVERHEAD_SETTING) ?? '{}')
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
      return Object.fromEntries(Object.entries(stored as Record<string, OverheadEntry>).filter(([, entry]) => entry && typeof entry === 'object' && entry.profile === EVALUATION_OVERHEAD_PROFILE))
    } catch { return {} }
  }
  /** The raw measurement while it is recent (OVERHEAD_TRUST_MS): what admission charges (N19). An entry
   *  without `measured` predates first-call measuring and may be a multi-call sum, so it never counts. */
  const recentMeasured = (provider: string): { tokens: number; at: string; until: string } | null => {
    const entry = overheads()[provider], measured = entry?.measured, at = Date.parse(typeof entry?.at === 'string' ? entry.at : '')
    if (typeof measured !== 'number' || !Number.isFinite(measured) || measured < 0 || !Number.isFinite(at) || clock().getTime() - at >= OVERHEAD_TRUST_MS) return null
    return { tokens: Math.round(measured), at: entry!.at, until: new Date(at + OVERHEAD_TRUST_MS).toISOString() }
  }
  /** The band a learned overhead is kept in: at least OVERHEAD_MIN_TOKENS, and small enough that a full
   *  run still holds the smallest job (`smallestJob`, 0 when unknown). */
  const overheadBand = (smallestJob = 0): { min: number; max: number } => ({ min: OVERHEAD_MIN_TOKENS, max: Math.max(OVERHEAD_MIN_TOKENS, evaluationCaps().perRunTokens - smallestJob) })
  const clampOverhead = (tokens: number, smallestJob = 0): number => { const band = overheadBand(smallestJob); return Math.round(Math.min(band.max, Math.max(band.min, tokens))) }
  const fixedOverheadTokens = (provider: string, smallestJob = 0): number => {
    const tokens = overheads()[provider]?.tokens
    return clampOverhead(typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokens : DEFAULT_FIXED_OVERHEAD_TOKENS, smallestJob)
  }
  /** Learns a provider's overhead from one turn (the port's measurement: its first API call's input less the
   *  job prompt), bounded; the raw measurement is kept beside it for audit. */
  const recordOverhead = (provider: string, tokens: unknown, smallestJob = 0): void => {
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return
    try { options.settings.setSetting(EVALUATION_OVERHEAD_SETTING, JSON.stringify({ ...overheads(), [provider]: { tokens: clampOverhead(tokens, smallestJob), measured: Math.round(tokens), at: clock().toISOString(), profile: EVALUATION_OVERHEAD_PROFILE } })) }
    catch (error) { log('evaluation overhead not saved', error) }
  }
  /** The owner's exclusion patterns; an unreadable setting keeps the defaults, an empty array excludes nothing. */
  const excludedModels = (): string[] => {
    try {
      const stored: unknown = JSON.parse(options.settings.getSetting(EXCLUDED_MODELS_SETTING) ?? 'null')
      return Array.isArray(stored) && stored.every(pattern => typeof pattern === 'string') ? stored as string[] : [...DEFAULT_EXCLUDED_MODELS]
    } catch { return [...DEFAULT_EXCLUDED_MODELS] }
  }

  const service = {
    store, registry, reputation, decisions,
    approvalShadow: shadow,
    /** Which decision boundaries act on their local verdict (decisions.live, decisions.list). */
    liveBoundaries,

    /** Prune and the startup refresh run in the background; startup never waits for either. */
    start(): void {
      try { const pruned = store.prune(clock()); if (pruned.outcomes || pruned.decisions) log(`pruned ${pruned.outcomes} outcomes and ${pruned.decisions} decisions${pruned.complete ? '' : ' (more next start)'}`) }
      catch (error) { log('prune failed', error) }
      try { const released = service.reconcileRefusedEvaluations(); if (released.length) log(`released the spend of ${released.length} evaluation run(s) refused before any model call: ${released.join(', ')}`) }
      catch (error) { log('evaluation spend not reconciled', error) }
      disposers.push(timers.after(0, () => quietly(STARTUP_SOURCES)))
      disposers.push(timers.after(60_000, daily))
      disposers.push(timers.every(HOUR_MS, daily))
    },
    refresh,
    /** The latest-models schedule ran: its script outputs are new evidence. */
    latestModelsRan(): void { quietly(['latest-models']) },

    /** Routes and stores what the router made of it (selection, fallback, escalation, reasons, and
     *  the close candidates when the caller was escalated to) with the decision. */
    async route(features: TaskFeatures, constraints: Partial<RouteConstraints> | undefined, live: RouteLiveFacts & { offered?: ModelKey[] }, routeOptions: RouteOptions = {}): Promise<RouteResult> {
      const offered = live.offered && new Set(live.offered.map(key => modelKeyId(registryKey(key))))
      // The owner's exclusion list drops keys before the router sees them; the route names each one.
      const excludedBy = excludedMatcher(excludedModels()), excluded: string[] = []
      const records = registry.list({ limit: 5_000 }).filter((record: RegistryRecord) => {
        if (offered && !offered.has(modelKeyId(record.key))) return false
        if (!live.providerEnabled(record.key.provider) || !excludedBy(record.key)) return true
        excluded.push(modelKeyId(record.key))
        return false
      })
      const exclusionReasons = [...excluded.slice(0, EXCLUDED_REASONS_MAX).map(id => `${id} ${EXCLUDED_BY_OWNER} (${EXCLUDED_MODELS_SETTING})`),
        ...(excluded.length > EXCLUDED_REASONS_MAX ? [`${excluded.length - EXCLUDED_REASONS_MAX} more ${EXCLUDED_BY_OWNER}`] : [])]
      let decision: RouteDecision
      try {
        // The owner's weekly stop wherever the caller's live facts name none.
        const withStop: RouteLiveFacts = live.usageStopPercent ? live : { ...live, usageStopPercent: weeklyStop }
        decision = await route(features, constraints, { records: () => records, reputation: (key, dimension) => reputation.reputation(key, dimension), live: withStop, decisions }, routeOptions)
      } catch (error) {
        if (excluded.length && error instanceof Error) error.message = `${error.message}; ${excluded.join(', ')} ${EXCLUDED_BY_OWNER} (${EXCLUDED_MODELS_SETTING})`
        throw error
      }
      if (exclusionReasons.length) decision = { ...decision, reasons: [...decision.reasons, ...exclusionReasons] }
      const blocked = usageBlockedProviders(decision)
      if (blocked.length) decision = { ...decision, reasons: [...decision.reasons, ...blocked.map(({ provider, reason }) => `${provider} blocked by its usage stop: ${reason}`)] }
      const record = store.decision(decision.decisionId)
      const close = record?.escalated && record.decidedBy === CALLER_DECIDER_ID
        ? closeCandidates({ options: record.options }, decisions.thresholds('route').minMargin, rank).map(({ utility: _utility, ...entry }) => entry) : undefined
      const details: RouteDetails = { selected: decision.selected, fallback: decision.fallback, escalation: decision.escalation, reasons: decision.reasons, ...(close?.length ? { closeCandidates: close } : {}) }
      try { store.recordRouteDetails(decision.decisionId, details) } catch (error) { log('route details not stored', error) }
      // The decision model's verdict is asked only now, after the route stands, and journaled beside it.
      shadowVerdict(decision.decisionId)
      return { decision, explanation: explainRoute(decision) }
    },
    /** One open attempt of a routed dispatch (the choice, then its fallback), journaled with the decision. */
    routeAttempt(decisionId: string, key: ModelKey, error?: string): void {
      try { store.appendRouteAttempt(decisionId, { key: registryKey(key), ok: !error, ...(error ? { error: error.slice(0, 500) } : {}), at: clock().toISOString() }) } catch (failure) { log('route attempt not stored', failure) }
    },

    recordOutcome,
    /** A routed or dispatched agent: its settled turns are captured with this decision and category,
     *  also after a restart (the store keeps BINDINGS_MAX bindings for BINDING_TTL_DAYS). */
    bindDispatch(agentSessionId: string, binding: Omit<DispatchBinding, 'at'>): void {
      try { store.saveBinding(agentSessionId, { ...binding, key: registryKey(binding.key), at: clock().getTime() }) } catch (error) { log('dispatch binding not stored', error) }
      // The task's category as dispatch labelled it (the caller's, else categorize()), with the decision model's beside it.
      const summary = binding.features?.summary
      if (summary) shadowDecide({
        kind: 'classify', requester: 'dispatch', impact: 'routine', question: 'Which kind of work is this task?',
        options: TASK_CATEGORIES.map(category => ({ id: category, label: category.replace(/-/g, ' ') })),
        state: { task: clipText(summary) }, projectId: binding.projectId, agentSessionId
      }, { choice: binding.features.category, by: 'dispatch-features', rationale: `router.dispatch labelled the task ${binding.features.category} (complexity ${binding.features.complexity}, risk ${binding.features.risk})` })
    },
    binding(agentSessionId: string): DispatchBinding | undefined {
      try { return store.binding(agentSessionId) ?? undefined } catch { return undefined }
    },
    /** A structured session reported a phase; only settled turns of bound agents are captured. */
    turnSettled(event: { agentSessionId: string; runtimeId?: string; turnId?: string; phase: SessionPhase; limited?: boolean }, projection: () => { items: TimelineItem[] } | null | undefined): ExecutionOutcome | null {
      if (!SETTLED.has(event.phase)) return null
      const binding = service.binding(event.agentSessionId)
      if (!binding) return null
      try {
        const items = projection()?.items ?? []
        const turnId = event.turnId ?? [...items].reverse().find(item => item.turnId && (!event.runtimeId || item.runtimeId === event.runtimeId))?.turnId
        if (!turnId) return null
        // A local turn that reported its stop is captured from that report (localTurnStopped), once.
        if (items.some(item => item.turnId === turnId && localStopOf(item.data))) return null
        const captured = recordOutcome(captureTurn({
          agentSessionId: event.agentSessionId, projectId: binding.projectId, turnId, ...(event.runtimeId ? { runtimeId: event.runtimeId } : {}), phase: event.phase, items,
          provider: binding.key.provider, model: binding.key.model, effort: binding.effort, features: binding.features, decisionId: binding.decisionId, ...(event.limited ? { limited: true } : {})
        }))
        // Did the dispatched worker finish? The turn's own ending is the decision made; the model reads only the words.
        if (captured && captured.result !== 'cancelled') {
          const answer = [...items].reverse().find(item => item.turnId === turnId && !item.parentId && item.data.type === 'text' && item.data.role === 'assistant')
          shadowDecide({
            kind: 'completion', requester: 'turn-capture', impact: 'routine', question: 'Did the worker finish the task it was given?',
            options: [{ id: 'finished', label: 'finished the task' }, { id: 'unfinished', label: 'did not finish: it failed, stopped early or left work open' }],
            state: { task: clipText(binding.features.summary ?? binding.features.category, 400), lastAnswer: answer && answer.data.type === 'text' ? clipText(answer.data.text) : '', toolFailures: captured.toolFailures ?? 0, retries: captured.retries ?? 0 },
            projectId: binding.projectId, agentSessionId: event.agentSessionId
          }, { choice: event.phase === 'completed' ? 'finished' : 'unfinished', by: 'turn-phase', rationale: `the turn settled ${event.phase} (${captured.result})` })
        }
        return captured
      } catch (error) { log('turn not captured', error); return null }
    },
    /** A durable-job stage settled (the handoff port's afterStage); deltas are exact from the second stage on. */
    stageSettled(input: Pick<StageResultInput, 'job' | 'stage' | 'observation' | 'succeeded'>): ExecutionOutcome | null {
      try {
        const before = countersBefore.get(input.job.id)
        countersBefore.set(input.job.id, { ...input.job.counters })
        if (countersBefore.size > 1_000) countersBefore.delete(countersBefore.keys().next().value!)
        const captured = recordOutcome(captureDurableStage({ job: input.job, stage: input.stage, observation: input.observation, succeeded: input.succeeded, ...(before ? { countersBefore: before } : {}) }))
        // The controller's own verdict on the stage (its stop report and the checked completion criteria).
        shadowDecide({
          kind: 'completion', requester: 'durable-jobs', impact: 'routine', question: 'Did this stage of the job meet its objective?',
          options: [{ id: 'finished', label: 'the stage met its objective' }, { id: 'unfinished', label: 'the stage did not meet its objective' }],
          state: stageState(input.stage, input.observation), projectId: input.job.projectId
        }, { choice: input.succeeded ? 'finished' : 'unfinished', by: 'durable-jobs-controller', rationale: `the controller judged stage ${input.stage.index + 1} ${input.succeeded ? 'completed' : 'not completed'}` })
        return captured
      } catch (error) { log('durable stage not captured', error); return null }
    },
    /** The durable-job loop guard answered after a failed attempt: retry it or stop for the owner (kind retry).
     *  Its stall check of a completed stage is part of the controller's answer, journaled by stageConcluded. Shadow only. */
    loopAssessed(input: { job: DurableJob; stage: DurableJobStage; observation: StageResultInput['observation']; error: string; previousErrors: string[] }, verdict: LoopAssessment): void {
      if (input.stage.status === 'completed') return
      try {
        shadowDecide({
          kind: 'retry', requester: 'durable-jobs', impact: 'routine', question: 'This attempt at the stage failed. Try it again, or stop and ask the owner?',
          options: [{ id: 'retry', label: 'try the stage again' }, { id: 'escalate', label: 'stop the job and ask the owner' }],
          state: { ...stageState(input.stage, input.observation), error: clipText(input.error, 600), previousErrors: input.previousErrors.slice(-3).map(error => clipText(error, 300)) },
          projectId: input.job.projectId
        }, { choice: verdict.loop ? 'escalate' : 'retry', by: 'durable-jobs-loop-guard', rationale: verdict.loop ? `the loop guard stopped the job: ${verdict.detail}` : 'the loop guard saw no loop' })
      } catch (error) { log('loop verdict not shadowed', error) }
    },
    /** The durable-job controller answered after a completed stage: go on (next stage, or finish) or stop and ask the
     *  owner (kind escalate). The state is the stage and its result, never the controller's reason. Shadow only. */
    stageConcluded(conclusion: StageConclusion): void {
      try {
        shadowDecide({
          kind: 'escalate', requester: 'durable-jobs', impact: 'routine', question: 'The stage finished. Go on with the job, or stop and ask the owner?',
          options: [{ id: 'continue', label: 'go on: the next stage, or finish the job' }, { id: 'escalate', label: 'stop the job and ask the owner' }],
          state: { ...stageState(conclusion.stage, conclusion.observation), result: clipText(conclusion.stage.result ?? '', 600) },
          projectId: conclusion.job.projectId
        }, { choice: conclusion.escalated ? 'escalate' : 'continue', by: 'durable-jobs-controller', rationale: conclusion.escalated ? `the controller stopped the job for the owner: ${conclusion.detail}` : `the controller went on: ${conclusion.detail}` })
      } catch (error) { log('stage conclusion not shadowed', error) }
    },
    /** Per kind, how the decision model did (asked, failed, agreement, median time), or null without one. */
    deciderAgreement(kinds: readonly DecisionKind[]): Array<ReturnType<ModelIntelligenceStore['deciderAgreement']>> | null {
      if (!decider) return null
      const since = new Date(clock().getTime() - 90 * DAILY_MS).toISOString()
      try { return kinds.map(kind => store.deciderAgreement({ kind, decider: LAYA_DECIDER_ID, since })) } catch (error) { log('decider agreement unavailable', error); return null }
    },
    /** Settles once every shadow decision started so far has been journaled (tests and smokes). */
    async shadowsSettled(): Promise<void> { while (pendingShadows.size) await Promise.allSettled([...pendingShadows]) },
    /** A local agent turn stopped (the local adapter's stop notice, LocalStopReport): its outcome from the
     *  report and the turn's failed tool-grammar repairs, read from the projection already in memory. A
     *  dispatched turn keeps its binding's decision and category; any other counts only with a category
     *  signal, as captureTurn does. Durable-job stages are left to stageSettled. */
    localTurnStopped(event: { agentSessionId: string; turnId: string; runtimeId?: string; projectId?: string; report: LocalStopReport }, projection: () => { items: TimelineItem[]; settings?: { model?: string } } | null | undefined): ExecutionOutcome | null {
      try {
        const binding = service.binding(event.agentSessionId), state = projection()
        const model = binding ? (binding.key.provider === 'local' ? binding.key.model : undefined) : state?.settings?.model
        if (!model) return null
        const items = state?.items ?? [], own = items.filter(item => item.turnId === event.turnId && (!event.runtimeId || item.runtimeId === event.runtimeId) && !item.parentId)
        // The prompt is the turn's own user item, else the last one before the turn (as captureTurn reads it).
        const userText = (item: TimelineItem) => item.data.type === 'text' && item.data.role === 'user' ? [item.data] : []
        const first = Math.min(...own.map(item => item.sequence))
        const user = own.flatMap(userText)[0] ?? items.filter(item => !item.parentId && item.sequence < first).flatMap(userText).at(-1)
        if (user?.origin?.agentSessionId === DURABLE_JOB_ORIGIN) return null
        const features = binding?.features ?? categorize({ prompt: user?.text ?? '', tools: own.flatMap(item => item.data.type === 'tool' ? [item.data.name] : []) })
        if (!binding && features.category === 'general') return null
        const repairs = own.flatMap((item): LocalTelemetryEntry[] => {
          const entry = item.data.type === 'notice' && item.data.payload && typeof item.data.payload === 'object' && !Array.isArray(item.data.payload) ? item.data.payload.localTelemetry as { kind?: unknown } | undefined : undefined
          return entry?.kind === 'repair' ? [entry as LocalTelemetryEntry] : []
        })
        return recordOutcome(captureLocalAgentStop({
          telemetry: [...repairs, { kind: 'stop', report: event.report }], model, ref: `${event.agentSessionId}:${event.turnId}`, agentSessionId: event.agentSessionId,
          projectId: binding?.projectId ?? event.projectId ?? null, decisionId: binding?.decisionId ?? null, features, ...(user ? { prompt: user.text } : {}), at: clock().toISOString()
        }))
      } catch (error) { log('local stop not captured', error); return null }
    },

    /** models.list: registry facts and the best-evidenced reputation dimensions of one catalog entry. */
    modelFacts(key: ModelKey): { registry: { status: string; pricing: RegistryRecord['pricing']; contextTokens: number | null; stale: boolean; capabilityRank: number | null } | null; reputation: Array<{ dimension: string; mean: number; lower: number; evidence: number }> | null } | null {
      try {
        const record = registry.get(registryKey(key))
        if (!record) return null
        const profile = reputation.profile(record.key).sort((a, b) => b.evidence - a.evidence).slice(0, 3)
        return {
          registry: { status: record.status, pricing: record.pricing, contextTokens: record.contextTokens, stale: record.stale, capabilityRank: record.capabilityRank ?? null },
          reputation: profile.length ? profile.map(score => ({ dimension: score.dimension, mean: round(score.mean), lower: round(score.lower), evidence: round(score.evidence) })) : null
        }
      } catch (error) { log('model facts unavailable', error); return null }
    },

    evaluationCaps,
    excludedModels,
    /** The owner's weekly stop for a provider (setting `model-intelligence:weekly-stop`), as routing applies it. */
    weeklyStop,
    fixedOverheadTokens,
    /** Starts an evaluation in the background. Local keys through the local runner; cloud keys through
     *  the native provider path under the owner's caps (daily count and tokens, per-run tokens, and
     *  never at or above the provider's weekly stop, where unknown usage means skip). */
    async startEvaluation(key: ModelKey, suiteName: string | undefined, evaluationOptions: { maxJobs?: number; scope?: EvaluationScope } = {}): Promise<EvaluationHandle> {
      const wiring = options.evaluation
      const target = registryKey(key), cloud = target.provider !== 'local'
      const run = cloud ? wiring?.runCloud : wiring?.runLocal
      if (!wiring || !run) throw new Error(cloud ? 'Cloud model evaluation is not wired in this Conductor' : 'Model evaluation is not wired in this Conductor')
      if (!registry.get(target)) throw new Error(`${modelKeyId(target)} is not in the model registry; run models.refresh first`)
      const excludedPattern = excludedMatcher(excludedModels())(target)
      if (excludedPattern) throw new Error(`${modelKeyId(target)} is ${EXCLUDED_BY_OWNER} (${EXCLUDED_MODELS_SETTING}: ${excludedPattern}); it is not evaluated`)
      const suites = wiring.suites(), names = Object.keys(suites)
      const name = suiteName ?? names[0]
      const suite = name ? suites[name] : undefined
      if (!suite) throw new Error(names.length ? `Unknown suite ${String(suiteName)}; one of ${names.join(', ')}` : 'No evaluation suite is available')
      if (!cloud) {
        const blocked = await wiring.precheck?.(target)
        if (blocked) throw new Error(blocked)
      }
      const command = await wiring.command?.().catch(() => null) ?? null
      // Everything from here to the handle is synchronous, so two starts cannot both pass the checks.
      if ([...evaluations.values()].some(handle => handle.state === 'running')) throw new Error('An evaluation is already running; one at a time on this machine')
      let maxTokens: number | undefined
      const jobs = suite.jobs.slice(0, evaluationOptions.maxJobs ?? suite.jobs.length), smallestJob = cloud ? smallestCloudJob(jobs, command !== null) : null
      if (cloud) {
        const caps = evaluationCaps(), stop = caps.weeklyStop[target.provider]
        const usage = wiring.usage?.(target.provider) ?? null
        if (stop === undefined) throw new Error(`No weekly stop is set for ${target.provider}; set one in ${EVALUATION_CAPS_SETTING} before evaluating it`)
        if (usage === null) throw new Error(`${target.provider}'s weekly usage is unknown, so the evaluation is skipped (owner rule: unknown usage means skip)`)
        if (usage >= stop) throw new Error(`${target.provider} is at ${Math.round(usage)}% of its week, at or above the ${stop}% stop; no evaluation`)
        const spent = store.evaluationSpend(new Date(clock().getTime() - DAILY_MS).toISOString())
        if (spent.runs >= caps.perDayEvaluations) throw new Error(`${spent.runs} cloud evaluations ran in the last 24 h; the cap is ${caps.perDayEvaluations}`)
        // A run gets what is left of the day (runs in progress keep the rest of their caps reserved), at
        // most the per-run cap, and holds it until it ends: the day can never pass its token cap.
        const reserved = [...evaluations.values()].reduce((sum, handle) => sum + (handle.state === 'running' && handle.maxTokens !== undefined ? Math.max(0, handle.maxTokens - (runSpend.get(handle.runId) ?? 0)) : 0), 0)
        const remaining = caps.perDayTokens - spent.tokens - reserved, runCap = Math.min(caps.perRunTokens, remaining), floor = Math.min(caps.minRunTokens, caps.perRunTokens)
        if (runCap < floor) throw new Error(`Cloud evaluations used ${spent.tokens} tokens in the last 24 h${reserved ? ` and ${reserved} more are reserved by a run in progress` : ''}; ${Math.max(0, remaining)} of the daily ${caps.perDayTokens} are left, below the ${floor} a run needs`)
        // A cloud run is one batched turn: it must hold the turn's fixed overhead and at least one job, or it is
        // refused here, before it counts as one of the day's runs (N14). A recent raw measurement is charged as
        // measured, so a cap below the real preamble refuses instead of starting a turn sure to be cut off (N19).
        if (smallestJob === null) throw new Error(`No job of ${suite.name} can be graded in a cloud run: every one needs a command runner`)
        const banded = fixedOverheadTokens(target.provider, smallestJob), measured = recentMeasured(target.provider)
        const fromMeasurement = measured !== null && measured.tokens > banded, overhead = fromMeasurement ? measured.tokens : banded, needed = overhead + smallestJob
        if (needed > runCap) {
          const why = [
            ...(runCap < caps.perRunTokens ? [`the day has ${Math.max(0, remaining)} of its ${caps.perDayTokens} left`] : []),
            ...(needed > caps.perRunTokens ? [`raise perRunTokens in ${EVALUATION_CAPS_SETTING} to at least ${needed}${fromMeasurement ? `, or from ${measured.until} one run measures it again` : ''}`] : [])
          ]
          throw new Error(`A ${runCap}-token run cannot hold a ${target.provider} turn's ${overhead} fixed tokens${fromMeasurement ? ` (measured ${measured.at})` : ''} plus the smallest job's ${smallestJob}${why.map(reason => `; ${reason}`).join('')}; no run was counted`)
        }
        maxTokens = runCap
      }
      const notGradable = command ? [] : suite.jobs.filter(job => job.grader.kind === 'command').map(job => `${job.id} (command: not gradable here)`)
      const handle: EvaluationHandle = { runId: makeId('evaluation'), key: target, suite: suite.name, state: 'running', startedAt: clock().toISOString(), notGradable, ...(maxTokens !== undefined ? { maxTokens } : {}) }
      evaluations.set(handle.runId, handle)
      // recordSpend and maxTokens are evaluation.ts's cap contract (builder C): the run stops at the cap and journals its spend once.
      const spendPort = { recordSpend: (spend: EvaluationSpend) => {
        runSpend.set(spend.runId, spend.tokens)
        try { store.recordEvaluationSpend(spend) } catch (error) { log('evaluation spend not journaled', error) }
      } }
      // A cloud job's worst case is its budget (else the run cap): a turn without usage counts it, and a
      // failed one throws an EvaluationTurnError carrying at least it (N3). A turn refused before any model
      // call spent nothing: its refusal passes through uncharged.
      const scope = evaluationOptions.scope
      const cloudJob = async (runKey: ModelKey, job: EvaluationJob, signal: AbortSignal, budget?: { maxTokens: number }): Promise<EvaluationRun> => {
        const jobBudget = budget ?? (maxTokens !== undefined ? { maxTokens } : undefined)
        try {
          const { overheadTokens, ...result }: CloudRun = await run(runKey, job, signal, jobBudget, ...(scope ? [{ scope }] : []))
          recordOverhead(runKey.provider, overheadTokens, smallestJob ?? 0)
          return result.tokens == null && jobBudget ? { ...result, tokens: jobBudget.maxTokens } : result
        } catch (error) {
          if (isRefusal(error)) throw error
          recordOverhead(runKey.provider, (error as { overheadTokens?: unknown } | null)?.overheadTokens, smallestJob ?? 0)
          const reported = (error as { tokens?: unknown } | null)?.tokens
          const measured = typeof reported === 'number' && Number.isFinite(reported) ? reported : null
          throw new EvaluationTurnError(error instanceof Error ? error.message : String(error), jobBudget ? Math.max(measured ?? 0, jobBudget.maxTokens) : measured)
        }
      }
      // fixedOverheadTokens is evaluation.ts's batching input (builder C, N9): a cloud run pays it once.
      const ports: EvaluationPorts & { fixedOverheadTokens(provider: string): number } = {
        run: cloud ? cloudJob : (runKey, job, signal, budget) => run(runKey, job, signal, budget),
        ...(command ? { command } : {}),
        recordOutcome: outcome => { recordOutcome(outcome) },
        setStatus: (statusKey, status) => { try { registry.setStatus(statusKey, status) } catch (error) { log('status not set', error) } },
        outcomes: outcomeKey => store.outcomes({ key: outcomeKey, since: new Date(clock().getTime() - 180 * DAILY_MS).toISOString(), limit: 5_000 }),
        reputation: (reputationKey, dimension) => reputation.reputation(reputationKey, dimension),
        alternatives: altKey => registry.list({ provider: altKey.provider }).map(record => record.key).slice(0, 4),
        writeReport: (reportName, markdown) => { try { wiring.writeReport?.(reportName, markdown) } catch (error) { log('evaluation report not written', error) } },
        now: clock, ...spendPort, fixedOverheadTokens: provider => fixedOverheadTokens(provider, smallestJob ?? 0)
      }
      const tokenCap = maxTokens !== undefined ? { maxTokens } : {}
      const runOptions: EvaluationOptions = { runId: handle.runId, ...(evaluationOptions.maxJobs ? { maxJobs: evaluationOptions.maxJobs } : {}), ...tokenCap }
      void evaluate(target, suite, ports, runOptions)
        .then(result => { Object.assign(handle, { state: 'done', result }) }, error => { Object.assign(handle, { state: 'failed', error: error instanceof Error ? error.message : String(error) }); log('evaluation failed', error) })
        .finally(() => runSpend.delete(handle.runId))
      return handle
    },
    evaluation(runId: string): EvaluationHandle | undefined { return evaluations.get(runId) },
    /** One-off correction (B5-G): a cloud run journaled before refusals were recognised, whose report shows its
     *  one turn refused before any model call, was charged its whole budget; it is released (0 tokens, not one of
     *  the day's runs). Runs whose turn started keep their charge. Returns the released runIds. */
    reconcileRefusedEvaluations(): string[] {
      const readReport = options.evaluation?.readReport
      if (!readReport) return []
      const released: string[] = []
      for (const spend of store.evaluationRuns(new Date(clock().getTime() - 2 * DAILY_MS).toISOString())) {
        if (spend.stoppedBy === 'refused' || spend.key.provider === 'local' || spend.gradedJobs > 0 || (spend.costUsd ?? 0) > 0 || !(spend.tokens > 0)) continue
        if ([...evaluations.values()].some(handle => handle.runId === spend.runId && handle.state === 'running')) continue
        let markdown: string | null = null
        try { markdown = readReport(spend.runId) } catch (error) { log('evaluation report unreadable', error) }
        const reason = markdown ? refusedBeforeTurn(markdown) : null
        if (reason && store.releaseEvaluationSpend(spend.runId, reason)) released.push(spend.runId)
      }
      return released
    },

    dispose(): void {
      for (const dispose of disposers.splice(0)) dispose()
      shadow.dispose()
      try { store.close() } catch { /* already closed */ }
    }
  }
  return service
}
export type ModelIntelligence = ReturnType<typeof createModelIntelligence>
export { BINDING_TTL_DAYS }

/** The suites shipped with the app (suites/*.json), validated once. */
export function bundledSuites(): Record<string, EvaluationSuite> {
  const suite = validateSuite(defaultSuite)
  return { [suite.name]: suite }
}

/** The valid percents (0..100) of a stored stop map; anything else is dropped, so its provider keeps its default. */
function validStops(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0 && entry[1] <= 100))
}

/** Providers none of whose candidates may be used because of a usage limit, with the first reason. */
export function usageBlockedProviders(decision: Pick<RouteDecision, 'candidates'>): Array<{ provider: string; reason: string }> {
  const byProvider = new Map<string, typeof decision.candidates>()
  for (const candidate of decision.candidates) byProvider.set(candidate.key.provider, [...byProvider.get(candidate.key.provider) ?? [], candidate])
  const usage = (text: string | null | undefined) => !!text && /usage .*(stop|limit)/i.test(text)
  return [...byProvider].filter(([, candidates]) => candidates.every(candidate => !candidate.eligible) && candidates.some(candidate => usage(candidate.excluded)))
    .map(([provider, candidates]) => ({ provider, reason: candidates.find(candidate => usage(candidate.excluded))!.excluded!.replace(/^usage: /, '') }))
}

/** The current weekly usage percent of a provider's reports, null when none is current (unknown). */
export function weeklyUsage(windows: AccountLimitWindow[]): number | null {
  const weekly = windows.filter(window => window.state !== 'reset' && window.kind === 'weekly' && window.scope === 'provider')
  return weekly.length ? Math.max(...weekly.map(window => window.usedPercent)) : null
}
export { defaultUsageStop }

const round = (value: number): number => Math.round(value * 1000) / 1000

/** Features for a task prompt with the caller's overrides validated on top. */
export function taskFeatures(base: TaskFeatures, override: unknown): TaskFeatures {
  if (override === undefined || override === null) return base
  if (typeof override !== 'object' || Array.isArray(override)) throw new Error('route.features must be an object')
  const input = override as Record<string, unknown>, features: TaskFeatures = { ...base }
  const unknown = Object.keys(input).filter(key => !['category', 'complexity', 'risk', 'toolsRequired', 'contextTokens', 'summary'].includes(key))
  if (unknown.length) throw new Error(`route.features accepts category, complexity, risk, toolsRequired, contextTokens and summary, not ${unknown.join(', ')}`)
  if (input.category !== undefined) { if (!(TASK_CATEGORIES as readonly string[]).includes(String(input.category))) throw new Error(`route.features.category must be one of ${TASK_CATEGORIES.join(', ')}`); features.category = input.category as TaskCategory }
  if (input.complexity !== undefined) { if (![1, 2, 3, 4, 5].includes(input.complexity as number)) throw new Error('route.features.complexity must be 1..5'); features.complexity = input.complexity as TaskFeatures['complexity'] }
  if (input.risk !== undefined) { if (!['low', 'medium', 'high'].includes(String(input.risk))) throw new Error('route.features.risk must be low, medium or high'); features.risk = input.risk as TaskFeatures['risk'] }
  if (input.toolsRequired !== undefined) { if (!Array.isArray(input.toolsRequired) || input.toolsRequired.length > 40 || input.toolsRequired.some(tool => typeof tool !== 'string' || tool.length > 80)) throw new Error('route.features.toolsRequired must be at most 40 tool names'); features.toolsRequired = input.toolsRequired as string[] }
  if (input.contextTokens !== undefined) { if (input.contextTokens !== null && (!Number.isInteger(input.contextTokens) || (input.contextTokens as number) < 0)) throw new Error('route.features.contextTokens must be a whole number or null'); features.contextTokens = input.contextTokens as number | null }
  if (input.summary !== undefined) { if (typeof input.summary !== 'string') throw new Error('route.features.summary must be text'); features.summary = input.summary.slice(0, 300) }
  return features
}

/** Validated route constraints; unknown fields are refused rather than silently ignored. */
export function routeConstraints(value: unknown): Partial<RouteConstraints> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('route.constraints must be an object')
  const input = value as Record<string, unknown>, constraints: Partial<RouteConstraints> = {}
  const unknown = Object.keys(input).filter(key => !['costWeight', 'latencyWeight', 'maxCostUsd', 'localOnly', 'excludeProviders', 'allow', 'urgency'].includes(key))
  if (unknown.length) throw new Error(`route.constraints accepts costWeight, latencyWeight, maxCostUsd, localOnly, excludeProviders, allow and urgency, not ${unknown.join(', ')}`)
  const unit = (key: 'costWeight' | 'latencyWeight') => { const number = input[key]; if (typeof number !== 'number' || !(number >= 0 && number <= 1)) throw new Error(`route.constraints.${key} must be 0..1`); constraints[key] = number }
  if (input.costWeight !== undefined) unit('costWeight')
  if (input.latencyWeight !== undefined) unit('latencyWeight')
  if (input.maxCostUsd !== undefined) { if (input.maxCostUsd !== null && (typeof input.maxCostUsd !== 'number' || !(input.maxCostUsd >= 0))) throw new Error('route.constraints.maxCostUsd must be a non-negative number or null'); constraints.maxCostUsd = input.maxCostUsd as number | null }
  if (input.localOnly !== undefined) { if (typeof input.localOnly !== 'boolean') throw new Error('route.constraints.localOnly must be true or false'); constraints.localOnly = input.localOnly }
  if (input.excludeProviders !== undefined) { if (!Array.isArray(input.excludeProviders) || input.excludeProviders.some(provider => typeof provider !== 'string')) throw new Error('route.constraints.excludeProviders must be provider names'); constraints.excludeProviders = input.excludeProviders as string[] }
  if (input.allow !== undefined) {
    if (!Array.isArray(input.allow) || input.allow.length > 50) throw new Error('route.constraints.allow must be at most 50 {provider, model} keys')
    constraints.allow = input.allow.map(entry => {
      const key = typeof entry === 'string' ? parseKeyId(entry) : entry && typeof entry === 'object' && typeof (entry as ModelKey).provider === 'string' && typeof (entry as ModelKey).model === 'string' ? entry as ModelKey : null
      if (!key) throw new Error('route.constraints.allow entries are {provider, model} or "provider/model"')
      return registryKey({ provider: key.provider, model: key.model })
    })
  }
  if (input.urgency !== undefined) { if (input.urgency !== 'normal' && input.urgency !== 'urgent') throw new Error('route.constraints.urgency must be normal or urgent'); constraints.urgency = input.urgency }
  return constraints
}

/** The model a route decision chose, in registry form (for an owner outcome recorded against it). */
export const decisionKey = (record: DecisionRecord): ModelKey | null => record.kind === 'route' || record.kind === 'fallback' ? record.choice ? parseKeyId(record.choice) : null : null

/** A stored binding older than this is forgotten: capture stops for that agent. */
export const BINDING_TTL_MS = BINDING_TTL_DAYS * DAILY_MS
