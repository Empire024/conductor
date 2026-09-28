import { makeId } from '../../shared/models'
import {
  DECISION_STATE_MAX_CHARS, type Decider, type DeciderOutcome, type DecisionKind, type DecisionRecord,
  type DecisionRequest, type DecisionThresholds
} from '../../shared/model-routing'

/**
 * DecisionService (docs/model-routing.md, module C): a system-one decider answers routine bounded
 * decisions; the frontier decider settles what system-one is unsure of, what is high-impact, what
 * only the frontier may choose, and everything while a kind is in shadow. Every verdict is journaled.
 */

export const THRESHOLDS_SETTING = 'model-routing:thresholds:v1'
const DECISION_KINDS: DecisionKind[] = ['route', 'approval', 'retry', 'escalate', 'completion', 'fallback', 'classify']
const routine = (minConfidence: number, minMargin: number): DecisionThresholds => ({ minConfidence, minMargin, highImpact: 'escalate-when-unsure', frontierOnly: [], mode: 'live' })
export const DEFAULT_THRESHOLDS: Readonly<Record<DecisionKind, DecisionThresholds>> = {
  route: routine(0.55, 0.15),
  approval: { minConfidence: 0.9, minMargin: 0.3, highImpact: 'always-escalate', frontierOnly: ['deny'], mode: 'shadow' },
  retry: routine(0.7, 0.2), escalate: routine(0.7, 0.2), completion: routine(0.7, 0.2), fallback: routine(0.7, 0.2),
  classify: routine(0.5, 0),
}

export interface ThresholdSettings { getSetting(key: string): string | null; setSetting(key: string, value: string): void }
/** Module A's store satisfies this. */
export interface DecisionJournal { record(record: DecisionRecord): void }
export interface DecisionServicePorts {
  deciders: Decider[]
  journal: DecisionJournal
  settings: ThresholdSettings
  now?(): Date
  /** A journal write failed; the decision still stands and is returned. */
  journalFailed?(error: unknown, record: DecisionRecord): void
}
export interface DecideOptions {
  signal?: AbortSignal
  /** A frontier decider bound to this one request (the approval gate's reviewer for one action). */
  frontier?: Decider
  /** The system-one verdict already asked for this request (askSystemOne), so it is not asked twice. */
  systemOne?: DeciderOutcome
  /** This request's mode instead of its kind's: the approval shadow keeps measuring in 'shadow', and a boundary
   *  the owner switched live decides in 'live'. */
  mode?: DecisionThresholds['mode']
}

type Overrides = Partial<Record<DecisionKind, Partial<DecisionThresholds>>>
const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
/** Only the valid fields of a stored or requested patch; everything else keeps its default. */
function cleanPatch(value: unknown): Partial<DecisionThresholds> {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}, patch: Partial<DecisionThresholds> = {}
  if (unit(input.minConfidence)) patch.minConfidence = input.minConfidence
  if (unit(input.minMargin)) patch.minMargin = input.minMargin
  if (input.highImpact === 'always-escalate' || input.highImpact === 'escalate-when-unsure') patch.highImpact = input.highImpact
  if (input.mode === 'off' || input.mode === 'shadow' || input.mode === 'live') patch.mode = input.mode
  if (Array.isArray(input.frontierOnly) && input.frontierOnly.every(id => typeof id === 'string')) patch.frontierOnly = [...new Set(input.frontierOnly as string[])]
  return patch
}

/** Probabilities over exactly the option ids, summing to 1; unknown ids and non-finite or negative
 *  values are dropped. Null when nothing usable is left. */
export function normaliseProbabilities(probabilities: Record<string, number>, optionIds: string[]): Record<string, number> | null {
  const kept = optionIds.map(id => { const value = probabilities[id]; return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0 })
  const total = kept.reduce((sum, value) => sum + value, 0)
  if (!(total > 0)) return null
  return Object.fromEntries(optionIds.map((id, index) => [id, kept[index]! / total]))
}
/** Top option (ties by option order), its probability and its lead over the runner-up. */
export function topChoice(probabilities: Record<string, number>, optionIds: string[]): { choice: string; confidence: number; margin: number } {
  let choice = optionIds[0]!, best = -1, second = 0
  for (const id of optionIds) {
    const value = probabilities[id] ?? 0
    if (value > best) { second = Math.max(second, best); best = value; choice = id } else second = Math.max(second, value)
  }
  return { choice, confidence: Math.max(best, 0), margin: Math.max(best, 0) - second }
}

