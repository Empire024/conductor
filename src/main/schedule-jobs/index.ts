import type { ScheduleDefinition, ScheduleOutcome } from '../../shared/schedules'

export interface ScheduleJobContext { schedule: ScheduleDefinition; now: Date; signal: AbortSignal }
export interface ScheduleJobResult {
  outcome: Exclude<ScheduleOutcome, 'running' | 'skipped' | 'failed'>
  detail: string
  digest?: string | null
  validUntil?: string | null
  artifactPath?: string | null
}
export type ScheduleJob = (context: ScheduleJobContext) => Promise<ScheduleJobResult>
export type ScheduleJobRegistry = Record<ScheduleDefinition['jobId'], ScheduleJob>
