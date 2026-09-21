import { dueNow, type ScheduleDefinition, type ScheduleRun } from '../shared/schedules'
import type { ScheduleJobRegistry } from './schedule-jobs'
import type { ScheduleStore } from './schedule-store'

export class ScheduleRunner {
  private timer: NodeJS.Timeout | null = null
  private active: { runId: string; scheduleId: string; controller: AbortController; promise: Promise<void> } | null = null

  constructor(private readonly options: {
    store: ScheduleStore
    jobs: ScheduleJobRegistry
    now?: () => Date
    changed?: (projectId: string) => void
  }) {}

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), 30_000)
    this.timer.unref?.()
  }

  /** Stop accepting work and request cancellation. The execution slot stays occupied until the job settles. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.active?.controller.abort(new Error('Schedule runner stopped'))
  }

  tick(now = this.options.now?.() ?? new Date()): void {
    const activeIds = new Set(this.active ? [this.active.runId] : [])
    this.options.store.reconcileInterrupted(now, activeIds)
    const due = dueNow(this.allSchedules(), now)
    for (const schedule of due) {
      if (this.active) {
        this.options.store.recordSkipped(schedule, now, `Skipped because ${this.active.scheduleId === schedule.id ? 'its previous execution' : 'another scheduled job'} is still running.`)
        this.options.changed?.(schedule.projectId)
      } else this.launch(schedule, now)
    }
  }

  runNow(projectId: string, scheduleId: string, now = this.options.now?.() ?? new Date()): ScheduleRun {
    const schedule = this.options.store.get(projectId, scheduleId)
    if (this.active) {
      const skipped = this.options.store.recordSkipped(schedule, now, 'Skipped because another scheduled job is still running.')
      this.options.changed?.(projectId)
      return skipped
    }
    return this.launch(schedule, now)
  }

  private allSchedules(): ScheduleDefinition[] {
    // ScheduleStore owns project validation; its due query is intentionally exposed as per-project
    // snapshots elsewhere, so the runner asks SQLite through the projects already represented.
    return this.options.store.all()
  }

  private launch(schedule: ScheduleDefinition, now: Date): ScheduleRun {
    const run = this.options.store.begin(schedule, now)
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`Scheduled job exceeded ${schedule.timeoutMs} ms`))
      this.options.store.finish(run.id, 'failed', `Timed out after ${schedule.timeoutMs} ms. The execution slot remains reserved until the underlying job stops.`)
      this.options.changed?.(schedule.projectId)
    }, schedule.timeoutMs)
    timeout.unref?.()

    const job = this.options.jobs[schedule.jobId]
    const promise = Promise.resolve()
      .then(() => job({ schedule, now, signal: controller.signal }))
      .then(result => {
        if (!timedOut) this.options.store.finish(run.id, result.outcome, result.detail, result)
      })
      .catch(reason => {
        if (!timedOut) this.options.store.finish(run.id, 'failed', reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        clearTimeout(timeout)
        if (this.active?.runId === run.id) this.active = null
        this.options.changed?.(schedule.projectId)
      })
    this.active = { runId: run.id, scheduleId: schedule.id, controller, promise }
    this.options.changed?.(schedule.projectId)
    return run
  }
}
