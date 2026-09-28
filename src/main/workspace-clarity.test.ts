import { describe, expect, it } from 'vitest'
import { emptyProjection } from '../shared/structured-agent-reducer'
import type { PaneTab } from '../shared/models'
import type { SessionProjection, TimelineItem } from '../shared/structured-agent'
import { FINISHED_TAB_SWEEP_SETTING } from '../shared/workspace-clarity'
import type { FinishTarget } from './coworker-autoclose'
import { FinishedTabs, agentTabFacts, findLayoutTab, settledAt, type LayoutTab } from './workspace-clarity'

const HOUR = 3_600_000
const NOW = Date.parse('2026-09-28T12:00:00Z')
const iso = (hoursAgo: number): string => new Date(NOW - hoursAgo * HOUR).toISOString()
const item = (sequence: number, hoursAgo: number, data: TimelineItem['data'] = { type: 'text', role: 'assistant', text: 'done', mode: 'snapshot' }): TimelineItem => ({ id: 'i' + sequence, runtimeId: 'r', sequence, timestamp: iso(hoursAgo), data })

function fixture() {
  const settings = new Map<string, string>()
  const states = new Map<string, SessionProjection>()
  const targets = new Map<string, FinishTarget>(), layout = new Map<string, LayoutTab>()
  const closed: string[] = []
  const service = new FinishedTabs({
    settings: { getSetting: key => settings.get(key) ?? null },
    snapshot: id => states.get(id) ?? null,
    targets: () => [...targets.values()],
    layoutTab: target => layout.get(target.tabId),
    close: async target => { closed.push(target.tabId); targets.delete(target.agentSessionId) },
    now: () => NOW
  })
  /** A finished conversation whose last item arrived `hoursAgo`, in a tab not on screen. */
  const add = (id: string, hoursAgo: number, change: { target?: Partial<FinishTarget>; state?: Partial<SessionProjection>; tab?: Partial<PaneTab>; active?: boolean } = {}) => {
    targets.set(id, { agentSessionId: id, projectId: 'p', sessionId: 'w', tabId: 'tab-' + id, title: 'Tab ' + id, provider: 'claude', controller: null, opened: false, wizard: false, controlsLiveCoworkers: false, remote: false, ...change.target })
    states.set(id, { ...emptyProjection('claude'), phase: 'completed', sequence: 3, items: [item(1, hoursAgo + 1), item(2, hoursAgo)], ...change.state })
    layout.set('tab-' + id, { tab: { id: 'tab-' + id, kind: 'agent', title: 'Tab ' + id, resourceId: id, ...change.tab }, active: change.active ?? false })
  }
  return { service, settings, states, add, closed, layout }
}

describe('settledAt and agentTabFacts', () => {
  it('is the newest item time once settled, and nothing while it works or before it ran', () => {
    const state = { ...emptyProjection('claude'), phase: 'completed' as const, items: [item(2, 1), item(1, 5)] }
    expect(settledAt(state)).toBe(iso(1))
    expect(settledAt({ ...state, phase: 'running' })).toBeUndefined()
    expect(settledAt(emptyProjection('claude'))).toBeUndefined()
  })
  it('reads live work, waiting and a succession notice', () => {
    const base = { ...emptyProjection('claude'), items: [item(1, 1)] }
    expect(agentTabFacts({ ...base, phase: 'running' }, false)).toEqual({ wizard: false, handedOff: false, live: 'running' })
    expect(agentTabFacts({ ...base, phase: 'waiting_approval' }, true)).toEqual({ wizard: true, handedOff: false, live: 'waiting' })
    const handed = { ...base, phase: 'completed' as const, items: [item(1, 2), item(2, 1, { type: 'notice', message: 'Continued', payload: { succession: { agentSessionId: 'b', title: 'B' } } } as TimelineItem['data'])] }
    expect(agentTabFacts(handed, false)).toEqual({ wizard: false, handedOff: true, settledAt: iso(1) })
  })
})

describe('findLayoutTab', () => {
  it('finds a tab in a split and says whether it is on screen in its pane', () => {
    const root = { type: 'split' as const, id: 's', direction: 'horizontal' as const, sizes: [50, 50] as [number, number], children: [
      { type: 'group' as const, id: 'a', tabs: [{ id: 'x', kind: 'agent' as const, title: 'x' }], activeTabId: 'x' },
      { type: 'group' as const, id: 'b', tabs: [{ id: 'y', kind: 'agent' as const, title: 'y' }, { id: 'z', kind: 'agent' as const, title: 'z' }], activeTabId: 'y' }
    ] as [never, never] }
    expect(findLayoutTab(root, 'z')).toMatchObject({ tab: { id: 'z' }, active: false })
    expect(findLayoutTab(root, 'x')?.active).toBe(true)
    expect(findLayoutTab(root, 'missing')).toBeUndefined()
  })
})

