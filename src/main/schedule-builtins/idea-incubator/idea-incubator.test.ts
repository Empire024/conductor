import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleExecutionContext } from '../../schedule-executor'
import { IdeaStore } from '../../ideas/store'
import { IDEA_INCUBATOR_BUILTIN, createIdeaIncubatorExecutor } from '.'

const OWNER = { kind: 'owner' as const }
let clock = new Date('2026-09-20T01:00:00.000Z')
const stores: IdeaStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); clock = new Date('2026-09-20T01:00:00.000Z') })
const context = {} as ScheduleExecutionContext

function fixture() {
  const store = new IdeaStore(':memory:', () => clock); stores.push(store)
  let job = 0
  const explore = vi.fn(async (ideaId: string, intensity: 'light' | 'explore') => store.startExploration({ ideaId, jobId: `job_${++job}`, projectId: 'p', model: 'qwen', intensity, trigger: 'incubator' }))
  return { store, explore, execute: createIdeaIncubatorExecutor({ store, explore, now: () => clock }) }
}

describe('Idea Incubator', () => {
  it('is a night-time built-in with no scripts and no cloud agent', () => {
    expect(IDEA_INCUBATOR_BUILTIN).toMatchObject({ kind: 'idea-incubator', timing: 'night', brain: false, agent: null, scripts: [] })
  })

  it('explores the oldest untouched idea, one at a time, at most N per night', async () => {
    const { store, explore, execute } = fixture()
    const ideas = ['First untouched idea', 'Second untouched idea', 'Third untouched idea'].map(text => { const idea = store.capture({ text }, OWNER); clock = new Date(clock.getTime() + 60_000); return idea })
    store.setIncubatorSettings({ maxPerNight: 2 })
    clock = new Date(clock.getTime() + 30 * 60_000)

    expect(await execute(context)).toMatchObject({ outcome: 'dispatched', detail: expect.stringContaining('"First untouched idea"') })
    expect(explore).toHaveBeenLastCalledWith(ideas[0]!.id, 'light')
    expect(await execute(context)).toMatchObject({ outcome: 'unchanged', detail: expect.stringContaining('still running') })

    store.finishExploration(store.runningExplorations()[0]!.id, 'completed')
    expect(await execute(context)).toMatchObject({ outcome: 'dispatched' })
    expect(explore).toHaveBeenLastCalledWith(ideas[1]!.id, 'light')
    store.finishExploration(store.runningExplorations()[0]!.id, 'completed')
    expect(await execute(context)).toMatchObject({ outcome: 'unchanged', detail: expect.stringContaining('2 of at most 2') })

    clock = new Date(clock.getTime() + 21 * 60 * 60_000)
    expect(await execute(context)).toMatchObject({ outcome: 'dispatched' })
    expect(explore).toHaveBeenLastCalledWith(ideas[2]!.id, 'light')
  })

  it('does nothing when switched off or when nothing waits, and reports a refusal', async () => {
    const { store, explore, execute } = fixture()
    expect(await execute(context)).toMatchObject({ outcome: 'unchanged', detail: 'No untouched ideas are waiting.' })
    store.capture({ text: 'Some untouched idea' }, OWNER)
    clock = new Date(clock.getTime() + 30 * 60_000)
    store.setIncubatorSettings({ enabled: false })
    expect(await execute(context)).toMatchObject({ outcome: 'skipped' })
    store.setIncubatorSettings({ enabled: true })
    explore.mockRejectedValueOnce(new Error('No local model is configured'))
    expect(await execute(context)).toMatchObject({ outcome: 'skipped', detail: expect.stringContaining('No local model') })
  })
})
