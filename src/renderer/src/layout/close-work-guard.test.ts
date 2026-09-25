import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneTab } from '../../../shared/models'
import type { SessionProjection } from '../../../shared/structured-agent'
import { answerCloseWork, CLOSE_UNDO_MS, closeWorkState, findWorkingTabs, guardTabClose, offerCloseUndo, settleUndo, subscribeCloseWork } from './close-work-guard'

const agent = (id: string, title = id): PaneTab => ({ id: 'tab-' + id, kind: 'agent', title, resourceId: id } as PaneTab)
const projection = (patch: Partial<SessionProjection>): SessionProjection => ({ phase: 'idle', items: [], ...patch } as SessionProjection)
const states: Record<string, SessionProjection | null> = {
  running: projection({ phase: 'running' }),
  approval: projection({ phase: 'waiting_approval' }),
  queued: projection({ phase: 'completed' as SessionProjection['phase'], queuedPrompts: [{ id: 'q1' }, { id: 'q2' }] as SessionProjection['queuedPrompts'] }),
  background: projection({ phase: 'completed' as SessionProjection['phase'], backgroundTasks: 1 }),
  settled: projection({ phase: 'completed' as SessionProjection['phase'] }),
  stopped: projection({ phase: 'interrupted', queuedPrompts: [{ id: 'q' }] as SessionProjection['queuedPrompts'] }),
  unreadable: null
}
const snapshot = async (id: string): Promise<SessionProjection | null> => { if (id === 'broken') throw new Error('gone'); return states[id] ?? null }

let unsubscribe: (() => void) | undefined
afterEach(() => { unsubscribe?.(); unsubscribe = undefined; if (closeWorkState().request) answerCloseWork(false); settleUndo(false); vi.useRealTimers() })

describe('closing a tab that is still working (FX17 confirm-close-working-tab)', () => {
  it('uses the tabs.close / quit rule and names the work', async () => {
    const tabs = ['running', 'approval', 'queued', 'background', 'settled', 'stopped'].map(id => agent(id))
    const working = await findWorkingTabs([...tabs, { id: 'code', kind: 'code', title: 'a.ts' } as PaneTab], snapshot)
    expect(working.map(item => [item.tab.resourceId, item.work])).toEqual([
      ['running', 'running a turn'], ['approval', 'waiting for your approval'], ['queued', '2 queued prompts'], ['background', '1 background task']
    ])
  })
  it('falls back to the tab activity phase when the conversation cannot be read', async () => {
    const phases: Record<string, string> = { 'tab-unreadable': 'working', 'tab-broken': 'idle' }
    const working = await findWorkingTabs([agent('unreadable'), agent('broken')], snapshot, tab => phases[tab.id] as never)
    expect(working.map(item => item.tab.resourceId)).toEqual(['unreadable'])
  })
  it('closes settled tabs without asking, and asks once with "Don\'t close" keeping them', async () => {
    const seen: string[] = []
    unsubscribe = subscribeCloseWork(state => { if (state.request) seen.push(state.request.message) })
    expect(await guardTabClose([agent('settled')], undefined, snapshot)).toEqual([])
    expect(seen).toEqual([])

    const kept = guardTabClose([agent('running', 'MAC mini as a Conductor node')], undefined, snapshot)
    await vi.waitFor(() => expect(closeWorkState().request).not.toBeNull())
    expect(seen).toEqual(['“MAC mini as a Conductor node” is still working — close and stop it?'])
    // A second close while the owner decides is declined, not stacked.
    expect(await guardTabClose([agent('approval')], undefined, snapshot)).toBeNull()
    answerCloseWork(false)
    expect(await kept).toBeNull()

    const closed = guardTabClose([agent('running'), agent('settled')], undefined, snapshot)
    await vi.waitFor(() => expect(closeWorkState().request?.closing).toBe(2))
    answerCloseWork(true)
    expect((await closed)?.map(item => item.tab.resourceId)).toEqual(['running'])
  })
  it('undo restores and never stops; a lapsed undo stops only tabs that stayed closed', () => {
    vi.useFakeTimers()
    const restore = vi.fn(), stop = vi.fn()
    const working = [{ tab: agent('running'), work: 'running a turn' }, { tab: agent('queued'), work: '2 queued prompts' }]
    offerCloseUndo(working, { restore, stop, stillClosed: () => true })
    expect(closeWorkState().undo?.message).toContain('2 working tabs')
    settleUndo(true)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
    expect(closeWorkState().undo).toBeNull()

    offerCloseUndo(working, { restore, stop, stillClosed: tab => tab.resourceId === 'running' })
    vi.advanceTimersByTime(CLOSE_UNDO_MS - 1)
    expect(stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(stop.mock.calls.map(([tab]) => tab.resourceId)).toEqual(['running'])
    expect(restore).toHaveBeenCalledTimes(1)
  })
  it('a newer close settles the older undo at once', () => {
    vi.useFakeTimers()
    const stop = vi.fn()
    offerCloseUndo([{ tab: agent('running'), work: 'running a turn' }], { restore: vi.fn(), stop, stillClosed: () => true })
    offerCloseUndo([{ tab: agent('approval'), work: 'waiting for your approval' }], { restore: vi.fn(), stop, stillClosed: () => true })
    expect(stop.mock.calls.map(([tab]) => tab.resourceId)).toEqual(['running'])
  })
})