describe('FinishedTabs sweep', () => {
  it('closes finished tabs settled and unseen for a day, by default', async () => {
    const f = fixture()
    f.add('old', 30)
    f.add('recent', 2)
    f.add('seen', 30, { tab: { state: { seenAt: iso(3) } } })
    f.add('onscreen', 30, { active: true })
    f.add('pinned', 30, { tab: { state: { pinned: true } } })
    f.add('wizard', 30, { target: { wizard: true } })
    f.add('lead', 30, { target: { controlsLiveCoworkers: true } })
    f.add('running', 30, { state: { phase: 'running' } })
    f.add('waiting', 30, { state: { phase: 'waiting_input' } })
    f.add('remote', 30, { target: { remote: true } })
    await f.service.sweep()
    expect(f.closed).toEqual(['tab-old'])
  })
  it('follows the owner setting, and Off closes nothing', async () => {
    const f = fixture()
    f.add('six', 6)
    f.settings.set(FINISHED_TAB_SWEEP_SETTING, '4')
    await f.service.sweep()
    expect(f.closed).toEqual(['tab-six'])
    const off = fixture()
    off.add('old', 500)
    off.settings.set(FINISHED_TAB_SWEEP_SETTING, '0')
    await off.service.sweep()
    expect(off.closed).toEqual([])
  })
  it('never closes a tab with no conversation state or one that never ran', async () => {
    const f = fixture()
    f.add('fresh', 30, { state: { phase: 'idle', items: [] } })
    await f.service.sweep()
    expect(f.closed).toEqual([])
  })
})

describe('FinishedTabs.closeFinished (the owner button)', () => {
  it('closes every confirmed finished tab regardless of age or focus, and names what it kept', async () => {
    const f = fixture()
    f.add('a', 0.1, { active: true })
    f.add('b', 0.1)
    f.add('running', 1, { state: { phase: 'running' } })
    f.add('pinned', 1, { tab: { state: { pinned: true } } })
    f.add('unasked', 1)
    const result = await f.service.closeFinished('p', 'w', ['tab-a', 'tab-b', 'tab-running', 'tab-pinned'])
    expect(f.closed).toEqual(['tab-a', 'tab-b'])
    expect(result.closed).toBe(2)
    expect(result.kept).toEqual([
      { tabId: 'tab-running', title: 'Tab running', reason: 'its turn is still running' },
      { tabId: 'tab-pinned', title: 'Tab pinned', reason: 'it is pinned' }
    ])
  })
  it('closes a finished controller together with its finished coworkers', async () => {
    const f = fixture()
    f.add('lead', 1, { target: { controlsLiveCoworkers: true } })
    f.add('worker', 1, { target: { controller: 'lead' } })
    // What AgentControl.finishTargets reports once the worker's tab is gone.
    const service = new FinishedTabs({
      settings: { getSetting: () => null }, snapshot: id => f.states.get(id) ?? null, now: () => NOW,
      targets: () => [
        ...(f.closed.includes('tab-lead') ? [] : [{ agentSessionId: 'lead', projectId: 'p', sessionId: 'w', tabId: 'tab-lead', title: 'Lead', controller: null, opened: false, wizard: false, controlsLiveCoworkers: !f.closed.includes('tab-worker'), remote: false }]),
        ...(f.closed.includes('tab-worker') ? [] : [{ agentSessionId: 'worker', projectId: 'p', sessionId: 'w', tabId: 'tab-worker', title: 'Worker', controller: 'lead', opened: true, wizard: false, controlsLiveCoworkers: false, remote: false }])
      ],
      layoutTab: target => f.layout.get(target.tabId),
      close: async target => { f.closed.push(target.tabId) }
    })
    expect(await service.closeFinished('p', 'w', ['tab-lead', 'tab-worker'])).toEqual({ closed: 2, kept: [] })
    expect(f.closed).toEqual(['tab-worker', 'tab-lead'])
  })
  it('closes a wizard that failed or handed off, never a live one', async () => {
    const f = fixture()
    f.add('failed', 1, { target: { wizard: true }, state: { phase: 'failed' } })
    f.add('live', 1, { target: { wizard: true } })
    const result = await f.service.closeFinished('p', 'w', ['tab-failed', 'tab-live'])
    expect(f.closed).toEqual(['tab-failed'])
    expect(result.kept).toEqual([{ tabId: 'tab-live', title: 'Tab live', reason: 'it is the live wizard' }])
  })
  it('only touches the named workspace', async () => {
    const f = fixture()
    f.add('a', 1, { target: { sessionId: 'other' } })
    expect(await f.service.closeFinished('p', 'w', ['tab-a'])).toEqual({ closed: 0, kept: [] })
  })
})
