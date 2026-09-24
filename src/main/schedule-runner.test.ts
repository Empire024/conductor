import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleDefinition, ScheduleGateVerdict } from '../shared/schedules'
import { ConductorDatabase } from './database'
import type { ScheduleExecutionResult, ScheduleExecutor } from './schedule-executor'
import type { ScheduleGateSignals } from './schedule-gate'
import { ScheduleRunner } from './schedule-runner'
import { ScheduleStore } from './schedule-store'

const cleanup: Array<() => void> = []
afterEach(() => { vi.useRealTimers(); for (const dispose of cleanup.splice(0).reverse()) dispose() })

const unchanged: ScheduleExecutionResult = { outcome: 'unchanged', detail: 'same' }
const signals = (): ScheduleGateSignals => ({ now: new Date(), ownerIdleSeconds: 0, screenLocked: false, metrics: null, conductorTurns: 0, smokeRunning: false, deliveryRunning: false, localUpdateBuilding: false, durableJobsRunning: 0 })
const fixture = (execute: ScheduleExecutor, gate?: { decide: (schedule: ScheduleDefinition) => ScheduleGateVerdict }) => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-runner-')), path = join(root, 'state.db')
  const database = new ConductorDatabase(path), project = database.upsertProject(root, 'Runner'), store = new ScheduleStore(path)
  const schedule = store.create({ projectId: project.id, name: 'Nightly check', everyMinutes: 60, timeoutMs: 120_000 }, new Date('2026-09-21T10:00:00Z'))
  const changed = vi.fn()
  const probe = vi.fn(async () => signals())
  const runner = new ScheduleRunner({ store, execute, changed, ...(gate ? { signals: probe, decide: gate.decide } : {}) })
  cleanup.push(() => { runner.stop(); store.close(); database.close(); rmSync(root, { recursive: true, force: true }) })
  return { store, project, schedule, runner, changed, probe }
}
const verdict = (allowed: boolean, reason: string, retryAt: string | null = null): ScheduleGateVerdict => ({ allowed, reason, signals: [], checkedAt: '2026-09-21T10:00:00.000Z', retryAt })

describe('ScheduleRunner', () => {
  it('records overlap on an explicit run as skipped instead of starting a second execution', async () => {
    let release!: () => void
    const execute = vi.fn(() => new Promise<ScheduleExecutionResult>(resolve => { release = () => resolve(unchanged) }))
    const f = fixture(execute)
    f.runner.runNow(f.project.id, f.schedule.id, new Date('2026-09-21T10:00:00Z'))
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    expect(f.runner.running()).toMatchObject({ scheduleId: f.schedule.id })
    const skipped = f.runner.runNow(f.project.id, f.schedule.id, new Date('2026-09-21T10:01:00Z'))
    expect(skipped).toMatchObject({ outcome: 'skipped', trigger: 'manual' })
    expect(execute).toHaveBeenCalledOnce()
    release(); await vi.waitFor(() => expect(f.store.runs(f.schedule.id)[1]?.outcome).toBe('unchanged'))
    expect(f.runner.running()).toBeNull()
  })

  it('does not release the global slot at timeout while an abort-ignoring run still executes', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const execute = vi.fn(() => new Promise<ScheduleExecutionResult>(resolve => { release = () => resolve({ outcome: 'unchanged', detail: 'late' }) }))
    const f = fixture(execute)
    f.runner.runNow(f.project.id, f.schedule.id, new Date('2026-09-21T10:00:00Z'))
    await vi.advanceTimersByTimeAsync(120_001)
    expect(f.store.runs(f.schedule.id).find(run => run.startedAt === '2026-09-21T10:00:00.000Z')?.outcome).toBe('failed')
    const blocked = f.runner.runNow(f.project.id, f.schedule.id, new Date('2026-09-21T10:03:00Z'))
    expect(blocked.outcome).toBe('skipped')
    expect(execute).toHaveBeenCalledOnce()
    release(); await vi.runAllTimersAsync()
    f.runner.runNow(f.project.id, f.schedule.id, new Date('2026-09-21T10:04:00Z'))
    await Promise.resolve()
    expect(execute).toHaveBeenCalledTimes(2)
    release()
  })

  it('holds a due task back while the gate refuses, says why, and asks again only at the retry time', async () => {
    const execute = vi.fn(async () => unchanged)
    let allowed = false
    const f = fixture(execute, { decide: () => allowed ? verdict(true, 'You are away and the machine is idle.') : verdict(false, 'You are using this computer (last input 1 min ago).', '2026-09-21T10:05:00.000Z') })
    await f.runner.tick(new Date('2026-09-21T10:00:30Z'))
    expect(execute).not.toHaveBeenCalled()
    expect(f.store.runs(f.schedule.id)).toEqual([])
    expect(f.store.get(f.project.id, f.schedule.id)).toMatchObject({ deferredReason: 'You are using this computer (last input 1 min ago).', deferredAt: '2026-09-21T10:00:30.000Z' })
    expect(f.runner.lastVerdict()).toMatchObject({ allowed: false })
    expect(f.changed).toHaveBeenCalledWith(f.project.id)
    allowed = true
    await f.runner.tick(new Date('2026-09-21T10:02:00Z'))
    expect(f.probe).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    await f.runner.tick(new Date('2026-09-21T10:05:00Z'))
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(f.store.runs(f.schedule.id)[0]).toMatchObject({ outcome: 'unchanged', trigger: 'schedule' }))
    expect(f.store.get(f.project.id, f.schedule.id)).toMatchObject({ deferredReason: null, nextDueAt: '2026-09-21T11:00:00.000Z' })
  })

  it('runs urgent work first and makes the rest wait for it, one run at a time', async () => {
    let release!: () => void
    const started: string[] = []
    const execute = vi.fn(({ schedule }: { schedule: ScheduleDefinition }) => { started.push(schedule.name); return new Promise<ScheduleExecutionResult>(resolve => { release = () => resolve(unchanged) }) })
    const f = fixture(execute, { decide: () => verdict(true, 'ok') })
    const urgent = f.store.create({ projectId: f.project.id, name: 'Urgent check', urgent: true }, new Date('2026-09-21T10:30:00Z'))
    await f.runner.tick(new Date('2026-09-21T10:31:00Z'))
    expect(started).toEqual(['Urgent check'])
    await f.runner.tick(new Date('2026-09-21T10:32:00Z'))
    expect(started).toEqual(['Urgent check'])
    expect(f.store.get(f.project.id, f.schedule.id).deferredReason).toBe('Waiting for another scheduled task to finish.')
    release(); await vi.waitFor(() => expect(f.runner.running()).toBeNull())
    await f.runner.tick(new Date('2026-09-21T10:33:00Z'))
    expect(started).toEqual(['Urgent check', 'Nightly check'])
    release()
    void urgent
  })

  it('never starts a paused task, even when it was due', async () => {
    const execute = vi.fn(async () => unchanged)
    const f = fixture(execute, { decide: () => verdict(true, 'ok') })
    f.store.update(f.project.id, f.schedule.id, { enabled: false })
    await f.runner.tick(new Date('2026-09-21T12:00:00Z'))
    expect(execute).not.toHaveBeenCalled()
    expect(f.probe).not.toHaveBeenCalled()
  })
})
