import { dueNow, type ScheduleDefinition, type ScheduleGateVerdict, type ScheduleRun } from '../shared/schedules'
import type { ScheduleExecutor } from './schedule-executor'
import { decideScheduleGate, type ScheduleGateSignals } from './schedule-gate'
import type { ScheduleStore } from './schedule-store'

/**
 * Starts scheduled task runs: at most one at a time, only when due, and only when the gate
 * (src/main/schedule-gate.ts) says this is a good window. A due run the gate holds back is not a
 * failed or skipped run; the task records why it waits and the runner looks again at the gate's
 * retry time, so a machine that stays busy costs one probe per few minutes, not one per tick.
 * Asking to run a task now is the owner's (or an agent's for the owner) explicit request and
 * skips the gate, but never the one-at-a-time rule.
 */

export interface ScheduleRunnerOptions {
  store: ScheduleStore
  execute: ScheduleExecutor
  /** Measures the machine once per tick with due work; absent means always allowed (tests). */
  signals?: () => Promise<ScheduleGateSignals>
  decide?: (schedule: ScheduleDefinition, signals: ScheduleGateSignals) => ScheduleGateVerdict
  now?: () => Date
  changed?: (projectId: string) => void
  tickMs?: number
}

const WAITING_FOR_ANOTHER = 'Waiting for another scheduled task to finish.'

export class ScheduleRunner {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private stopped = false
  private active: { runId: string; scheduleId: string; startedAt: string; controller: AbortController; promise: Promise<void> } | null = null
  private readonly retryAt = new Map<string, number>()
  private verdict: ScheduleGateVerdict | null = null

  constructor(private readonly options: ScheduleRunnerOptions) {}

  start(): void {
    if (this.timer) return
    this.stopped = false
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 30_000)
    this.timer.unref?.()
  }

  /** Stop accepting work and request cancellation. The execution slot stays occupied until the job settles. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.stopped = true
    this.active?.controller.abort(new Error('Schedule runner stopped'))
  }

  lastVerdict(): ScheduleGateVerdict | null { return this.verdict }
  running(): { scheduleId: string; runId: string; startedAt: string } | null {
    return this.active ? { scheduleId: this.active.scheduleId, runId: this.active.runId, startedAt: this.active.startedAt } : null
  }
  /** A task whose cadence or timing changed is looked at again on the next tick. */
  forget(scheduleId: string): void { this.retryAt.delete(scheduleId) }

  async tick(now = this.options.now?.() ?? new Date()): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const activeIds = new Set(this.active ? [this.active.runId] : [])
      for (const run of this.options.store.reconcileInterrupted(now, activeIds)) this.notify(run.scheduleId)
      const all = this.options.store.all()
      const due = dueNow(all, now)
      for (const id of [...this.retryAt.keys()]) if (!due.some(schedule => schedule.id === id)) this.retryAt.delete(id)
      if (!due.length) return
      if (this.active) {
        for (const schedule of due) if (schedule.id !== this.active.scheduleId && this.options.store.defer(schedule.id, WAITING_FOR_ANOTHER, now)) this.options.changed?.(schedule.projectId)
        return
      }
      const ready = due
        .filter(schedule => (this.retryAt.get(schedule.id) ?? 0) <= now.getTime())
        .sort((a, b) => Number(b.urgent) - Number(a.urgent) || Date.parse(a.nextDueAt!) - Date.parse(b.nextDueAt!))
      if (!ready.length) return
      const signals = this.options.signals ? await this.options.signals() : null
      if (this.stopped) return
      const decide = this.options.decide ?? decideScheduleGate
      for (const schedule of ready) {
        const verdict = signals ? decide(schedule, signals) : { allowed: true, reason: 'No machine measurements are configured.', signals: [], checkedAt: now.toISOString(), retryAt: null }
        this.verdict = verdict
        if (!verdict.allowed) {
          const retry = Date.parse(verdict.retryAt ?? '') || now.getTime() + 5 * 60_000
          this.retryAt.set(schedule.id, Math.max(retry, now.getTime() + 60_000))
          if (this.options.store.defer(schedule.id, verdict.reason, now)) this.options.changed?.(schedule.projectId)
          continue
        }
        this.retryAt.delete(schedule.id)
        // The measurement took a few seconds; the task may have been paused or edited meanwhile.
        const current = this.options.store.all().find(candidate => candidate.id === schedule.id)
        if (current && dueNow([current], now).length) this.launch(current, now, 'schedule')
        return
      }
    } catch (error) {
      console.warn('Scheduled task tick failed', error)
    } finally { this.ticking = false }
  }

  runNow(projectId: string, scheduleId: string, now = this.options.now?.() ?? new Date()): ScheduleRun {
    const schedule = this.options.store.get(projectId, scheduleId)
    if (this.active) {
      const skipped = this.options.store.recordSkipped(schedule, now, `Skipped because ${this.active.scheduleId === schedule.id ? 'its previous run' : 'another scheduled task'} is still running.`, 'manual')
      this.options.changed?.(projectId)
      return skipped
    }
    this.retryAt.delete(scheduleId)
    return this.launch(schedule, now, 'manual')
  }

  private notify(scheduleId: string): void {
    const schedule = this.options.store.all().find(candidate => candidate.id === scheduleId)
    if (schedule) this.options.changed?.(schedule.projectId)
  }

  private launch(schedule: ScheduleDefinition, now: Date, trigger: ScheduleRun['trigger']): ScheduleRun {
    const run = this.options.store.begin(schedule, now, trigger)
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`Scheduled task exceeded ${schedule.timeoutMs} ms`))
      this.options.store.finish(run.id, 'failed', `Timed out after ${Math.round(schedule.timeoutMs / 60_000)} minutes. The execution slot stays reserved until the run actually stops.`)
      this.options.changed?.(schedule.projectId)
    }, schedule.timeoutMs)
    timeout.unref?.()

    const promise = Promise.resolve()
      .then(() => this.options.execute({ schedule, run, now, signal: controller.signal, deadline: now.getTime() + schedule.timeoutMs }))
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
    this.active = { runId: run.id, scheduleId: schedule.id, startedAt: run.startedAt, controller, promise }
    this.options.changed?.(schedule.projectId)
    return run
  }
}
