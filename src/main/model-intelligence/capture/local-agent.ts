/**
 * A local agent turn stopped (LocalTelemetryEntry `stop`) → ExecutionOutcome. Pure. The caller
 * (module E, beside the local runtime's telemetry sink) passes the stop entry, or the turn's whole
 * telemetry stream so failed tool-grammar repairs count as tool failures, plus the model and ref.
 * Stop reasons map onto behaviour: stagnation → looped, context_limit → contextFailure,
 * round_limit → timedOut, empty/truncated output → invalidOutput, unverified_claim → falseCompletion.
 */
import type { ExecutionOutcome, TaskCategory, TaskFeatures } from '../../../shared/model-routing'
import type { LocalStopReason, LocalStopReport } from '../../../shared/local-stop'
import type { LocalTelemetryEntry } from '../../local-models/agent'
import { categorize } from '../categorize'
import { clip, localKey, outcome, TIMEOUT } from './common'

export interface LocalAgentStop {
  /** The `stop` entry, or every entry of the turn (the last `stop` is used). */
  telemetry: LocalTelemetryEntry | LocalTelemetryEntry[]
  /** Local model id, bare or `local/<id>`. */
  model: string
  /** The turn's stable reference: task id, or agent session id plus turn id. */
  ref: string
  agentSessionId?: string | null
  projectId?: string | null
  prompt?: string
  features?: TaskFeatures
  category?: TaskCategory
  decisionId?: string | null
  at?: string
}

const FAILURE: Record<LocalStopReason, Partial<ExecutionOutcome>> = {
  completed: {}, interrupted: {},
  round_limit: { timedOut: true, overBudget: true },
  stagnation: { looped: true },
  context_limit: { contextFailure: true },
  output_limit: { invalidOutput: true },
  output_budget_loop: { looped: true, invalidOutput: true },
  unverified_claim: { falseCompletion: true },
  provider_error: {},
  empty_answer: { invalidOutput: true },
}

export function captureLocalAgentStop(stop: LocalAgentStop): ExecutionOutcome | null {
  const entries = Array.isArray(stop.telemetry) ? stop.telemetry : [stop.telemetry]
  const report: LocalStopReport | undefined = entries.flatMap(entry => entry.kind === 'stop' ? [entry.report] : []).at(-1)
  if (!report) return null
  const features = stop.features ?? (stop.category ? { ...categorize({ prompt: stop.prompt ?? '' }), category: stop.category } : categorize({ prompt: stop.prompt ?? '' }))
  const acceptance = report.acceptance ?? entries.flatMap(entry => entry.kind === 'acceptance' ? [{ passed: entry.passed }] : []).at(-1)
  const reason = report.reason
  const failedAcceptance = reason === 'completed' && acceptance?.passed === false
  return outcome({
    key: localKey(stop.model), source: 'local-agent', ref: stop.ref,
    category: features.category, complexity: features.complexity, projectId: stop.projectId ?? null, agentSessionId: stop.agentSessionId ?? null, decisionId: stop.decisionId ?? null,
    at: stop.at ?? new Date().toISOString(),
    result: reason === 'interrupted' ? 'cancelled' : reason === 'completed' ? (failedAcceptance ? 'failure' : 'success') : report.filesChanged.length && reason !== 'unverified_claim' ? 'partial' : 'failure',
    verifier: acceptance ? (acceptance.passed ? 'pass' : 'fail') : 'none',
    durationMs: report.task?.elapsedMs ?? null, tokens: report.task?.tokens ?? null, retries: report.task?.recoveries ?? 0, iterations: report.rounds,
    toolFailures: entries.filter(entry => entry.kind === 'repair' && entry.outcome === 'failed').length,
    ...FAILURE[reason],
    ...(reason === 'provider_error' && TIMEOUT.test(report.detail) ? { timedOut: true } : {}),
    ...(failedAcceptance ? { falseCompletion: true } : {}),
    ...(reason !== 'completed' || failedAcceptance ? { detail: clip(`${reason}: ${report.detail}`) } : {}),
  })
}
