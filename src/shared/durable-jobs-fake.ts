import { checkpointsFromEvents } from './durable-jobs-bridge'
import {
  canTransition, DEFAULT_DURABLE_JOB_BUDGETS, TERMINAL_JOB_STATUSES,
  type CreateDurableJobInput, type DurableJob, type DurableJobCheckpoint, type DurableJobEvent, type DurableJobReport, type DurableJobsService,
  type DurableJobStage, type DurableJobStatus, type DurableJobSummary
} from './durable-jobs'

/**
 * An in-memory DurableJobsService for tests and the renderer story. It keeps the contract's
 * rules that callers depend on — unknown jobs throw, illegal transitions throw, every change
 * fires onChange with the summary — and nothing else: no model, no worktree, no disk.
 * Test helpers (`advance`, `checkpoint`, `record`, `setStatus`) drive a job the way the real
 * controller would.
 */
export class FakeDurableJobsService implements DurableJobsService {
  private readonly jobs = new Map<string, DurableJob & { stages: DurableJobStage[] }>()
  private readonly eventLog = new Map<string, DurableJobEvent[]>()
  private readonly listeners = new Set<(summary: DurableJobSummary) => void>()
  private sequence = 0
  readonly created: CreateDurableJobInput[] = []

  constructor(private readonly options: { now?: () => number; logRoot?: string; report?: (job: DurableJob & { stages: DurableJobStage[] }, events: DurableJobEvent[]) => Promise<DurableJobReport & { reportPath: string }> } = {}) {}

  private now(): string { return new Date(this.options.now?.() ?? Date.now()).toISOString() }
  private id(prefix: string): string { this.sequence += 1; return `${prefix}_${this.sequence.toString().padStart(4, '0')}` }

