import type {
  CreateDurableJobInput, DurableJob, DurableJobCheckpoint, DurableJobEvent, DurableJobReport, DurableJobStage, DurableJobStatus, DurableJobSummary
} from './durable-jobs'

/**
 * The renderer's view of durable local-model jobs: typed IPC over the same DurableJobsService the
 * control protocol's jobs.* methods use. The contract itself lives in durable-jobs.ts; this file
 * only names the channels and the bridge so preload, main and the renderer agree.
 */
export const DURABLE_JOB_CHANNELS = {
  list: 'jobs:list',
  status: 'jobs:status',
  detail: 'jobs:detail',
  events: 'jobs:events',
  create: 'jobs:create',
  pause: 'jobs:pause',
  resume: 'jobs:resume',
  cancel: 'jobs:cancel',
  report: 'jobs:report',
  reveal: 'jobs:reveal',
  changed: 'jobs:changed'
} as const

/** Everything the job view renders for one job: the job, its stages, recent events and the
 *  checkpoints the controller recorded. Paths only; never log contents. */
export interface DurableJobDetail {
  job: DurableJob & { stages: DurableJobStage[] }
  summary: DurableJobSummary
  events: DurableJobEvent[]
  checkpoints: DurableJobCheckpoint[]
}

export interface DurableJobsBridge {
  list(projectId: string, status?: DurableJobStatus[]): Promise<DurableJobSummary[]>
  status(projectId: string, jobId: string): Promise<DurableJobSummary>
  detail(projectId: string, jobId: string): Promise<DurableJobDetail>
  events(projectId: string, jobId: string, afterId?: string, limit?: number): Promise<DurableJobEvent[]>
  /** The owner's own window: no creator agent, no escalation field; the model must be local. */
  create(input: Pick<CreateDurableJobInput, 'projectId' | 'workspaceId' | 'title' | 'objective' | 'model' | 'constraints'>): Promise<DurableJobSummary>
  pause(projectId: string, jobId: string, reason?: string): Promise<DurableJobSummary>
  resume(projectId: string, jobId: string): Promise<DurableJobSummary>
  cancel(projectId: string, jobId: string, reason?: string): Promise<DurableJobSummary>
  report(projectId: string, jobId: string): Promise<DurableJobReport & { reportPath: string }>
  /** Shows the job's log directory (or its report) in the file manager. */
  reveal(projectId: string, jobId: string, target: 'logs' | 'report'): Promise<void>
  /** Fires with the summary on every persisted change of any job. */
  onChanged(callback: (summary: DurableJobSummary) => void): () => void
}

/** Checkpoints are recorded by the controller as `checkpoint` events carrying the checkpoint in
 *  `data.checkpoint` (or its fields flat in `data`). The service interface has no checkpoint
 *  accessor, so the view and the report read them back from the event stream. */
export function checkpointsFromEvents(events: readonly DurableJobEvent[]): DurableJobCheckpoint[] {
  const found = new Map<string, DurableJobCheckpoint>()
  for (const event of events) {
    if (event.kind !== 'checkpoint') continue
    const data = (event.data ?? {}) as Record<string, unknown>
    const raw = (data.checkpoint && typeof data.checkpoint === 'object' ? data.checkpoint : data) as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id : typeof data.checkpointId === 'string' ? data.checkpointId : event.id
    found.set(id, {
      id, jobId: event.jobId,
      ...(typeof raw.stageId === 'string' ? { stageId: raw.stageId } : {}),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : event.at,
      reason: typeof raw.reason === 'string' ? raw.reason : event.message,
      ...(typeof raw.commit === 'string' ? { commit: raw.commit } : {}),
      artifacts: Array.isArray(raw.artifacts) ? raw.artifacts as DurableJobCheckpoint['artifacts'] : []
    })
  }
  return [...found.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
