/**
 * The seams the durable-job controller consumes. Each port has a plain default so the store,
 * controller and reconciliation run and test standalone; the real implementations are owned
 * elsewhere and plugged in by index.ts:
 *   - HandoffPort: src/main/durable-jobs/handoff.ts (Opus B)
 *   - WatchdogPort, ServerLifecyclePort, LoopGuardPort: watchdog.ts, server-lifecycle.ts,
 *     loop-guard.ts (Opus C)
 *   - ReportPort: report.ts (Opus D)
 *   - StageRuntime: structured-runtime.ts (this module, over src/main/structured-sessions.ts)
 * A port never writes to the job store; it returns decisions and the controller persists them
 * under its lease.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionPhase } from '../../shared/structured-agent'
import type { LocalStopReason } from '../../shared/local-stop'
import type { DurableJob, DurableJobCheckpoint, DurableJobEvent, DurableJobHandoff, DurableJobOperation, DurableJobReport, DurableJobStage } from '../../shared/durable-jobs'

/** A planned stage the controller may append (same shape as CreateDurableJobInput.stages). */
export type DurableStagePlan = Pick<DurableJobStage, 'title' | 'objective' | 'completionCriteria'> & { inputs?: DurableJobStage['inputs'] }

/** What the controller read back from a stage conversation, from durable state only. */
export interface StageObservation {
  /** 'missing' when the conversation no longer exists in the structured store. */
  phase: SessionPhase | 'missing'
  /** Sequence of the newest local stop report on the timeline; 0 when none. */
  stopSequence: number
  stop?: { reason: LocalStopReason; detail: string; filesChanged: string[]; acceptance?: { command: string; passed: boolean; exitCode: number } }
  /** The last assistant answer text (may be empty or truncated; never proof of success alone). */
  lastAnswer: string
  lastError?: string
  filesChanged: string[]
  /** The local task checkpoint's ExecutionState, when the conversation kept one. */
  execution?: LocalExecutionView
}

/** The part of the local session checkpoint (agent.ts ExecutionState) the controller relies on. */
export interface LocalExecutionView {
  lifecycle: 'running' | 'recovering' | 'completed' | 'blocked' | 'failed' | 'cancelled'
  nextAction: string
  /** A tool call whose result was never saved: its side effect is unknown and it is never replayed. */
  pending?: { id: string; name: string; arguments: string }
}

export interface OpenStageRequest {
  job: DurableJob
  stage: DurableJobStage
  title: string
}

/** The structured runtime as the controller sees it: one fresh local conversation per attempt. */
export interface StageRuntime {
  open(request: OpenStageRequest): Promise<{ agentSessionId: string }>
  submit(agentSessionId: string, prompt: string): Promise<void>
  observe(agentSessionId: string): StageObservation
  interrupt(agentSessionId: string): Promise<void>
}

export interface StagePromptInput {
  job: DurableJob
  stage: DurableJobStage
  stages: DurableJobStage[]
  handoff: DurableJobHandoff
  /** Why this attempt exists when it is a retry (previous error), else undefined. */
  retryOf?: string
}

export interface StageResultInput {
  job: DurableJob
  stage: DurableJobStage
  stages: DurableJobStage[]
  observation: StageObservation
  /** True when the stage met the controller's success test (see controller.ts stageSucceeded). */
  succeeded: boolean
}

export interface StageResultDecision {
  handoff: DurableJobHandoff
  /** The model reported the whole objective done. Planned stages still run first. */
  jobDone: boolean
  /** A further stage to append when no planned stage remains. */
  nextStage?: DurableStagePlan
  /** Short factual result for DurableJobStage.result. */
  result: string
}

/** Opus B: context budgeting, next-stage prompt and handoff extraction. */
export interface HandoffPort {
  stagePrompt(input: StagePromptInput): string
  afterStage(input: StageResultInput): StageResultDecision
}

