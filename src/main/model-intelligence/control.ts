import { type DecisionKind, type ModelKey, type OutcomeResult } from '../../shared/model-routing'
import { categorize } from './categorize'
import { explainDecision } from './explain'
import { decisionKey, registryKey, routeConstraints, taskFeatures, type ModelIntelligence } from './index'
import type { RouteLiveFacts } from './router'
import type { IngestionSourceName } from './ingest'
import { INGESTION_SOURCES } from './ingest'
import { outcome as outcomeRow } from './capture/common'
import { systemOneOf } from './store'

/** App control for model intelligence (docs/model-routing.md, E; docs/agent-control.md). */

export const MODEL_READ_METHODS = ['models.registry', 'models.route', 'decisions.list', 'decisions.get'] as const
export const MODEL_MUTATION_METHODS = ['models.refresh', 'models.outcome', 'models.evaluate', 'decisions.live'] as const
/** The owner's go-live rule (2026-09-28): a boundary may act on its local verdict only at this agreement over this many cases. */
export const GO_LIVE = { agreement: 0.95, cases: 30, windowDays: 90 } as const
export const modelMethods = new Set<string>([...MODEL_READ_METHODS, ...MODEL_MUTATION_METHODS])

export const modelSignatures: Record<string, string> = {
  'models.registry': '({provider?,model?,status?,changesSince?,limit?}) — the model registry: each model+provider key with its status (unproven, evaluating, proven, retired), pricing per million tokens, context, capabilities, availability, which source said so (provenance) and stale; changesSince (ISO) adds what changed since then (new models, prices, context, removals). limit defaults to 100, at most 2000',
  'models.route': '({prompt?,features?,constraints?}) — a dry run of the router: which model+provider (and effort) it would pick for a task, with fallback, escalation, confidence and the reasons, as {decision, explanation}. features default to the categorisation of prompt (category, complexity 1-5, risk, toolsRequired, contextTokens); constraints: costWeight and latencyWeight 0..1, maxCostUsd, localOnly, excludeProviders, allow ["provider/model"], urgency. Only models this project can open are candidates. The decision is journaled (decisions.get)',
  'decisions.list': '({kind?,since?,limit?}) — {decisions, boundaries}. decisions: journaled routing and approval decisions, newest first: id, kind, requester, choice, confidence, who decided, whether it escalated, the system-one (local) verdict next to the final choice, and its outcome once known; since defaults to 30 days ago, limit to 50, at most 200. boundaries: per decision kind, cases, agreement (how often the local verdict matched the reviewer or owner answer over the last 90 days) and live (whether that kind acts on its local verdict)',
  'decisions.live': '({kind, live}) — owner or wizard only: let one decision kind act on its local (system-one) verdict (live true) or keep it in shadow, where the stronger model decides and the local verdict is only journaled (live false). Going live is refused below 95% agreement over at least 30 cases (see decisions.list boundaries); low-confidence and frontier-only choices still escalate',
  'decisions.get': '({decisionId}) — one decision in full: options, every decider verdict (the shadow one too), the choice and why, plus a readable explanation and the execution outcomes linked to it',
  'models.refresh': '({sources?}) — refresh the model registry now from sources (configured, runtime, openrouter, latest-models, benchmarks; default all) and return per-source results and the changes found. A failing source changes nothing and never blocks the others',
  'models.outcome': '({decisionId|outcomeId, result, ownerCorrected?, falseCompletion?, detail?}) — say how a routed decision or a recorded execution actually turned out (result success, partial, failure or cancelled; ownerCorrected when the owner had to fix it, falseCompletion when it claimed done and was not). The outcome feeds the model’s reputation, so the next route sees it. The owner, a wizard tab, or the conversation that asked for the decision (or controls the agent that ran it)',
  'models.evaluate': '({provider,model,suite?,maxJobs?}|{runId}) — run the evaluation suite against one model: its results become outcomes (source evaluation) and its status moves to proven or back to unproven; no default is changed. One evaluation at a time; a local model not while another local model holds the GPU. A cloud model needs the owner or a wizard tab and runs under the owner caps in settings (by default 60k tokens per run, then the remaining jobs are not gradable; at most 3 cloud evaluations and 150k tokens a day; never on a provider at or above its weekly stop, and not when its usage is unknown). Returns {runId} at once; poll with {runId}. Jobs whose check cannot run here are reported as not-gradable, not as failures; every run journals its token spend'
}

