import { join } from 'node:path'
import { makeId } from '../../shared/models'
import type { DurableJob, DurableJobOperation, DurableJobStage } from '../../shared/durable-jobs'
import type { HandoffPort, LoopGuardPort, ServerLifecyclePort, StageObservation, StageRuntime, WatchdogPort } from './ports'
import { StaleEpochError, type DurableJobStore, type StoredJob, type WriteGuard } from './store'
import type { WorktreeOps } from './worktree'

/**
 * Runs durable jobs in the main process. A job is a sequence of stages; every attempt at a stage
 * is a FRESH local-model conversation opened through the structured runtime (StageRuntime) and
 * rebuilt only from the persisted handoff, never from an earlier transcript. Nothing here depends
 * on a renderer: the conversation may be shown as a tab, but closing that tab, reloading the
 * window or splitting panes only changes the view; the controller polls the durable session
 * projection and the local task checkpoint, not UI state.
 *
 * Ownership: a running job is driven by exactly one loop holding the job's lease epoch. Every
 * write goes through the store with that epoch; the moment the owner pauses or cancels, or a
 * restart reconciles the job, the epoch moves on and the old loop's next write throws
 * StaleEpochError, which ends the loop without touching the job again.
 *
 * Model policy: the provider stays 'local' and the model stays the one the job was created with,
 * for every stage and every retry. There is no automatic cloud escalation; counters.cloudEscalations
 * only counts an explicit owner handoff, which is not implemented yet.
 */

export interface ControllerOptions {
  store: DurableJobStore
  runtime: StageRuntime
  handoff: HandoffPort
  watchdog: WatchdogPort
  server: ServerLifecyclePort
  loopGuard: LoopGuardPort
  worktrees: WorktreeOps
  /** This app process: `${pid}:${launchId}`. */
  ownerId: string
  clock?: () => Date
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  leaseTtlMs?: number
  /** Jobs started from the queue at once. One llama-server fits this machine, so 1. */
  maxConcurrent?: number
  /** Ceiling on stages a job may append for itself (an owner-planned job has its own plan). */
  maxImplicitStages?: number
  /** How long an interrupted conversation may take to settle before it is abandoned. */
  interruptGraceMs?: number
  serverRetries?: number
  serverRetryMs?: number
  /** A job reached a terminal status (the service writes its report). */
  finished?: (jobId: string) => void
}

interface Run {
  jobId: string
  epoch: number
  stop: boolean
  agentSessionId?: string
  renew?: NodeJS.Timeout
  done: Promise<void>
}

type Wait =
  | { kind: 'settled'; observation: StageObservation; interruptedFor?: string }
  | { kind: 'needs-owner'; observation: StageObservation }
  | { kind: 'stale' }

const ACTIVE = new Set<string>(['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'])
const NEEDS_OWNER = new Set<string>(['waiting_approval', 'waiting_input'])

/** The controller's success test: the model's own final answer, no truncation, no pending or
 *  failed task state. An empty or cut-off answer is never a completed stage. */
export function stageSucceeded(observation: StageObservation): boolean {
  if (observation.phase !== 'completed') return false
  if (observation.stop?.reason !== 'completed') return false
  if (!observation.lastAnswer.trim()) return false
  if (observation.stop.acceptance && !observation.stop.acceptance.passed) return false
  if (observation.execution?.pending) return false
  return !observation.execution || observation.execution.lifecycle === 'completed'
}

export function describeFailure(observation: StageObservation, interruptedFor?: string): string {
  if (interruptedFor) return interruptedFor
  if (observation.phase === 'missing') return 'The stage conversation no longer exists.'
  if (observation.stop && observation.stop.reason !== 'completed') return `${observation.stop.reason}: ${observation.stop.detail}`
  if (observation.lastError) return observation.lastError
  if (observation.stop?.acceptance && !observation.stop.acceptance.passed) return `Acceptance command failed: ${observation.stop.acceptance.command} (exit ${observation.stop.acceptance.exitCode})`
  if (observation.execution && observation.execution.lifecycle !== 'completed') return `Local task ended ${observation.execution.lifecycle}: ${observation.execution.nextAction}`
  if (!observation.lastAnswer.trim()) return 'The stage produced no final answer.'
  return `The stage conversation ended ${observation.phase}.`
}