export interface WatchContext { job: DurableJob; stage: DurableJobStage; agentSessionId: string }
/** Opus C: bounded waits inside a stage. onStuck makes the controller interrupt the attempt. */
export interface WatchdogPort {
  watch(context: WatchContext, onStuck: (reason: string) => void): { dispose(): void }
}

export type ServerReadiness = { ready: true } | { ready: false; reason: string; retryable: boolean }
/** Opus C: the one llama-server this machine can carry. */
export interface ServerLifecyclePort {
  ensureReady(model: string): Promise<ServerReadiness>
  /** Called after a provider_error stop; true when the server was restarted and a retry makes sense. */
  recover(model: string, reason: string): Promise<boolean>
}

export type LoopAssessment = { loop: false } | { loop: true; detail: string }
/** Opus C: detects a stage repeating without progress across attempts. */
export interface LoopGuardPort {
  /** `error` is this attempt's failure as recorded; `previousErrors` the stage's earlier ones, oldest first. */
  assess(input: { job: DurableJob; stage: DurableJobStage; stages: DurableJobStage[]; observation: StageObservation; error: string; previousErrors: string[] }): LoopAssessment
}

export interface ReportInput {
  job: DurableJob
  stages: DurableJobStage[]
  events: DurableJobEvent[]
  checkpoints: DurableJobCheckpoint[]
  operations: DurableJobOperation[]
  now: Date
}
/** Opus D: the final report file. */
export interface ReportPort {
  write(input: ReportInput): Promise<DurableJobReport & { reportPath: string }>
}

export const JOB_STATUS_DONE = 'JOB STATUS: DONE'
export const JOB_STATUS_CONTINUE = 'JOB STATUS: CONTINUE'

const bullet = (title: string, items: string[]): string => items.length ? `${title}:\n${items.map(item => `- ${item}`).join('\n')}\n` : ''

/** Plain default until handoff.ts lands: renders the persisted handoff as text and asks the
 *  model to close with an explicit status line the default afterStage parses. */
export const defaultHandoffPort: HandoffPort = {
  stagePrompt({ job, stage, stages, handoff, retryOf }) {
    const planned = stages.filter(candidate => candidate.status === 'pending' || candidate.status === 'running').length
    return [
      `You are working on a durable job: ${job.title}.`,
      `Overall objective: ${handoff.objective || job.objective}`,
      '',
      `This is stage ${stage.index + 1}${planned > 1 ? ` (${planned - 1} more planned)` : ''}: ${stage.title}`,
      `Stage objective: ${stage.objective}`,
      bullet('Completion criteria', stage.completionCriteria),
      bullet('Constraints', handoff.constraints),
      bullet('Decisions so far', handoff.decisions),
      bullet('Work already done', handoff.workDone),
      bullet('Files already changed', handoff.filesChanged),
      bullet('Test results', handoff.testResults),
      bullet('Unresolved issues', handoff.unresolvedIssues),
      handoff.nextAction ? `Next action from the previous stage: ${handoff.nextAction}\n` : '',
      bullet('Artifacts you may read selectively', handoff.artifacts.map(ref => `${ref.path} (${ref.kind}${ref.range ? `, lines ${ref.range.from}-${ref.range.to}` : ''})`)),
      retryOf ? `The previous attempt at this stage did not finish: ${retryOf}\nDo not repeat what failed; inspect the current files first.\n` : '',
      'Work only on this stage. Verify your work with the tools before claiming it is done.',
      `End your final answer with one line: "${JOB_STATUS_DONE}" when the overall objective is fully met, or "${JOB_STATUS_CONTINUE}: <the concrete next action>" when more work remains.`
    ].filter(Boolean).join('\n')
  },
  afterStage({ job, stage, stages, observation, succeeded }) {
    const answer = observation.lastAnswer.trim()
    const continued = new RegExp(`${JOB_STATUS_CONTINUE}\\s*:?\\s*(.+)$`, 'im').exec(answer)
    const done = answer.includes(JOB_STATUS_DONE)
    const explicitPlan = stages.some(candidate => candidate.index > stage.index)
    const nextAction = continued?.[1]?.trim() || observation.execution?.nextAction || ''
    const result = answer.replace(new RegExp(`^.*(${JOB_STATUS_DONE}|${JOB_STATUS_CONTINUE}).*$`, 'gim'), '').trim().slice(0, 1_200)
    const handoff: DurableJobHandoff = {
      ...job.handoff,
      workDone: succeeded ? [...job.handoff.workDone, `${stage.title}: ${result.split('\n')[0]?.slice(0, 300) ?? ''}`].slice(-40) : job.handoff.workDone,
      filesChanged: [...new Set([...job.handoff.filesChanged, ...observation.filesChanged])].slice(-400),
      unresolvedIssues: succeeded ? job.handoff.unresolvedIssues : [...job.handoff.unresolvedIssues, `${stage.title}: ${observation.stop?.detail ?? observation.lastError ?? 'stage did not finish'}`].slice(-20),
      nextAction,
      updatedAt: new Date().toISOString()
    }
    return {
      handoff, result,
      // No status line is neither done nor a plan: the controller finishes an owner-planned job
      // after its last stage and blocks an open-ended one instead of guessing.
      jobDone: done,
      nextStage: continued && !done && !explicitPlan ? { title: `Stage ${stages.length + 1}`, objective: continued[1]!.trim(), completionCriteria: [] } : undefined
    }
  }
}

