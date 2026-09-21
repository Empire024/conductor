export const SCHEDULE_JOB_IDS = ['latest-models-methods'] as const
export type ScheduleJobId = (typeof SCHEDULE_JOB_IDS)[number]
export type ScheduleOutcome = 'running' | 'unchanged' | 'changed' | 'dispatched' | 'skipped' | 'failed' | 'stale'

export interface ScheduleDefinition {
  id: string
  projectId: string
  name: string
  jobId: ScheduleJobId
  enabled: boolean
  everyMinutes: number
  catchUp: 'collapse'
  timeoutMs: number
  lastRunAt: string | null
  nextDueAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ScheduleRun {
  id: string
  scheduleId: string
  startedAt: string
  finishedAt: string | null
  outcome: ScheduleOutcome
  detail: string
  digest: string | null
  validUntil: string | null
  artifactPath: string | null
}

export interface ScheduleSnapshot {
  schedules: ScheduleDefinition[]
  runs: Record<string, ScheduleRun[]>
}

export interface CreateScheduleInput {
  projectId: string
  jobId: ScheduleJobId
  everyMinutes?: number
  enabled?: boolean
}

export interface UpdateScheduleInput {
  enabled?: boolean
  everyMinutes?: number
}

export interface SchedulesBridge {
  snapshot(projectId: string): Promise<ScheduleSnapshot>
  create(input: CreateScheduleInput): Promise<ScheduleDefinition>
  update(projectId: string, scheduleId: string, input: UpdateScheduleInput): Promise<ScheduleDefinition>
  runNow(projectId: string, scheduleId: string): Promise<ScheduleRun>
  openArtifact(projectId: string, runId: string): Promise<void>
  onChanged(callback: (projectId: string) => void): () => void
}

const intervalMs = (schedule: Pick<ScheduleDefinition, 'everyMinutes'>): number =>
  Math.max(1, Math.floor(schedule.everyMinutes)) * 60_000

/** Return the first future window. A long outage advances one window only; it never creates backfill work. */
export function nextDue(schedule: Pick<ScheduleDefinition, 'enabled' | 'everyMinutes' | 'nextDueAt' | 'lastRunAt'>, now: Date): string | null {
  if (!schedule.enabled) return null
  const step = intervalMs(schedule)
  const nowMs = now.getTime()
  const candidate = Date.parse(schedule.nextDueAt ?? schedule.lastRunAt ?? '')
  if (!Number.isFinite(candidate)) return new Date(nowMs + step).toISOString()
  if (candidate > nowMs) return new Date(candidate).toISOString()
  return new Date(candidate + (Math.floor((nowMs - candidate) / step) + 1) * step).toISOString()
}

export function dueNow(schedules: readonly ScheduleDefinition[], now: Date): ScheduleDefinition[] {
  const at = now.getTime()
  return schedules.filter(schedule => schedule.enabled && schedule.nextDueAt !== null && Date.parse(schedule.nextDueAt) <= at)
}