export function validateDecisionRequest(request: DecisionRequest): void {
  if (!DECISION_KINDS.includes(request.kind)) throw new Error(`Unknown decision kind ${String(request.kind)}`)
  if (!Array.isArray(request.options) || !request.options.length) throw new Error('A decision needs at least one option')
  const ids = request.options.map(option => option.id)
  if (ids.some(id => typeof id !== 'string' || !id)) throw new Error('Every decision option needs an id')
  if (new Set(ids).size !== ids.length) throw new Error('Decision option ids must be unique')
  let state: string | undefined
  try { state = JSON.stringify(request.state ?? {}) } catch { throw new Error('Decision state must be serialisable') }
  if ((state ?? '').length > DECISION_STATE_MAX_CHARS) throw new Error(`Decision state exceeds ${DECISION_STATE_MAX_CHARS} characters`)
}

const pct = (value: number) => value.toFixed(2)
const failure = (outcome: Extract<DeciderOutcome, { ok: false }>) => ({ decider: outcome.decider, failed: outcome.reason })

export class DecisionService {
  constructor(private ports: DecisionServicePorts) {}
  thresholds(kind: DecisionKind): DecisionThresholds { return { ...DEFAULT_THRESHOLDS[kind], ...cleanPatch(this.overrides()[kind]) } }
  allThresholds(): Record<DecisionKind, DecisionThresholds> { return Object.fromEntries(DECISION_KINDS.map(kind => [kind, this.thresholds(kind)])) as Record<DecisionKind, DecisionThresholds> }
  /** Stores a validated patch for one kind; `null` restores its defaults. Throws on an invalid field. */
  setThresholds(kind: DecisionKind, patch: Partial<DecisionThresholds> | null): DecisionThresholds {
    if (!DECISION_KINDS.includes(kind)) throw new Error(`Unknown decision kind ${String(kind)}`)
    const overrides = this.overrides()
    if (patch === null) delete overrides[kind]
    else {
      const clean = cleanPatch(patch)
      const invalid = Object.keys(patch).filter(field => !(field in clean))
      if (invalid.length) throw new Error(`Invalid threshold field${invalid.length === 1 ? '' : 's'}: ${invalid.join(', ')}`)
      overrides[kind] = { ...cleanPatch(overrides[kind]), ...clean }
    }
    this.ports.settings.setSetting(THRESHOLDS_SETTING, JSON.stringify(overrides))
    return this.thresholds(kind)
  }
  private overrides(): Overrides {
    try {
      const parsed: unknown = JSON.parse(this.ports.settings.getSetting(THRESHOLDS_SETTING) ?? '{}')
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Overrides : {}
    } catch { return {} }
  }

  /** Only the system-one verdict (probabilities normalised over the options), journaling nothing; null when no
   *  system-one decider takes this kind. decide({systemOne}) then records it without asking again. */
  async askSystemOne(request: DecisionRequest, signal?: AbortSignal): Promise<DeciderOutcome | null> {
    validateDecisionRequest(request)
    const systemOne = this.ports.deciders.find(decider => decider.tier === 'system-one' && decider.supports(request.kind))
    return systemOne ? this.ask(systemOne, request, signal) : null
  }
  private async ask(decider: Decider, request: DecisionRequest, signal?: AbortSignal): Promise<DeciderOutcome> {
    try {
      const outcome = await decider.decide(request, signal)
      if (!outcome.ok) return outcome
      const probabilities = normaliseProbabilities(outcome.verdict.probabilities, request.options.map(option => option.id))
      return probabilities ? { ok: true, verdict: { ...outcome.verdict, probabilities } } : { ok: false, decider: decider.id, reason: 'No probability for any offered option' }
    } catch (error) { return { ok: false, decider: decider.id, reason: error instanceof Error ? error.message : String(error) } }
  }