/** Tool names from the local runtime mapped to the ledger's side-effect kinds. */
export function operationKindForTool(name: string): DurableJobOperation['kind'] {
  if (/git/i.test(name)) return 'git'
  if (/test/i.test(name)) return 'test'
  if (/command|shell|exec|run|process_files/i.test(name)) return 'shell'
  if (/write|edit|patch|replace|create|delete|move|rename/i.test(name)) return 'file-write'
  return 'other'
}

export class DurableJobController {
  private readonly runs = new Map<string, Run>()
  /** Stage conversations a restart cut off; their persisted phase may still read as active. */
  private readonly lost = new Set<string>()
  private slot: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly clock: () => Date
  private readonly sleep: (ms: number) => Promise<void>
  private readonly pollMs: number
  private readonly leaseTtlMs: number

  constructor(private readonly options: ControllerOptions) {
    this.clock = options.clock ?? (() => new Date())
    this.sleep = options.sleep ?? (ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() }))
    this.pollMs = options.pollMs ?? 2_000
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000
  }

  private get store(): DurableJobStore { return this.options.store }

  isRunning(jobId: string): boolean { return this.runs.has(jobId) }
  /** Resolves when the job's loop (if any) has exited. */
  idle(jobId: string): Promise<void> { return this.runs.get(jobId)?.done ?? Promise.resolve() }
  markLost(agentSessionIds: Iterable<string>): void { for (const id of agentSessionIds) this.lost.add(id) }

  /** Starts queued jobs, oldest first, while there is room. */
  schedule(): void {
    if (this.disposed) return
    const limit = this.options.maxConcurrent ?? 1
    const queued = this.store.list({ status: ['queued'] }).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const job of queued) {
      if (this.runs.size >= limit) return
      this.start(job.id, 'Started from the queue')
    }
  }

  /** Takes the lease and runs the job. Valid from queued, paused, blocked and recovering. */
  start(jobId: string, reason: string): void {
    if (this.disposed || this.runs.has(jobId)) return
    const lease = this.store.acquire(jobId, this.options.ownerId, this.leaseTtlMs, { takeover: true, reason })
    const guard = { epoch: lease.epoch }
    try { this.store.transition(jobId, 'running', reason, guard) }
    catch (error) { this.store.release(jobId, guard); throw error }
    const run: Run = { jobId, epoch: lease.epoch, stop: false, done: Promise.resolve() }
    run.renew = setInterval(() => {
      try { this.store.renew(jobId, run.epoch, this.leaseTtlMs) }
      catch { run.stop = true }
    }, Math.max(1_000, Math.floor(this.leaseTtlMs / 3)))
    run.renew.unref?.()
    this.runs.set(jobId, run)
    run.done = this.loop(run)
      .catch(error => {
        if (error instanceof StaleEpochError) return
        console.error(`Durable job ${jobId} controller failed`, error)
        // An unexpected fault blocks the job with its reason rather than failing it: the owner
        // decides whether the work is lost.
        try { this.block(run, `Controller error: ${error instanceof Error ? error.message : String(error)}`, 'Read the job events and log, then resume or cancel the job.') } catch { /* superseded meanwhile */ }
      })
      .finally(() => {
        clearInterval(run.renew)
        if (this.runs.get(jobId) === run) this.runs.delete(jobId)
        this.schedule()
      })
  }

  /** Stops driving the job in this process (owner pause/cancel, or app quit). Does not write. */
  async detach(jobId: string, interrupt: boolean): Promise<void> {
    const run = this.runs.get(jobId)
    if (!run) return
    run.stop = true
    if (interrupt && run.agentSessionId) await this.options.runtime.interrupt(run.agentSessionId).catch(error => console.warn(`Durable job ${jobId}: interrupt failed`, error))
  }

  /**
   * App quit: loops stop and nothing is written, so the jobs stay `running` in the database and
   * the next launch reconciles them (reconcile.ts). The stage conversations die with the process.
   */
  dispose(): void {
    this.disposed = true
    for (const run of this.runs.values()) { run.stop = true; clearInterval(run.renew) }
  }

  private guard(run: Run): WriteGuard { return { epoch: run.epoch } }

  /** The job, if this loop still owns it and it is running; undefined means stop quietly. */
  private owned(run: Run): StoredJob | undefined {
    if (run.stop || this.disposed) return undefined
    const job = this.store.get(run.jobId)
    if (job.lease?.epoch !== run.epoch || job.lease.ownerId !== this.options.ownerId || job.status !== 'running') return undefined
    return job
  }

  private block(run: Run, reason: string, nextAction: string, kind?: 'approval' | 'loop-detected' | 'server'): void {
    const guard = this.guard(run)
    this.store.batch(run.jobId, () => {
      const job = this.store.get(run.jobId)
      if (kind) this.store.event(run.jobId, guard, kind, reason)
      this.store.transition(run.jobId, 'blocked', reason, guard, { handoff: { ...job.handoff, nextAction, updatedAt: this.clock().toISOString() } }, { nextAction })
      this.store.release(run.jobId, guard)
    })
    run.stop = true
  }

  private async loop(run: Run): Promise<void> {
    while (true) {
      const job = this.owned(run)
      if (!job) return
      // The elapsed budget blocks (resumable) rather than fails: the work so far stands, and the
      // owner's resume restarts the budget from that moment (the latest 'elapsed-budget' note).
      const since = this.elapsedSince(job)
      if (job.budgets.maxElapsedMs > 0 && since !== undefined && this.clock().getTime() - since >= job.budgets.maxElapsedMs) {
        this.block(run, `Reached the job's elapsed-time budget of ${Math.round(job.budgets.maxElapsedMs / 60_000)} minutes`, job.handoff.nextAction || 'Read the report so far; resume to give the job another elapsed-time budget, or cancel it.')
        return
      }
      const stages = this.store.stages(job.id)
      const stage = stages.find(candidate => candidate.status === 'running') ?? stages.find(candidate => candidate.status === 'pending')
      if (!stage) {
        this.store.transition(job.id, 'completed', 'Every stage completed', this.guard(run))
        this.options.finished?.(job.id)
        return
      }
      if (await this.runStage(run, job, stage, stages) === 'stop') return
    }
  }

  /** Start of the current elapsed-time budget: the job's start, or the owner's latest resume. */
  private elapsedSince(job: StoredJob): number | undefined {
    if (!job.budgets.maxElapsedMs || !job.startedAt) return undefined
    const restarted = this.store.matchingEvents(job.id, { kind: 'note', dataEquals: { elapsedBudget: 'restarted' } }, 1).at(-1)
    return Date.parse(restarted?.at ?? job.startedAt)
  }

  /** One llama-server: stage attempts across jobs take turns. */
  private async withSlot<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.slot
    let release!: () => void
    this.slot = new Promise(resolve => { release = resolve })
    await previous
    try { return await work() } finally { release() }
  }

  private async runStage(run: Run, job: StoredJob, stage: DurableJobStage, stages: DurableJobStage[]): Promise<'continue' | 'stop'> {
    // An attempt already in flight: resumed after an approval block, or reconciled after a restart.
    if (stage.status === 'running' && stage.agentSessionId) {
      const observation = this.options.runtime.observe(stage.agentSessionId)
      if (ACTIVE.has(observation.phase) && !this.lost.has(stage.agentSessionId)) {
        run.agentSessionId = stage.agentSessionId
        return this.withSlot(async () => this.conclude(run, job, stage, stages, await this.wait(run, job, stage, stage.agentSessionId!, observation.stopSequence, true), false))
      }
      const lost = this.lost.has(stage.agentSessionId) || ACTIVE.has(observation.phase)
      return this.conclude(run, job, stage, stages, { kind: 'settled', observation, ...(lost && !stageSucceeded(observation) ? { interruptedFor: 'The stage conversation was cut off when Conductor stopped.' } : {}) }, false)
    }
    const allowed = job.budgets.maxStageAttempts + this.store.attemptBase(stage.id)
    if (stage.attempt >= allowed) {
      this.block(run, `Stage ${stage.index + 1} "${stage.title}" used all ${job.budgets.maxStageAttempts} attempts. Last error: ${stage.error ?? 'none recorded'}`, job.handoff.nextAction || `Look at stage ${stage.index + 1}'s last conversation, fix what stopped it, then resume the job to grant new attempts.`)
      return 'stop'
    }
    return this.withSlot(async () => {
      if (!this.owned(run)) return 'stop'
      const readiness = await this.serverReady(run, job)
      if (readiness !== 'ready') return 'stop'
      await this.checkpoint(run, stage, `Before stage ${stage.index + 1} attempt ${stage.attempt + 1}`)
      const current = this.owned(run)
      if (!current) return 'stop'
      const guard = this.guard(run)
      const previousError = stage.error
      let attempt: DurableJobStage = { ...stage, status: 'running', attempt: stage.attempt + 1, startedAt: this.clock().toISOString(), model: current.model.model, error: undefined, completedAt: undefined, agentSessionId: undefined }
      this.store.batch(job.id, () => {
        this.store.saveStage(job.id, guard, attempt, { kind: 'stage', message: `Stage ${attempt.index + 1} "${attempt.title}" attempt ${attempt.attempt} started on ${current.model.model}`, data: { attempt: attempt.attempt } })
        this.store.update(job.id, guard, { currentStageId: attempt.id })
      })
      const prompt = this.options.handoff.stagePrompt({ job: current, stage: attempt, stages: this.store.stages(job.id), handoff: current.handoff, retryOf: previousError })
      // The model call is the stage's in-flight side effect: recorded before the conversation is
      // opened, settled when it stops. A restart finds it 'intended' and reconciles it.
      const op = this.store.intend(job.id, guard, { stageId: attempt.id, kind: 'model-call', description: `Stage ${attempt.index + 1} attempt ${attempt.attempt}: fresh ${current.model.model} conversation` })
      let agentSessionId: string
      try {
        agentSessionId = (await this.options.runtime.open({ job: current, stage: attempt, title: `${current.title} · stage ${attempt.index + 1}` })).agentSessionId
      } catch (error) {
        const message = `Could not open the stage conversation: ${error instanceof Error ? error.message : String(error)}`
        this.store.settle(job.id, guard, op.id, 'failed', message)
        return this.conclude(run, current, attempt, stages, { kind: 'settled', observation: emptyObservation('missing'), interruptedFor: message }, false, op)
      }
      run.agentSessionId = agentSessionId
      attempt = this.store.saveStage(job.id, guard, { ...attempt, agentSessionId })
      const baseline = this.options.runtime.observe(agentSessionId).stopSequence
      try {
        await this.options.runtime.submit(agentSessionId, prompt)
      } catch (error) {
        const message = `The stage prompt was refused: ${error instanceof Error ? error.message : String(error)}`
        this.store.settle(job.id, guard, op.id, 'failed', message)
        return this.conclude(run, current, attempt, stages, { kind: 'settled', observation: this.options.runtime.observe(agentSessionId), interruptedFor: message }, false, op)
      }
      // Superseded while the prompt was going out: stop the conversation we just started.
      if (!this.owned(run)) { await this.options.runtime.interrupt(agentSessionId).catch(() => undefined); return 'stop' }
      return this.conclude(run, current, attempt, stages, await this.wait(run, current, attempt, agentSessionId, baseline, false), true, op)
    })
  }

  private async serverReady(run: Run, job: StoredJob): Promise<'ready' | 'blocked'> {
    const retries = this.options.serverRetries ?? 3
    for (let attempt = 0; ; attempt++) {
      const readiness = await this.options.server.ensureReady(job.model.model, { jobId: job.id, epoch: run.epoch })
      if (readiness.ready) return 'ready'
      if (!this.owned(run)) return 'blocked'
      if (!readiness.retryable || attempt >= retries) {
        this.block(run, `The local model server is not available: ${readiness.reason}`, 'Free the local model server (only one fits this machine) or fix its setup, then resume the job.', 'server')
        return 'blocked'
      }
      this.store.event(job.id, this.guard(run), 'server', `Local model server not ready (${readiness.reason}); retrying`, { attempt: attempt + 1 })
      await this.sleep(this.options.serverRetryMs ?? 30_000)
    }
  }

  /** Polls the durable session state until the attempt stops, the owner is needed, or the job
   *  is superseded. Stage timeouts and watchdog reports interrupt through the runtime. */
  private async wait(run: Run, job: StoredJob, stage: DurableJobStage, agentSessionId: string, baseline: number, reattached: boolean): Promise<Wait> {
    let sawActive = reattached, interruptedFor: string | undefined, interruptedAt = 0
    const interrupt = (reason: string): void => {
      if (interruptedFor) return
      interruptedFor = reason
      interruptedAt = this.clock().getTime()
      if (this.owned(run)) this.store.event(job.id, this.guard(run), 'retry', `Interrupting stage ${stage.index + 1}: ${reason}`, { stageId: stage.id })
      void this.options.runtime.interrupt(agentSessionId).catch(error => console.warn('Durable job interrupt failed', error))
    }
    const watch = this.options.watchdog.watch({ job, stage, agentSessionId }, reason => interrupt(`Watchdog: ${reason}`))
    try {
      // Time spent blocked on the owner before a re-attach does not count against the stage.
      const started = !reattached && stage.startedAt ? Date.parse(stage.startedAt) : this.clock().getTime()
      while (true) {
        if (!this.owned(run)) return { kind: 'stale' }
        const observation = this.options.runtime.observe(agentSessionId)
        const active = ACTIVE.has(observation.phase)
        if (active) sawActive = true
        if (NEEDS_OWNER.has(observation.phase) && !interruptedFor) return { kind: 'needs-owner', observation }
        if (!active && (sawActive || observation.stopSequence > baseline || observation.phase === 'missing')) return { kind: 'settled', observation, interruptedFor }
        const now = this.clock().getTime()
        if (!interruptedFor && job.budgets.stageTimeoutMs > 0 && now - started > job.budgets.stageTimeoutMs) interrupt(`Stage timed out after ${Math.round(job.budgets.stageTimeoutMs / 60_000)} minutes`)
        if (interruptedFor && now - interruptedAt > (this.options.interruptGraceMs ?? 120_000)) return { kind: 'settled', observation: { ...observation, phase: 'interrupted' }, interruptedFor: `${interruptedFor}; the conversation did not stop within the grace period and was abandoned` }
        await this.sleep(this.pollMs)
      }
    } finally { watch.dispose() }
  }

  private async conclude(run: Run, job: StoredJob, stage: DurableJobStage, stages: DurableJobStage[], wait: Wait, fresh: boolean, op?: DurableJobOperation): Promise<'continue' | 'stop'> {
    if (wait.kind === 'stale') return 'stop'
    const guard = this.guard(run)
    const inFlight = op ?? this.store.operations(job.id, 'intended').filter(candidate => candidate.stageId === stage.id && candidate.kind === 'model-call').at(-1)
    if (wait.kind === 'needs-owner') {
      // Never answered on the owner's behalf: the conversation keeps waiting in its tab and the
      // model call stays in flight; resume re-attaches to it.
      this.block(run, `Stage ${stage.index + 1} is waiting for ${wait.observation.phase === 'waiting_approval' ? 'an approval' : 'an answer'} the job cannot give`, `Answer it in the stage conversation (${stage.agentSessionId ?? 'its tab'}), then resume the job.`, 'approval')
      return 'stop'
    }
    run.agentSessionId = undefined
    const observation = wait.observation
    const succeeded = !wait.interruptedFor && stageSucceeded(observation)
    if (inFlight && inFlight.status === 'intended') this.store.settle(job.id, guard, inFlight.id, succeeded ? 'done' : 'failed', succeeded ? 'The conversation finished with a completed stop report' : describeFailure(observation, wait.interruptedFor))
    const latest = this.store.get(job.id)
    const allStages = this.store.stages(job.id)
    const decision = this.options.handoff.afterStage({ job: latest, stage, stages: allStages, observation, succeeded })
    this.store.batch(job.id, () => {
      for (const test of decision.tests ?? []) this.store.event(job.id, guard, 'note', `Test ${test.outcome}: ${test.command}`, { stageId: stage.id, test })
      if (decision.contextRollover) {
        this.store.count(job.id, guard, { contextRollovers: 1 })
        this.store.event(job.id, guard, 'note', `Stage ${stage.index + 1} filled its context past the rollover threshold; the next stage starts fresh from the handoff`, { stageId: stage.id, contextRollover: true, promptTokens: observation.report?.context.usedTokens ?? null })
      }
    })
    if (succeeded) {
      this.store.update(job.id, guard, { handoff: decision.handoff })
      const checkpointId = await this.checkpoint(run, stage, `After stage ${stage.index + 1} "${stage.title}"`, observation.filesChanged)
      if (!this.owned(run)) return 'stop'
      const completed: DurableJobStage = { ...stage, status: 'completed', completedAt: this.clock().toISOString(), result: decision.result || observation.lastAnswer.trim().slice(0, 1_200), error: undefined, ...(checkpointId ? { checkpointId } : {}) }
      this.store.batch(job.id, () => {
        this.store.saveStage(job.id, guard, completed, { kind: 'stage', message: `Stage ${stage.index + 1} "${stage.title}" completed after ${stage.attempt} attempt(s)`, data: { filesChanged: observation.filesChanged.slice(0, 100), nextAction: decision.handoff.nextAction, promptTokens: observation.report?.context.usedTokens ?? null, peakPromptTokens: observation.report?.timeline.length ? Math.max(...observation.report.timeline.map(round => round.promptTokens)) : null, windowTokens: observation.report?.context.windowTokens ?? null, rounds: observation.report?.rounds ?? null } })
        this.store.count(job.id, guard, { stagesCompleted: 1 })
      })
      if (allStages.some(candidate => candidate.index > stage.index && candidate.status === 'pending')) return 'continue'
      if (decision.jobDone || (latest.planned && !decision.nextStage)) return 'continue'
      if (decision.nextStage) {
        const limit = this.options.maxImplicitStages ?? 40
        if (allStages.length >= limit) {
          this.block(run, `The job planned ${allStages.length} stages for itself, the most it may without the owner`, decision.handoff.nextAction || 'Review the report so far and resume to allow more stages, or cancel.')
          return 'stop'
        }
        const index = Math.max(...allStages.map(candidate => candidate.index)) + 1
        this.store.addStage(job.id, guard, { id: makeId('jobstage'), jobId: job.id, index, title: decision.nextStage.title, objective: decision.nextStage.objective, completionCriteria: decision.nextStage.completionCriteria, inputs: decision.nextStage.inputs ?? [], status: 'pending', attempt: 0 })
        return 'continue'
      }
      this.block(run, `Stage ${stage.index + 1} finished without saying whether the objective is met or what comes next`, decision.handoff.nextAction || 'Read the last stage result, then resume with a clearer objective or cancel.')
      return 'stop'
    }
    // Failed attempt.
    const error = describeFailure(observation, wait.interruptedFor)
    const failed: DurableJobStage = { ...stage, status: 'pending', error, agentSessionId: stage.agentSessionId }
    const previousErrors = this.store.matchingEvents(job.id, { kind: 'retry', stageId: stage.id, dataType: { error: 'string' } }).map(event => String(event.data!.error))
    this.store.batch(job.id, () => {
      this.store.update(job.id, guard, { handoff: decision.handoff })
      this.store.saveStage(job.id, guard, failed, { kind: 'retry', message: `Stage ${stage.index + 1} attempt ${stage.attempt} did not finish: ${error}`, data: { error, attempt: stage.attempt, stop: observation.stop?.reason ?? null, promptTokens: observation.report?.context.usedTokens ?? null } })
      this.store.count(job.id, guard, { retries: 1, ...(observation.stop?.reason === 'context_limit' && !decision.contextRollover ? { contextRollovers: 1 } : {}) })
    })
    // A tool call whose result was never saved has an unknown side effect. It is recorded and
    // never replayed; the owner inspects before the job continues.
    if (fresh && observation.execution?.pending) {
      const pending = observation.execution.pending
      this.store.batch(job.id, () => {
        const record = this.store.intend(job.id, guard, { stageId: stage.id, kind: operationKindForTool(pending.name), description: `${pending.name} ${pending.arguments.slice(0, 600)}` })
        this.store.settle(job.id, guard, record.id, 'unknown', 'The tool call was cut off before its result was saved; it is not replayed.')
      })
      this.block(run, `Stage ${stage.index + 1} stopped during ${pending.name}; its effect is unknown`, `Inspect what ${pending.name} did in ${job.cwd}, then resume the job; it will not be replayed.`)
      return 'stop'
    }
    if (observation.stop?.reason === 'provider_error') {
      const restarted = await this.options.server.recover(job.model.model, error, { jobId: job.id, epoch: run.epoch }).catch(() => false)
      if (this.owned(run)) this.store.event(job.id, guard, 'server', restarted ? 'Local model server restarted after a provider error' : 'Local model server reported an error; no restart was made', { error })
    }
    const loop = this.options.loopGuard.assess({ job: this.store.get(job.id), stage: failed, stages: this.store.stages(job.id), observation, error, previousErrors })
    if (loop.loop && loop.kind === 'approval') {
      this.block(run, `Stage ${stage.index + 1} needs the owner's permission: ${loop.detail}`, `Grant or perform that step yourself (the job never widens its own permissions), then resume the job.`, 'approval')
      return 'stop'
    }
    if (loop.loop) {
      this.store.count(job.id, guard, { loopsDetected: 1 })
      this.block(run, `Loop detected in stage ${stage.index + 1}: ${loop.detail}`, `Change the approach for stage ${stage.index + 1} (${stage.title}); resuming grants new attempts.`, 'loop-detected')
      return 'stop'
    }
    return 'continue'
  }

  /**
   * A checkpoint at a stage boundary. In the job's own git worktree it is a commit of every change
   * there (only the job's); elsewhere a copy of the files the job changed, under logDir. The
   * operation is recorded as intended before the commit/copy and settled after.
   */
  private async checkpoint(run: Run, stage: DurableJobStage, reason: string, extraFiles: string[] = []): Promise<string | undefined> {
    const job = this.owned(run)
    if (!job) return undefined
    const guard = this.guard(run)
    if (job.worktree) {
      const op = this.store.intend(job.id, guard, { stageId: stage.id, kind: 'git', description: `Checkpoint commit on ${job.worktree.branch}: ${reason}` })
      try {
        const commit = await this.options.worktrees.commit(job.worktree.path, `Durable job checkpoint: ${reason}`, op.id)
        if (!this.owned(run)) return undefined
        this.store.settle(job.id, guard, op.id, 'done', commit ? `Committed ${commit}` : 'Nothing to commit')
        return commit ? this.store.addCheckpoint(job.id, guard, { stageId: stage.id, reason, commit, artifacts: [] }).id : undefined
      } catch (error) {
        if (!this.owned(run)) return undefined
        this.store.settle(job.id, guard, op.id, 'failed', error instanceof Error ? error.message : String(error))
        this.store.event(job.id, guard, 'note', `Checkpoint commit failed: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }
    const files = [...new Set([...job.handoff.filesChanged, ...extraFiles])]
    if (!files.length) return undefined
    const directory = join(job.logDir, 'checkpoints', makeId('snap'))
    const op = this.store.intend(job.id, guard, { stageId: stage.id, kind: 'file-write', description: `Snapshot ${files.length} file(s) into ${directory}` })
    try {
      const artifacts = await this.options.worktrees.snapshot(job.cwd, files, directory)
      if (!this.owned(run)) return undefined
      this.store.settle(job.id, guard, op.id, 'done', `Snapshot manifest written (${artifacts.length - 1} file(s))`)
      return this.store.addCheckpoint(job.id, guard, { stageId: stage.id, reason, artifacts }).id
    } catch (error) {
      if (!this.owned(run)) return undefined
      this.store.settle(job.id, guard, op.id, 'failed', error instanceof Error ? error.message : String(error))
      return undefined
    }
  }
}

export const emptyObservation = (phase: StageObservation['phase']): StageObservation => ({ phase, stopSequence: 0, lastAnswer: '', filesChanged: [] })
export type { DurableJob }
