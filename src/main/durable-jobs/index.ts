import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { makeId } from '../../shared/models'
import { DEFAULT_DURABLE_JOB_BUDGETS, DURABLE_STAGE_KINDS, TERMINAL_JOB_STATUSES, type CreateDurableJobInput, type DurableJobCheckpoint, type DurableJob, type DurableJobBudgets, type DurableJobEvent, type DurableJobReport, type DurableJobsService, type DurableJobStage, type DurableJobStatus, type DurableJobSummary } from '../../shared/durable-jobs'
import { DurableJobController, operationKindForTool } from './controller'
import { alwaysReadyServer, defaultHandoffPort, jsonReportPort, noopWatchdog, repeatedErrorLoopGuard, type CompletionCheckPort, type HandoffPort, type LoopGuardPort, type LocalExecutionView, type ReportPort, type ServerLifecyclePort, type StageRuntime, type WatchdogPort } from './ports'
import { reconcileJobs, type ReconcileOutcome } from './reconcile'
import { collectDurableJobEvents } from './report'
import { DurableJobStore, type StoredJob } from './store'
import { gitWorktrees, type JobWorktree, type WorktreeOps } from './worktree'

export { DurableJobStore } from './store'
export { structuredStageRuntime } from './structured-runtime'
export type { StageRuntime, HandoffPort, WatchdogPort, ServerLifecyclePort, LoopGuardPort, ReportPort } from './ports'

export interface DurableJobsServiceOptions {
  store: DurableJobStore
  runtime: StageRuntime
  /** Root for per-job logDirs and worktrees, e.g. <userData>/durable-jobs. */
  logRoot: string
  /** The folder of a registered project, or null when the project is unknown. */
  projectPath(projectId: string): string | null
  handoff?: HandoffPort
  watchdog?: WatchdogPort
  server?: ServerLifecyclePort
  loopGuard?: LoopGuardPort
  report?: ReportPort
  worktrees?: WorktreeOps
  completion?: CompletionCheckPort
  /** Throws when the model is not an available local model (models.list id). */
  validateModel?: (model: string) => void | Promise<void>
  ownerId?: string
  clock?: () => Date
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  leaseTtlMs?: number
  maxConcurrent?: number
  maxImplicitStages?: number
  interruptGraceMs?: number
}