export const noopWatchdog: WatchdogPort = { watch: () => ({ dispose() { /* nothing to stop */ } }) }
export const alwaysReadyServer: ServerLifecyclePort = { ensureReady: async () => ({ ready: true }), recover: async () => false }

/** Default loop guard: the same error three attempts running is a loop. */
export const repeatedErrorLoopGuard: LoopGuardPort = {
  assess({ error, previousErrors }) {
    if (!error || previousErrors.length < 2) return { loop: false }
    return previousErrors.slice(-2).every(previous => previous === error) ? { loop: true, detail: `The same failure repeated on three attempts: ${error.slice(0, 300)}` } : { loop: false }
  }
}

/** Default report: facts straight from the store, written as JSON into the job's logDir. */
export const jsonReportPort: ReportPort = {
  async write({ job, stages, events, checkpoints, now }) {
    const elapsedMs = job.startedAt ? (job.finishedAt ? Date.parse(job.finishedAt) : now.getTime()) - Date.parse(job.startedAt) : 0
    const report: DurableJobReport = {
      jobId: job.id, status: job.status, elapsedMs, activeMs: job.activeMs,
      modelsByStage: stages.map(stage => ({ stage: stage.title, model: stage.model ?? job.model.model, attempts: stage.attempt })),
      filesChanged: job.handoff.filesChanged,
      results: stages.filter(stage => stage.result).map(stage => `${stage.title}: ${stage.result}`),
      tests: job.handoff.testResults.map(command => ({ command, outcome: 'not-run' as const })),
      checkpoints: checkpoints.map(checkpoint => ({ id: checkpoint.id, createdAt: checkpoint.createdAt, commit: checkpoint.commit, reason: checkpoint.reason })),
      recoveries: events.filter(event => event.kind === 'recovery').map(event => ({ at: event.at, message: event.message })),
      remainingWork: [...stages.filter(stage => stage.status === 'pending' || stage.status === 'running' || stage.status === 'failed').map(stage => stage.objective), ...(job.handoff.nextAction ? [job.handoff.nextAction] : [])],
      cloudEscalation: { occurred: job.counters.cloudEscalations > 0 },
      logPaths: [job.logDir],
      generatedAt: now.toISOString()
    }
    await mkdir(job.logDir, { recursive: true })
    const reportPath = join(job.logDir, 'report.json')
    await writeFile(reportPath, JSON.stringify(report, null, 2))
    return { ...report, reportPath }
  }
}