  private require(jobId: string): DurableJob & { stages: DurableJobStage[] } {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`No durable job ${jobId}`)
    return job
  }

  async create(input: CreateDurableJobInput): Promise<DurableJobSummary> {
    this.created.push(structuredClone(input))
    const id = this.id('job'), at = this.now()
    const plan = input.stages?.length ? input.stages : [{ title: 'Plan and first step', objective: input.objective, completionCriteria: ['A plan is recorded'] }]
    const job: DurableJob & { stages: DurableJobStage[] } = {
      id, projectId: input.projectId, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), cwd: `/fake/${id}`,
      title: input.title, objective: input.objective, ...(input.createdBy ? { createdBy: input.createdBy } : {}), status: 'queued', model: { provider: 'local', model: input.model, escalation: 'never' },
      budgets: { ...DEFAULT_DURABLE_JOB_BUDGETS, ...input.budgets },
      handoff: { objective: input.objective, constraints: input.constraints ?? [], decisions: [], workDone: [], filesChanged: [], testResults: [], unresolvedIssues: [], nextAction: plan[0]!.objective, artifacts: [], updatedAt: at },
      createdAt: at, updatedAt: at, activeMs: 0,
      counters: { stagesCompleted: 0, retries: 0, recoveries: 0, contextRollovers: 0, loopsDetected: 0, cloudEscalations: 0 },
      logDir: `${this.options.logRoot ?? '/fake/logs'}/${id}`,
      stages: plan.map((stage, index) => ({ id: `${id}_stage_${index}`, jobId: id, index, title: stage.title, objective: stage.objective, completionCriteria: stage.completionCriteria, inputs: 'inputs' in stage && stage.inputs ? stage.inputs : [], status: 'pending', attempt: 0 }))
    }
    this.jobs.set(id, job)
    this.eventLog.set(id, [])
    this.record(id, 'transition', 'Job queued')
    return this.summary(job)
  }

  list(filter?: { projectId?: string; status?: DurableJobStatus[] }): DurableJobSummary[] {
    return [...this.jobs.values()]
      .filter(job => (!filter?.projectId || job.projectId === filter.projectId) && (!filter?.status?.length || filter.status.includes(job.status)))
      .map(job => this.summary(job))
  }

  get(jobId: string): DurableJob & { stages: DurableJobStage[] } { return structuredClone(this.require(jobId)) }
  status(jobId: string): DurableJobSummary { return this.summary(this.require(jobId)) }

  events(jobId: string, afterId?: string, limit = 100): DurableJobEvent[] {
    this.require(jobId)
    const all = this.eventLog.get(jobId) ?? []
    const start = afterId ? all.findIndex(event => event.id === afterId) + 1 : 0
    return all.slice(start, start + limit)
  }

  checkpoints(jobId: string): DurableJobCheckpoint[] {
    this.require(jobId)
    return checkpointsFromEvents(this.eventLog.get(jobId) ?? [])
  }

  pause(jobId: string, reason?: string): DurableJobSummary { return this.setStatus(jobId, 'paused', reason ?? 'Paused by request') }
  async resume(jobId: string): Promise<DurableJobSummary> { return this.setStatus(jobId, 'running', 'Resumed') }
  async cancel(jobId: string, reason?: string): Promise<DurableJobSummary> { return this.setStatus(jobId, 'cancelled', reason ?? 'Cancelled by request') }

  async report(jobId: string): Promise<DurableJobReport & { reportPath: string }> {
    const job = this.require(jobId)
    if (this.options.report) return this.options.report(structuredClone(job), [...this.eventLog.get(jobId) ?? []])
    const summary = this.summary(job)
    return {
      jobId, status: job.status, elapsedMs: summary.elapsedMs, activeMs: job.activeMs,
      modelsByStage: job.stages.filter(stage => stage.attempt > 0).map(stage => ({ stage: stage.title, model: stage.model ?? job.model.model, attempts: stage.attempt })),
      filesChanged: job.handoff.filesChanged, results: job.stages.flatMap(stage => stage.result ? [stage.result] : []), tests: [], checkpoints: [], recoveries: [],
      remainingWork: job.handoff.unresolvedIssues, cloudEscalation: { occurred: job.counters.cloudEscalations > 0 }, logPaths: [job.logDir], generatedAt: this.now(),
      reportPath: `${job.logDir}/report.md`
    }
  }

  onChange(listener: (summary: DurableJobSummary) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // --- test helpers: what the real controller does to a job ---

  setStatus(jobId: string, status: DurableJobStatus, reason?: string): DurableJobSummary {
    const job = this.require(jobId)
    if (!canTransition(job.status, status)) throw new Error(`A ${job.status} job cannot become ${status}`)
    const at = this.now()
    job.status = status
    job.statusReason = reason
    if (status === 'running' && !job.startedAt) job.startedAt = at
    if (TERMINAL_JOB_STATUSES.includes(status)) job.finishedAt = at
    this.touch(job)
    this.record(jobId, 'transition', `Job ${status}${reason ? ': ' + reason : ''}`)
    return this.summary(job)
  }

  /** Starts, finishes or fails the current stage. */
  advance(jobId: string, patch: Partial<Pick<DurableJobStage, 'status' | 'model' | 'result' | 'error' | 'checkpointId'>> & { activeMs?: number; retry?: boolean }): DurableJobSummary {
    const job = this.require(jobId)
    const stage = job.stages.find(item => item.id === job.currentStageId) ?? job.stages.find(item => item.status === 'pending' || item.status === 'running')
    if (!stage) throw new Error('No stage left to advance')
    const at = this.now()
    if (patch.retry) { job.counters.retries += 1; this.record(jobId, 'retry', `Retrying ${stage.title}`) }
    if (patch.status === 'running' || patch.retry) { stage.status = 'running'; stage.attempt += 1; stage.startedAt = at; stage.model = patch.model ?? job.model.model; job.currentStageId = stage.id }
    else if (patch.status) {
      stage.status = patch.status
      stage.completedAt = at
      if (patch.status === 'completed') { job.counters.stagesCompleted += 1; job.currentStageId = undefined }
    }
    if (patch.result !== undefined) stage.result = patch.result
    if (patch.error !== undefined) stage.error = patch.error
    if (patch.checkpointId !== undefined) stage.checkpointId = patch.checkpointId
    if (patch.activeMs) job.activeMs += patch.activeMs
    this.touch(job)
    this.record(jobId, 'stage', `${stage.title}: ${stage.status}`, { stageId: stage.id, attempt: stage.attempt })
    return this.summary(job)
  }

  checkpoint(jobId: string, checkpoint: Omit<DurableJobCheckpoint, 'id' | 'jobId' | 'createdAt'> & { id?: string }): DurableJobCheckpoint {
    const job = this.require(jobId)
    const saved: DurableJobCheckpoint = { id: checkpoint.id ?? this.id('ckpt'), jobId, createdAt: this.now(), ...checkpoint }
    this.touch(job)
    this.record(jobId, 'checkpoint', saved.reason, { checkpoint: saved })
    return saved
  }

  mutate(jobId: string, change: (job: DurableJob & { stages: DurableJobStage[] }) => void): void {
    const job = this.require(jobId)
    change(job)
    this.touch(job)
    for (const listener of this.listeners) listener(this.summary(job))
  }

  record(jobId: string, kind: DurableJobEvent['kind'], message: string, data?: Record<string, unknown>): DurableJobEvent {
    const event: DurableJobEvent = { id: this.id('evt'), jobId, at: this.now(), kind, message, ...(data ? { data } : {}) }
    this.eventLog.get(jobId)!.push(event)
    const job = this.require(jobId)
    for (const listener of this.listeners) listener(this.summary(job))
    return event
  }

  private touch(job: DurableJob): void { job.updatedAt = this.now() }

  private summary(job: DurableJob & { stages: DurableJobStage[] }): DurableJobSummary {
    const stage = job.stages.find(item => item.id === job.currentStageId)
    const events = this.eventLog.get(job.id) ?? []
    const last = events[events.length - 1]
    const checkpoint = [...events].reverse().find(event => event.kind === 'checkpoint')?.data?.checkpoint as DurableJobCheckpoint | undefined
    const end = job.finishedAt ? Date.parse(job.finishedAt) : this.options.now?.() ?? Date.now()
    return {
      id: job.id, projectId: job.projectId, title: job.title, status: job.status, ...(job.statusReason ? { statusReason: job.statusReason } : {}), model: job.model.model,
      ...(stage ? { currentStage: { id: stage.id, index: stage.index, title: stage.title, attempt: stage.attempt, ...(stage.startedAt ? { startedAt: stage.startedAt } : {}) } } : {}),
      stagesCompleted: job.counters.stagesCompleted, stagesTotal: job.stages.length,
      elapsedMs: job.startedAt ? Math.max(0, end - Date.parse(job.startedAt)) : 0, activeMs: job.activeMs,
      ...(checkpoint ? { lastCheckpoint: { id: checkpoint.id, createdAt: checkpoint.createdAt, reason: checkpoint.reason, ...(checkpoint.commit ? { commit: checkpoint.commit } : {}) } } : {}),
      ...(last ? { lastEvent: { at: last.at, kind: last.kind, message: last.message } } : {}),
      counters: { ...job.counters }, updatedAt: job.updatedAt
    }
  }
}
