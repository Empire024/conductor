import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConductorDatabase } from './database'
import { ScheduleStore } from './schedule-store'

const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-schedules-')), path = join(root, 'state.db')
  const database = new ConductorDatabase(path), project = database.upsertProject(root, 'Schedules')
  const store = new ScheduleStore(path)
  cleanup.push(() => { store.close(); database.close(); rmSync(root, { recursive: true, force: true }) })
  return { store, project }
}

describe('ScheduleStore', () => {
  it('persists controls, run evidence, and only the newest 50 history rows', () => {
    const { store, project } = fixture()
    const schedule = store.create({ projectId: project.id, jobId: 'latest-models-methods', everyMinutes: 60 }, new Date('2026-09-21T10:00:00Z'))
    expect(schedule.nextDueAt).toBe('2026-09-21T11:00:00.000Z')
    for (let index = 0; index < 52; index++) {
      const run = store.begin(store.get(project.id, schedule.id), new Date(Date.parse('2026-09-21T11:00:00Z') + index * 60_000))
      store.finish(run.id, 'unchanged', 'No source changed')
    }
    expect(store.runs(schedule.id)).toHaveLength(50)
    expect(store.update(project.id, schedule.id, { enabled: false }).nextDueAt).toBeNull()
  })

  it('reconciles abandoned running evidence after its timeout', () => {
    const { store, project } = fixture()
    const schedule = store.create({ projectId: project.id, jobId: 'latest-models-methods' }, new Date('2026-09-21T10:00:00Z'))
    const run = store.begin(schedule, new Date('2026-09-21T10:00:00Z'))
    expect(store.reconcileInterrupted(new Date('2026-09-21T10:03:00Z'))).toEqual([expect.objectContaining({ id: run.id, outcome: 'failed' })])
  })

  it('seeds the built-in daily check once and preserves an owner disable', () => {
    const { store, project } = fixture()
    const seeded = store.ensureLatestModelsSchedule(project.id, new Date('2026-09-21T10:00:00Z'))
    expect(seeded).toMatchObject({ enabled: true, everyMinutes: 1_440 })
    store.update(project.id, seeded.id, { enabled: false })
    expect(store.ensureLatestModelsSchedule(project.id).enabled).toBe(false)
    expect(store.list(project.id)).toHaveLength(1)
  })
})