export interface ModelControlCaller {
  projectId: string
  agentSessionId: string
  /** The owner credential or a wizard tab. */
  sovereign: boolean
  /** A sandboxed local model, or a read-only or planning conversation. */
  readOnly: boolean
  live: RouteLiveFacts & { offered: ModelKey[] }
  /** The caller controls this agent conversation (it opened it). */
  controls(agentSessionId: string): boolean
}

type Args = Record<string, unknown>
const DAY_MS = 86_400_000
const RESULTS: OutcomeResult[] = ['success', 'partial', 'failure', 'cancelled']
const KINDS: DecisionKind[] = ['route', 'approval', 'retry', 'escalate', 'completion', 'fallback', 'classify']
const only = (args: Args, method: string, keys: string[]): void => {
  const extra = Object.keys(args).filter(key => !keys.includes(key) && key !== 'projectId' && key !== 'sessionId')
  if (extra.length) throw new Error(`${method} accepts only ${keys.join(', ')}; not ${extra.join(', ')}`)
}
const id = (args: Args, key: string): string => {
  const value = args[key]
  if (typeof value !== 'string' || !value || value.length > 200 || value.includes('\0')) throw new Error(`${key} must be an id`)
  return value
}
const limitOf = (value: unknown, fallback: number, maximum: number): number => {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error('limit must be a positive whole number')
  return Math.min(value as number, maximum)
}
const since = (value: unknown, fallbackDays: number, now: Date): string => {
  if (value === undefined) return new Date(now.getTime() - fallbackDays * DAY_MS).toISOString()
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('since must be an ISO timestamp')
  return new Date(value).toISOString()
}
const keyArgs = (args: Args): ModelKey => {
  if (typeof args.provider !== 'string' || !args.provider || typeof args.model !== 'string' || !args.model) throw new Error('provider and model are required (from models.list or models.registry)')
  return registryKey({ provider: args.provider, model: args.model })
}

/** Features of a route: the prompt's categorisation, with the caller's explicit fields on top. */
export function routeFeatures(args: { prompt?: unknown; features?: unknown }, projectId: string): ReturnType<typeof categorize> {
  const prompt = typeof args.prompt === 'string' ? args.prompt : ''
  if (!prompt && (args.features === undefined || args.features === null)) throw new Error('A route needs a prompt or features')
  return taskFeatures(categorize({ prompt, projectId }), args.features)
}

