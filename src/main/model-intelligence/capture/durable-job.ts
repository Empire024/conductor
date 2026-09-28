/**
 * A durable-job stage attempt settled → ExecutionOutcome. Pure. The caller is the job controller's
 * stage settlement (controller.ts, after `handoff.afterStage`); it passes the job, the stage as it
 * ran, the StageObservation, whether the controller counted it a success (completed stop report
 * AND completion criteria met), and optionally the job counters from before the stage so the
 * per-stage deltas (recoveries, loops, rollovers) are exact. Each attempt is its own outcome.
 */
import type { DurableJob, DurableJobStage, DurableStageKind } from '../../../shared/durable-jobs'
import type { ExecutionOutcome, TaskCategory } from '../../../shared/model-routing'
import type { StageObservation } from '../../durable-jobs/ports'
import { classifyStageOutcome } from '../../durable-jobs/handoff'
import { categorize } from '../categorize'
import { clip, localKey, outcome } from './common'

export interface SettledStage {
  job: Pick<DurableJob, 'id' | 'projectId' | 'model' | 'counters'>
  stage: Pick<DurableJobStage, 'id' | 'index' | 'title' | 'kind' | 'objective' | 'attempt' | 'agentSessionId' | 'model' | 'startedAt' | 'completedAt' | 'error'>
  observation: Pick<StageObservation, 'phase' | 'stop' | 'report' | 'lastAnswer' | 'lastError' | 'filesChanged'>
  /** The controller's verdict (stop report and completion criteria). Absent: classifyStageOutcome. */
  succeeded?: boolean
  /** The unmet completion-criteria message, when that is what failed a completed stop. */
  criteriaFailure?: string
  countersBefore?: DurableJob['counters']
  /** The job was cancelled or paused under the stage (wait.interruptedFor). */
  interrupted?: boolean
  category?: TaskCategory
  decisionId?: string | null
  at?: string
}

const KIND_CATEGORY: Partial<Record<DurableStageKind, TaskCategory>> = { plan: 'architecture', verify: 'review', research: 'research', report: 'summarization' }

function stageCategory(stage: SettledStage['stage']): TaskCategory {
  const mapped = stage.kind && KIND_CATEGORY[stage.kind]
  if (mapped) return mapped
  const guessed = categorize({ prompt: `${stage.title}\n${stage.objective}` }).category
  return guessed !== 'general' ? guessed : stage.kind === 'investigate' ? 'debugging' : stage.kind === 'implement' ? 'difficult-coding' : 'general'
}

export function captureDurableStage(settled: SettledStage): ExecutionOutcome | null {
  const { job, stage, observation } = settled
  if (observation.phase === 'missing' && !observation.stop) return null
  const reason = observation.report?.reason ?? observation.stop?.reason
  const classification = classifyStageOutcome({ text: observation.lastAnswer ?? '', stopReason: reason, report: observation.report ?? observation.stop })
  const succeeded = settled.succeeded ?? classification.success
  const acceptance = observation.stop?.acceptance ?? observation.report?.acceptance
  const delta = (field: keyof DurableJob['counters']): number => settled.countersBefore ? Math.max(0, job.counters[field] - settled.countersBefore[field]) : 0
  const started = stage.startedAt ? Date.parse(stage.startedAt) : NaN, at = settled.at ?? stage.completedAt ?? new Date().toISOString()
  const task = observation.report?.task
  const cancelled = settled.interrupted || reason === 'interrupted'
  // A completed stop that failed its criteria or its acceptance command claimed a finish it had not reached.
  const falseCompletion = !succeeded && reason === 'completed' && (Boolean(settled.criteriaFailure) || acceptance?.passed === false) || reason === 'unverified_claim'
  return outcome({
    key: localKey(stage.model ?? job.model.model), source: 'durable-job', ref: `${job.id}:${stage.id}:${stage.attempt}`,
    category: settled.category ?? stageCategory(stage), complexity: null, projectId: job.projectId, agentSessionId: stage.agentSessionId ?? null, decisionId: settled.decisionId ?? null, at,
    result: cancelled ? 'cancelled' : succeeded ? 'success' : observation.filesChanged.length ? 'partial' : 'failure',
    verifier: acceptance ? (acceptance.passed ? 'pass' : 'fail') : settled.criteriaFailure ? 'fail' : 'none',
    durationMs: task?.elapsedMs ?? (Number.isFinite(started) && Number.isFinite(Date.parse(at)) ? Math.max(0, Date.parse(at) - started) : null),
    tokens: task?.tokens ?? null, retries: Math.max(0, stage.attempt - 1) + delta('recoveries'), iterations: observation.report?.rounds ?? null,
    contextFailure: reason === 'context_limit' || delta('contextRollovers') > 0,
    looped: reason === 'stagnation' || reason === 'output_budget_loop' || delta('loopsDetected') > 0,
    timedOut: reason === 'round_limit', overBudget: reason === 'round_limit',
    invalidOutput: reason === 'empty_answer' || reason === 'output_limit' || reason === 'output_budget_loop' || (reason === 'completed' && !classification.success),
    falseCompletion, escalated: delta('cloudEscalations') > 0,
    ...(!succeeded ? { detail: clip(settled.criteriaFailure ?? observation.lastError ?? stage.error ?? classification.reason) } : {}),
  })
}
