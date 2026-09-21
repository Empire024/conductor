import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConductorDatabase } from './database'
import { ScheduleRunner } from './schedule-runner'
import { ScheduleStore } from './schedule-store'

const cleanup: Array<() => void> = []
afterEach(() => { vi.useRealTimers(); for (const dispose of cleanup.splice(0).reverse()) dispose() })
const fixture = (job: () => Promise<{outcome:'unchanged';detail:string}>) => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-runner-')), path = join(root, 'state.db')
  const database = new ConductorDatabase(path), project = database.upsertProject(root, 'Runner'), store = new ScheduleStore(path)
  const schedule = store.create({ projectId: project.id, jobId: 'latest-models-methods', everyMinutes: 5 }, new Date('2026-09-21T10:00:00Z'))
  const runner = new ScheduleRunner({ store, jobs: { 'latest-models-methods': job } })
  cleanup.push(() => { runner.stop(); store.close(); database.close(); rmSync(root, { recursive: true, force: true }) })
  return { store, project, schedule, runner }
}

describe('ScheduleRunner', () => {
  it('records overlap as skipped instead of starting a second execution', async () => {
    let release!: () => void
    const job = vi.fn(() => new Promise<{outcome:'unchanged';detail:string}>(resolve => { release = () => resolve({ outcome: 'unchanged', detail: 'same' }) }))
    const f = fixture(job)
    f.runner.runNow(f.project.id, f.schedule.id, new Date('2026-09-21T10:00:00Z'))
    await vi.waitFor(() => expect(job).toHaveBeenCalledOnce())
    const skipped = f.runner.runNow(f.project.id, f.schedule.id, new Date('2026-09-21T10:01:00Z'))
    expect(skipped.outcome).toBe('skipped')
    expect(job).toHaveBeenCalledOnce()
    release(); await vi.waitFor(() => expect(f.store.runs(f.schedule.id)[1]?.outcome).toBe('unchanged'))
  })

  it('does not release the global slot at timeout while an abort-ignoring job still runs', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const job = vi.fn(() => new Promise<{outcome:'unchanged';detail:string}>(resolve => { release = () => resolve({ outcome: 'unchanged', detail: 'late' }) }))
    const f = fixture(job)
    f.runner.runNow(f.project.id, f.schedule.id, new Date('2026-09-21T10:00:00Z'))
    await vi.advanceTimersByTimeAsync(120_001)
    expect(f.store.runs(f.schedule.id).find(run => run.startedAt === '2026-09-21T10:00:00.000Z')?.outcome).toBe('failed')
    const blocked = f.runner.runNow(f.project.id, f.schedule.id, new Date('2026-09-21T10:03:00Z'))
    expect(blocked.outcome).toBe('skipped')
    expect(job).toHaveBeenCalledOnce()
    release(); await vi.runAllTimersAsync()
    f.runner.runNow(f.project.id, f.schedule.id, new Date('2026-09-21T10:04:00Z'))
    await Promise.resolve()
    expect(job).toHaveBeenCalledTimes(2)
    release()
  })
})