export async function callModelMethod(service: ModelIntelligence, caller: ModelControlCaller, method: string, args: Args): Promise<unknown> {
  const now = service.store.now()
  switch (method) {
    case 'models.registry': {
      only(args, method, ['provider', 'model', 'status', 'changesSince', 'limit'])
      const filter = { ...(typeof args.provider === 'string' ? { provider: args.provider } : {}), ...(typeof args.model === 'string' ? { model: args.model } : {}),
        ...(typeof args.status === 'string' ? { status: args.status as 'unproven' } : {}), includeRetired: args.status === 'retired', limit: limitOf(args.limit, 100, 2_000) }
      const records = service.registry.list(filter)
      return { observedAt: now.toISOString(), count: records.length, records, ...(args.changesSince !== undefined ? { changes: service.registry.changes({ since: since(args.changesSince, 0, now), limit: 500 }) } : {}) }
    }
    case 'models.route': {
      only(args, method, ['prompt', 'features', 'constraints'])
      const features = routeFeatures(args, caller.projectId)
      return service.route(features, routeConstraints(args.constraints), caller.live, { requester: 'models.route', projectId: caller.projectId, agentSessionId: caller.agentSessionId })
    }
    case 'decisions.list': {
      only(args, method, ['kind', 'since', 'limit'])
      if (args.kind !== undefined && !KINDS.includes(args.kind as DecisionKind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`)
      const decisions = service.store.decisions({ ...(args.kind ? { kind: args.kind as DecisionKind } : {}), since: since(args.since, 30, now), limit: limitOf(args.limit, 50, 200) })
        .filter(record => record.projectId === null || record.projectId === caller.projectId || caller.sovereign)
        .map(record => ({ id: record.id, kind: record.kind, requester: record.requester, at: record.at, question: record.question, choice: record.choice, confidence: record.confidence, decidedBy: record.decidedBy, escalated: record.escalated, escalationReason: record.escalationReason, systemOne: systemOneOf(record), outcome: record.outcome }))
      return { decisions, boundaries: (args.kind ? [args.kind as DecisionKind] : KINDS).map(kind => boundary(service, kind, now)) }
    }
    case 'decisions.live': {
      only(args, method, ['kind', 'live'])
      if (!caller.sovereign) throw new Error('Only the owner or a wizard tab may switch a decision boundary live or back to shadow')
      if (!KINDS.includes(args.kind as DecisionKind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`)
      if (typeof args.live !== 'boolean') throw new Error('live must be true or false')
      const kind = args.kind as DecisionKind, current = boundary(service, kind, now)
      if (args.live && (current.cases < GO_LIVE.cases || current.agreement === null || current.agreement < GO_LIVE.agreement))
        throw new Error(`${kind} stays in shadow: its local verdict agreed on ${current.agreement === null ? 'no' : `${Math.round(current.agreement * 1000) / 10}% of`} ${current.cases} case${current.cases === 1 ? '' : 's'} in ${GO_LIVE.windowDays} days; going live needs at least ${GO_LIVE.agreement * 100}% over ${GO_LIVE.cases} or more`)
      service.decisions.setThresholds(kind, { mode: args.live ? 'live' : 'shadow' })
      return { ...boundary(service, kind, now), previous: current.live }
    }
    case 'decisions.get': {
      only(args, method, ['decisionId'])
      const record = service.store.decision(id(args, 'decisionId'))
      if (!record || record.projectId !== null && record.projectId !== caller.projectId && !caller.sovereign) throw new Error('No decision with that id in this project; see decisions.list')
      return { decision: record, explanation: explainDecision(record), outcomes: service.store.outcomesForDecision(record.id, 20) }
    }
    case 'models.refresh': {
      only(args, method, ['sources'])
      if (caller.readOnly && !caller.sovereign) throw new Error('A sandboxed local model or a read-only conversation cannot refresh the model registry')
      const sources = args.sources === undefined ? undefined : Array.isArray(args.sources) && args.sources.every(source => INGESTION_SOURCES.includes(source as IngestionSourceName)) ? args.sources as IngestionSourceName[] : null
      if (sources === null) throw new Error(`sources must be a list of ${INGESTION_SOURCES.join(', ')}`)
      const result = await service.refresh(sources)
      return { results: result.results.map(entry => ({ ...entry, changes: entry.changes.length })), changes: result.changes.slice(0, 200), totalChanges: result.changes.length }
    }
    case 'models.outcome': return recordOwnerOutcome(service, caller, args)
    case 'models.evaluate': {
      if (args.runId !== undefined) {
        only(args, method, ['runId'])
        const handle = service.evaluation(id(args, 'runId'))
        if (!handle) throw new Error('No evaluation with that runId in this Conductor run')
        return handle
      }
      only(args, method, ['provider', 'model', 'suite', 'maxJobs'])
      const key = keyArgs(args)
      if (key.provider !== 'local' && !caller.sovereign) throw new Error('Evaluating a cloud model spends the owner’s money: only the owner or a wizard tab may start it')
      if (caller.readOnly && !caller.sovereign) throw new Error('A sandboxed local model or a read-only conversation cannot start an evaluation')
      if (args.suite !== undefined && typeof args.suite !== 'string') throw new Error('suite must be a suite name')
      if (args.maxJobs !== undefined && (!Number.isInteger(args.maxJobs) || (args.maxJobs as number) < 1)) throw new Error('maxJobs must be a positive whole number')
      const handle = await service.startEvaluation(key, args.suite as string | undefined, args.maxJobs ? { maxJobs: args.maxJobs as number } : {})
      return { ...handle, note: 'Runs in the background; poll models.evaluate({runId}). Results feed reputation only.' }
    }
  }
  throw new Error('Unknown control method; use tools.list')
}

/** models.outcome: an owner's (or controller's) verdict on a decision or an execution. It amends
 *  the linked execution outcomes rather than adding a second one, so one turn never counts twice. */
function recordOwnerOutcome(service: ModelIntelligence, caller: ModelControlCaller, args: Args): unknown {
  only(args, 'models.outcome', ['decisionId', 'outcomeId', 'result', 'ownerCorrected', 'falseCompletion', 'detail'])
  if ((args.decisionId === undefined) === (args.outcomeId === undefined)) throw new Error('Name exactly one of decisionId or outcomeId')
  if (!RESULTS.includes(args.result as OutcomeResult)) throw new Error(`result must be one of ${RESULTS.join(', ')}`)
  for (const flag of ['ownerCorrected', 'falseCompletion'] as const) if (args[flag] !== undefined && typeof args[flag] !== 'boolean') throw new Error(`${flag} must be true or false`)
  if (args.detail !== undefined && (typeof args.detail !== 'string' || args.detail.length > 500)) throw new Error('detail must be text of at most 500 characters')
  if (caller.readOnly && !caller.sovereign) throw new Error('A sandboxed local model or a read-only conversation cannot record outcomes')
  const result = args.result as OutcomeResult, at = service.store.now().toISOString()
  const patch = { result, ...(args.ownerCorrected !== undefined ? { ownerCorrected: args.ownerCorrected as boolean } : {}), ...(args.falseCompletion !== undefined ? { falseCompletion: args.falseCompletion as boolean } : {}), ...(args.detail ? { detail: args.detail as string } : {}) }
  const allowed = (owner: string | null | undefined): boolean => caller.sovereign || Boolean(owner && (owner === caller.agentSessionId || caller.controls(owner)))

  if (args.outcomeId !== undefined) {
    const current = service.store.outcome(id(args, 'outcomeId'))
    if (!current || current.projectId !== null && current.projectId !== caller.projectId && !caller.sovereign) throw new Error('No outcome with that id in this project')
    const decision = current.decisionId ? service.store.decision(current.decisionId) : null
    if (!allowed(current.agentSessionId) && !allowed(decision?.agentSessionId)) throw new Error('Only the owner, a wizard tab, or the conversation that ran or dispatched this work may record its outcome')
    const amended = service.store.amendOutcome(current.id, patch)!
    service.reputation.outcomeRecorded(amended)
    if (decision) service.store.updateDecisionOutcome(decision.id, { result, at, ...(args.detail ? { detail: args.detail as string } : {}) })
    return { outcome: amended, decisionId: decision?.id ?? null }
  }
  const decision = service.store.decision(id(args, 'decisionId'))
  if (!decision || decision.projectId !== null && decision.projectId !== caller.projectId && !caller.sovereign) throw new Error('No decision with that id in this project; see decisions.list')
  if (!allowed(decision.agentSessionId)) throw new Error('Only the owner, a wizard tab, or the conversation that asked for this decision may record its outcome')
  const updated = service.store.updateDecisionOutcome(decision.id, { result, at, ...(args.detail ? { detail: args.detail as string } : {}) })
  const linked = service.store.outcomesForDecision(decision.id, 20)
  const amended = linked.map(row => service.store.amendOutcome(row.id, patch)!).filter(Boolean)
  for (const row of amended) service.reputation.outcomeRecorded(row)
  // Nothing ran under this decision yet (a dry route, or an agent whose turn never settled):
  // the verdict is recorded against the model it chose, as the owner's own outcome.
  const key = decisionKey(decision)
  const own = !linked.length && key ? service.recordOutcome(outcomeRow({
    key, source: 'owner', ref: `decision:${decision.id}`, category: categoryOf(decision), at, result, decisionId: decision.id,
    projectId: decision.projectId, agentSessionId: decision.agentSessionId, ownerCorrected: patch.ownerCorrected ?? false, falseCompletion: patch.falseCompletion ?? false,
    ...(patch.detail ? { detail: patch.detail } : {})
  })) : null
  return { decision: updated, amended: amended.map(row => row.id), recorded: own?.id ?? null, ...(!linked.length && !key ? { note: 'This decision chose no model, so only the decision records the outcome' } : {}) }
}

/** Go-live evidence for one decision kind: how often its local verdict matched the reviewer or owner. */
function boundary(service: ModelIntelligence, kind: DecisionKind, now: Date): { kind: DecisionKind; cases: number; agreement: number | null; live: boolean } {
  const measured = service.store.approvalAgreement({ kind, since: new Date(now.getTime() - GO_LIVE.windowDays * DAY_MS).toISOString() })
  return { kind, cases: measured.cases, agreement: measured.cases ? measured.rate : null, live: service.decisions.thresholds(kind).mode === 'live' }
}

const categoryOf = (decision: { state: Record<string, unknown> }): ReturnType<typeof categorize>['category'] => {
  const features = decision.state.features as { category?: unknown } | undefined
  return typeof features?.category === 'string' ? features.category as ReturnType<typeof categorize>['category'] : 'general'
}