  async decide(request: DecisionRequest, options: DecideOptions = {}): Promise<DecisionRecord> {
    validateDecisionRequest(request)
    const thresholds = { ...this.thresholds(request.kind), ...(options.mode ? { mode: options.mode } : {}) }, ids = request.options.map(option => option.id)
    const systemOne = thresholds.mode === 'off' ? undefined : this.ports.deciders.find(decider => decider.tier === 'system-one' && decider.supports(request.kind))
    const frontier = options.frontier ?? this.ports.deciders.find(decider => decider.tier === 'frontier' && decider.supports(request.kind))
    const ask = (decider: Decider): Promise<DeciderOutcome> => this.ask(decider, request, options.signal)
    // Escalation that is certain before system-one answers runs the frontier alongside it, so a
    // shadow verdict never delays the decision the frontier makes anyway.
    const certain = thresholds.mode !== 'live' ? `mode ${thresholds.mode}` : request.impact === 'high' && thresholds.highImpact === 'always-escalate' ? 'high-impact decision' : null
    const early = certain && frontier ? ask(frontier) : undefined
    const first: DeciderOutcome | undefined = thresholds.mode === 'off' ? undefined : options.systemOne ?? (systemOne ? await ask(systemOne) : undefined)
    const verdicts: DecisionRecord['verdicts'] = []
    if (first) verdicts.push(first.ok ? first.verdict : failure(first))

    const reasons: string[] = certain ? [certain] : []
    let top: ReturnType<typeof topChoice> | undefined, closeCall = false
    if (!first) { if (!certain) reasons.push(`no system-one decider for ${request.kind}`) }
    else if (!first.ok) reasons.push(`system-one failed: ${first.reason}`)
    else {
      top = topChoice(first.verdict.probabilities, ids)
      if (top.confidence < thresholds.minConfidence) reasons.push(`confidence ${pct(top.confidence)} < ${pct(thresholds.minConfidence)}`)
      if (ids.length > 1 && top.margin < thresholds.minMargin) reasons.push(`margin ${pct(top.margin)} < ${pct(thresholds.minMargin)}`)
      const unsure = reasons.length
      if (thresholds.frontierOnly.includes(top.choice)) reasons.push(`'${top.choice}' is frontier-only`)
      if (!certain && request.impact === 'high' && thresholds.highImpact === 'always-escalate') reasons.push('high-impact decision')
      closeCall = !certain && unsure > 0 && unsure === reasons.length
    }
    const base = { id: makeId('decision'), kind: request.kind, requester: request.requester, question: request.question, options: request.options, state: request.state,
      at: (this.ports.now?.() ?? new Date()).toISOString(), outcome: null, projectId: request.projectId ?? null, agentSessionId: request.agentSessionId ?? null,
      systemOne: !first ? null : first.ok && top ? { decider: first.verdict.decider, choice: top.choice, confidence: top.confidence } : { decider: first.ok ? first.verdict.decider : first.decider, choice: null, confidence: 0, failed: first.ok ? 'no choice' : first.reason } }
    let record: DecisionRecord
    if (!reasons.length && first?.ok && top) {
      record = { ...base, choice: top.choice, confidence: top.confidence, margin: top.margin, probabilities: first.verdict.probabilities, decidedBy: first.verdict.decider, escalated: false, escalationReason: null, verdicts, rationale: first.verdict.rationale }
    } else if (request.kind === 'route' && closeCall && !frontier && first?.ok && top) {
      // A route must name a model; without a frontier the scorer's top pick stands, marked for audit.
      record = { ...base, choice: top.choice, confidence: top.confidence, margin: top.margin, probabilities: first.verdict.probabilities, decidedBy: first.verdict.decider, escalated: false,
        escalationReason: 'close call, no frontier configured', verdicts, rationale: `${first.verdict.rationale} (${reasons.join('; ')})` }
    } else {
      const escalationReason = reasons.join('; ')
      const second: DeciderOutcome = early ? await early : frontier ? await ask(frontier) : { ok: false, decider: 'frontier', reason: `no frontier decider for ${request.kind}` }
      verdicts.push(second.ok ? second.verdict : failure(second))
      if (second.ok) {
        const decided = topChoice(second.verdict.probabilities, ids)
        record = { ...base, choice: decided.choice, confidence: decided.confidence, margin: decided.margin, probabilities: second.verdict.probabilities, decidedBy: second.verdict.decider, escalated: true, escalationReason, verdicts, rationale: second.verdict.rationale }
      } else {
        record = { ...base, choice: null, confidence: 0, margin: 0, probabilities: {}, decidedBy: 'none', escalated: true, escalationReason, verdicts,
          rationale: `No decision: ${escalationReason}; frontier failed: ${second.reason}. The caller keeps its previous behaviour.` }
      }
    }
    try { this.ports.journal.record(record) } catch (error) { this.ports.journalFailed?.(error, record) }
    return record
  }
}