const text = (value: unknown, name: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be 1-${max} characters`)
  return value.trim()
}

function budgetsFrom(input: Partial<DurableJobBudgets> = {}): DurableJobBudgets {
  const budgets = { ...DEFAULT_DURABLE_JOB_BUDGETS, ...input }
  for (const key of ['maxElapsedMs', 'modelCallTimeoutMs', 'toolCallTimeoutMs', 'stageTimeoutMs', 'contextSafetyMarginTokens'] as const) if (!Number.isSafeInteger(budgets[key]) || budgets[key] < 0) throw new Error(`budgets.${key} must be a non-negative integer`)
  if (!Number.isInteger(budgets.maxStageAttempts) || budgets.maxStageAttempts < 1 || budgets.maxStageAttempts > 20) throw new Error('budgets.maxStageAttempts must be 1-20')
  if (!(budgets.contextRolloverFraction > 0.1 && budgets.contextRolloverFraction <= 0.95)) throw new Error('budgets.contextRolloverFraction must be in (0.1, 0.95]')
  if (budgets.stagePromptBudgetTokens !== undefined && (!Number.isSafeInteger(budgets.stagePromptBudgetTokens) || budgets.stagePromptBudgetTokens < 512)) throw new Error('budgets.stagePromptBudgetTokens must be a whole number of at least 512')
  return budgets
}

const stageKindOf = (value: unknown): NonNullable<DurableJobStage['kind']> => {
  if (!DURABLE_STAGE_KINDS.includes(value as never)) throw new Error(`stage kind must be one of ${DURABLE_STAGE_KINDS.join(', ')}`)
  return value as NonNullable<DurableJobStage['kind']>
}

const creatorOf = (value: NonNullable<CreateDurableJobInput['createdBy']>): NonNullable<DurableJob['createdBy']> => {
  if (!['owner', 'wizard', 'agent'].includes(value.kind)) throw new Error('createdBy.kind must be owner, wizard or agent')
  return { kind: value.kind, agentSessionId: text(value.agentSessionId, 'createdBy.agentSessionId', 200), title: String(value.title ?? '').slice(0, 200) }
}

/**
 * The main process's durable-jobs service (DurableJobsService in the shared contract). It owns the
 * controller and the restart reconciliation; the control protocol and IPC call it, and onChange
 * fires with a fresh summary after every committed store change.
 */
export class DurableJobsServiceImpl implements DurableJobsService {
  readonly controller: DurableJobController
  readonly ownerId: string
  private readonly listeners = new Set<(summary: DurableJobSummary) => void>()
  private readonly handoff: HandoffPort
  private readonly report_: ReportPort
  private readonly worktrees: WorktreeOps
  private readonly clock: () => Date
  private readonly disposeStore: () => void
  /** Jobs a previous process left running, until start() has reconciled them. An owner command
   *  before that would settle their in-flight work blindly and skip the reconciliation. */
  private readonly unreconciled: Set<string>

  constructor(private readonly options: DurableJobsServiceOptions) {
    this.ownerId = options.ownerId ?? `${process.pid}:${randomUUID()}`
    this.unreconciled = new Set(options.store.list({ status: ['running', 'recovering'] }).filter(job => job.lease?.ownerId !== this.ownerId).map(job => job.id))
    this.handoff = options.handoff ?? defaultHandoffPort
    this.report_ = options.report ?? jsonReportPort
    this.worktrees = options.worktrees ?? gitWorktrees
    this.clock = options.clock ?? (() => new Date())
    this.controller = new DurableJobController({
      store: options.store, runtime: options.runtime, handoff: this.handoff,
      watchdog: options.watchdog ?? noopWatchdog, server: options.server ?? alwaysReadyServer,
      loopGuard: options.loopGuard ?? repeatedErrorLoopGuard, worktrees: this.worktrees, completion: options.completion,
      ownerId: this.ownerId, clock: this.clock, sleep: options.sleep, pollMs: options.pollMs,
      leaseTtlMs: options.leaseTtlMs, maxConcurrent: options.maxConcurrent, maxImplicitStages: options.maxImplicitStages,
      interruptGraceMs: options.interruptGraceMs,
      finished: jobId => { void this.report(jobId).catch(error => console.warn(`Durable job ${jobId}: report failed`, error)) }
    })
    this.disposeStore = options.store.onChange(jobId => {
      if (!this.listeners.size) return
      const summary = this.status(jobId)
      for (const listener of this.listeners) { try { listener(summary) } catch (error) { console.warn('Durable job change listener failed', error) } }
    })
  }

  private get store(): DurableJobStore { return this.options.store }

  /** App start: reconcile what the previous process left running, then resume and dequeue. */
  async start(): Promise<ReconcileOutcome[]> {
    let outcomes: ReconcileOutcome[]
    try { outcomes = await reconcileJobs({ store: this.store, runtime: this.options.runtime, worktrees: this.worktrees, ownerId: this.ownerId, leaseTtlMs: this.options.leaseTtlMs ?? 60_000 }) }
    finally { this.unreconciled.clear() }
    for (const outcome of outcomes) this.controller.markLost(outcome.lostSessions)
    for (const outcome of outcomes) if (outcome.decision === 'resume') {
      try { this.controller.start(outcome.jobId, 'Recovered after Conductor restarted') }
      catch (error) { console.warn(`Durable job ${outcome.jobId} could not resume`, error) }
    }
    this.controller.schedule()
    return outcomes
  }

  /** App quit: stop driving jobs without writing; the next launch reconciles them. */
  dispose(): void {
    this.controller.dispose()
    this.disposeStore()
  }

  async create(input: CreateDurableJobInput): Promise<DurableJobSummary> {
    const title = text(input.title, 'title', 200)
    const objective = text(input.objective, 'objective', 20_000)
    const model = text(input.model, 'model', 200)
    // Model policy: a durable job runs on a local model and stays on it.
    if (model.includes('/') && !model.startsWith('local/')) throw new Error('A durable job runs on a local model; choose a local model from models.list')
    await this.options.validateModel?.(model)
    const projectPath = this.options.projectPath(input.projectId)
    if (!projectPath) throw new Error('No project with that id is registered in Conductor')
    const budgets = budgetsFrom(input.budgets)
    const plan = input.stages?.length ? input.stages : undefined
    if (plan && plan.length > 50) throw new Error('A job plan may have at most 50 stages')
    const id = makeId('job')
    const logDir = join(this.options.logRoot, id)
    await mkdir(logDir, { recursive: true })
    let worktree: JobWorktree | undefined
    let cwd = projectPath
    if (input.isolateWorktree !== false) {
      const root = await this.worktrees.gitRoot(projectPath)
      if (root) {
        worktree = await this.worktrees.create(projectPath, id, join(logDir, 'worktree'))
        cwd = join(worktree.path, relative(root, projectPath))
      }
    }
    const now = this.clock().toISOString()
    const stages: DurableJobStage[] = (plan ?? [{ title: 'Stage 1', objective, completionCriteria: [] }]).map((stage, index) => ({
      id: makeId('jobstage'), jobId: id, index,
      title: text(stage.title, 'stage title', 200), objective: text(stage.objective, 'stage objective', 20_000),
      ...('kind' in stage && stage.kind ? { kind: stageKindOf(stage.kind) } : {}),
      completionCriteria: (stage.completionCriteria ?? []).map(String).slice(0, 20), inputs: 'inputs' in stage && stage.inputs ? stage.inputs.slice(0, 50) : [],
      status: 'pending', attempt: 0
    }))
    const job: DurableJob = {
      id, projectId: input.projectId, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), cwd, ...(worktree ? { worktree } : {}),
      title, objective, ...(input.createdBy ? { createdBy: creatorOf(input.createdBy) } : {}), status: 'queued',
      model: { provider: 'local', model, escalation: 'never' }, budgets,
      handoff: { objective, constraints: (input.constraints ?? []).map(String).slice(0, 40), decisions: [], workDone: [], filesChanged: [], testResults: [], unresolvedIssues: [], nextAction: stages[0]!.objective, artifacts: [], updatedAt: now },
      createdAt: now, updatedAt: now, activeMs: 0,
      counters: { stagesCompleted: 0, retries: 0, recoveries: 0, contextRollovers: 0, loopsDetected: 0, cloudEscalations: 0 },
      logDir
    }
    this.store.batch(id, () => {
      this.store.create(job, stages, Boolean(plan))
      this.store.event(id, { owner: true }, 'note', `Model policy: every stage runs on ${model} (local); no automatic cloud escalation.`, { model })
      if (worktree) this.store.event(id, { owner: true }, 'note', `Working in an isolated worktree on branch ${worktree.branch} from ${worktree.baseCommit.slice(0, 12)}; uncommitted changes in the project folder are not part of this job and are never touched.`, { worktree: worktree.path })
      else this.store.event(id, { owner: true }, 'note', 'Working in the project folder (no git isolation); checkpoints are file snapshots under the job log folder.')
    })
    this.controller.schedule()
    return this.status(id)
  }

  list(filter: { projectId?: string; status?: DurableJobStatus[] } = {}): DurableJobSummary[] {
    return this.store.list(filter).map(job => this.summarize(job))
  }

  get(jobId: string): DurableJob & { stages: DurableJobStage[] } {
    const { planned: _planned, ...job } = this.store.get(jobId)
    return { ...job, stages: this.store.stages(jobId) }
  }

  status(jobId: string): DurableJobSummary { return this.summarize(this.store.get(jobId)) }

  events(jobId: string, afterId?: string, limit?: number): DurableJobEvent[] {
    this.store.get(jobId)
    return this.store.events(jobId, afterId, limit)
  }

  latestEvents(jobId: string, limit: number): DurableJobEvent[] {
    this.store.get(jobId)
    return this.store.latestEvents(jobId, limit)
  }

  checkpoints(jobId: string): DurableJobCheckpoint[] {
    this.store.get(jobId)
    return this.store.checkpoints(jobId)
  }

  /** Refuses an owner command on a job the previous process left running until start() has
   *  reconciled it (reconciliation runs a few seconds after launch, once the windows are up). */
  private refuseUnreconciled(jobId: string): void {
    if (this.unreconciled.has(jobId)) throw new Error('Conductor is still reconciling this job after the restart (it first settles what the previous run left in flight); try again in a few seconds.')
  }

  /**
   * Settles what the owner's pause or cancel cuts off. A tool call the stage conversation has in
   * flight may be half done: it is recorded as its own unknown side effect (never replayed), and
   * the model call that made it settles unknown too instead of reading as a clean failure.
   */
  private settleCutOff(jobId: string, stage: DurableJobStage | undefined, failed: string): Pending | undefined {
    const pending = stage?.agentSessionId ? this.options.runtime.observe(stage.agentSessionId).execution?.pending : undefined
    for (const op of this.store.operations(jobId, 'intended')) {
      const cut = pending && op.kind === 'model-call' && op.stageId === stage!.id
      this.store.settle(jobId, { owner: true }, op.id, cut ? 'unknown' : 'failed', cut ? `Stopped by the owner inside ${pending.name} (${pending.id}); its side effect is unknown and it is not replayed.` : failed)
    }
    if (pending) this.recordCutOffTool(jobId, stage!, pending)
    return pending
  }

  private recordCutOffTool(jobId: string, stage: DurableJobStage, pending: Pending): void {
    const record = this.store.intend(jobId, { owner: true }, { stageId: stage.id, kind: operationKindForTool(pending.name), description: `${pending.name} ${pending.arguments.slice(0, 600)}` })
    this.store.settle(jobId, { owner: true }, record.id, 'unknown', 'The owner stopped the stage while this tool call ran; it may have partly run and is not replayed.')
  }

  /** Interrupts the stage conversation, then records a tool call it started meanwhile. */
  private async interruptStage(jobId: string, stage: DurableJobStage | undefined, recorded: Pending | undefined): Promise<void> {
    if (!stage?.agentSessionId) return
    await this.options.runtime.interrupt(stage.agentSessionId).catch(error => console.warn(`Durable job ${jobId}: interrupt failed`, error))
    const late = this.options.runtime.observe(stage.agentSessionId).execution?.pending
    if (late && late.id !== recorded?.id) this.recordCutOffTool(jobId, stage, late)
  }

  pause(jobId: string, reason = 'Paused by the owner'): DurableJobSummary {
    const job = this.store.get(jobId)
    if (job.status !== 'running' && job.status !== 'queued') throw new Error(`Only a running or queued job can be paused; this one is ${job.status}`)
    this.refuseUnreconciled(jobId)
    const running = this.store.stages(jobId).find(stage => stage.status === 'running')
    // The owner's command supersedes the running loop first, so it cannot write after this. The
    // conversation is interrupted at once, whatever it is doing: there is no safe point to wait for.
    let pending: Pending | undefined
    this.store.batch(jobId, () => {
      this.store.supersede(jobId, reason)
      pending = this.settleCutOff(jobId, running, 'Interrupted by the owner\'s pause; not replayed. Resume starts the stage in a fresh conversation.')
      // A paused attempt is not charged against the stage's attempts.
      if (running) this.store.saveStage(jobId, { owner: true }, { ...running, status: 'pending', attempt: Math.max(0, running.attempt - 1), error: pending ? `Paused by the owner during ${pending.name}` : 'Paused by the owner' }, { kind: 'stage', message: `Stage ${running.index + 1} paused; its conversation is interrupted` })
      if (!pending) this.store.transition(jobId, 'paused', reason, { owner: true })
      else {
        const nextAction = `Inspect what ${pending.name} ${pending.arguments.slice(0, 200)} did in ${job.cwd} before resuming; it was cut off mid-run and will not be replayed.`
        this.store.transition(jobId, 'paused', `${reason}; ${pending.name} was cut off mid-run and its effect is unknown`, { owner: true }, { handoff: { ...job.handoff, nextAction, updatedAt: this.clock().toISOString() } }, { nextAction })
      }
    })
    void this.controller.detach(jobId, true)
    void this.interruptStage(jobId, running, pending)
    return this.status(jobId)
  }

  async resume(jobId: string): Promise<DurableJobSummary> {
    const job = this.store.get(jobId)
    if (job.status !== 'paused' && job.status !== 'blocked') throw new Error(`Only a paused or blocked job can be resumed; this one is ${job.status}`)
    await this.controller.idle(jobId)
    const stages = this.store.stages(jobId)
    const current = stages.find(stage => stage.status === 'running') ?? stages.find(stage => stage.status === 'pending')
    // The owner's resume is the authority to try again: an exhausted stage gets new attempts.
    if (current && current.attempt >= job.budgets.maxStageAttempts + this.store.attemptBase(current.id)) this.store.grantAttempts(jobId, { owner: true }, current.id)
    const unknown = this.store.operations(jobId, 'unknown')
    if (unknown.length) this.store.event(jobId, { owner: true }, 'note', `Resumed by the owner with ${unknown.length} unverified side effect(s) left as they are; nothing is replayed.`)
    if (job.budgets.maxElapsedMs > 0) this.store.event(jobId, { owner: true }, 'note', 'The elapsed-time budget restarts from the owner\'s resume.', { elapsedBudget: 'restarted' })
    this.controller.start(jobId, 'Resumed by the owner')
    return this.status(jobId)
  }

  async cancel(jobId: string, reason = 'Cancelled by the owner'): Promise<DurableJobSummary> {
    const job = this.store.get(jobId)
    if (TERMINAL_JOB_STATUSES.includes(job.status)) throw new Error(`This job is already ${job.status}`)
    this.refuseUnreconciled(jobId)
    const stages = this.store.stages(jobId)
    const running = stages.find(stage => stage.status === 'running')
    // Authoritative: supersede, record, then stop the conversation. Nothing continues afterwards.
    let pending: Pending | undefined
    this.store.batch(jobId, () => {
      this.store.supersede(jobId, reason)
      pending = this.settleCutOff(jobId, running, 'Cancelled by the owner; not replayed.')
      for (const stage of stages) {
        if (stage.status === 'running') this.store.saveStage(jobId, { owner: true }, { ...stage, status: 'failed', error: reason, completedAt: this.clock().toISOString() })
        else if (stage.status === 'pending') this.store.saveStage(jobId, { owner: true }, { ...stage, status: 'skipped' })
      }
      this.store.transition(jobId, 'cancelled', reason, { owner: true })
    })
    await this.controller.detach(jobId, true)
    await this.interruptStage(jobId, running, pending)
    void this.report(jobId).catch(error => console.warn(`Durable job ${jobId}: report failed`, error))
    return this.status(jobId)
  }

  async report(jobId: string): Promise<DurableJobReport & { reportPath: string }> {
    const { planned: _planned, ...job } = this.store.get(jobId)
    const events = collectDurableJobEvents((after, limit) => this.store.events(jobId, after, limit))
    const report = await this.report_.write({ job, stages: this.store.stages(jobId), events, checkpoints: this.store.checkpoints(jobId), operations: this.store.operations(jobId), now: this.clock() })
    if (this.store.get(jobId).reportPath !== report.reportPath) this.store.update(jobId, { owner: true }, { reportPath: report.reportPath })
    return report
  }

  onChange(listener: (summary: DurableJobSummary) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private summarize(job: StoredJob): DurableJobSummary {
    const stages = this.store.stages(job.id)
    const current = stages.find(stage => stage.id === job.currentStageId && (stage.status === 'running' || stage.status === 'pending')) ?? stages.find(stage => stage.status === 'running')
    const now = this.clock().getTime()
    const since = job.status === 'running' ? this.store.runningSince(job.id) : undefined
    const checkpoint = this.store.checkpoints(job.id).at(-1)
    const event = this.store.lastEvent(job.id)
    return {
      id: job.id, projectId: job.projectId, title: job.title, status: job.status,
      ...(job.statusReason ? { statusReason: job.statusReason } : {}),
      model: job.model.model,
      ...(current ? { currentStage: { id: current.id, index: current.index, title: current.title, attempt: current.attempt, ...(current.startedAt ? { startedAt: current.startedAt } : {}) } } : {}),
      stagesCompleted: stages.filter(stage => stage.status === 'completed').length,
      stagesTotal: stages.length,
      elapsedMs: job.startedAt ? Math.max(0, (job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(job.startedAt)) : 0,
      activeMs: job.activeMs + (since ? Math.max(0, now - Date.parse(since)) : 0),
      ...(checkpoint ? { lastCheckpoint: { id: checkpoint.id, createdAt: checkpoint.createdAt, reason: checkpoint.reason, ...(checkpoint.commit ? { commit: checkpoint.commit } : {}) } } : {}),
      ...(event ? { lastEvent: { at: event.at, kind: event.kind, message: event.message } } : {}),
      counters: job.counters,
      updatedAt: job.updatedAt
    }
  }
}

type Pending = NonNullable<LocalExecutionView['pending']>

export function createDurableJobsService(options: DurableJobsServiceOptions): DurableJobsServiceImpl {
  return new DurableJobsServiceImpl(options)
}
