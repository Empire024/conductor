import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyProjection } from '../shared/structured-agent-reducer'
import type { AgentSpec } from '../shared/models'
import type { DeliveryRun } from '../shared/delivery'
import type { SessionProjection } from '../shared/structured-agent'
import { COWORKER_AUTOCLOSE_SETTING, COWORKER_DELIVERED_PREFIX, COWORKER_OPENED_PREFIX, CoworkerAutoClose, coworkerAutoCloseMinutes, normalizeCoworkerAutoCloseMinutes, unsettledReason, type FinishTarget } from './coworker-autoclose'

const MINUTE = 60_000

function fixture() {
  const settings = new Map<string, string>()
  const states = new Map<string, SessionProjection>()
  const tabs = new Map<string, FinishTarget>()
  const live = new Set<string>(), providers = new Map<string, string>()
  const closed: string[] = [], notices: Array<[string, string]> = []
  let refuse: string | null = null
  const store = { getSetting: (key: string) => settings.get(key) ?? null, setSetting: (key: string, value: string) => { settings.set(key, value) }, removeSetting: (key: string) => { settings.delete(key) } }
  const service = new CoworkerAutoClose({
    settings: store,
    snapshot: id => states.get(id) ?? null,
    targets: () => [...tabs.values()],
    close: async target => {
      if (refuse) throw new Error(refuse)
      closed.push(target.agentSessionId); tabs.delete(target.agentSessionId)
    },
    release: select => { for (const id of [...live]) if (select({ id, provider: providers.get(id) ?? 'claude' } as AgentSpec)) live.delete(id) },
    notice: (id, message) => { notices.push([id, message]) },
    now: () => Date.now()
  })
  const add = (id: string, change: Partial<FinishTarget> = {}, state: Partial<SessionProjection> = {}) => {
    tabs.set(id, { agentSessionId: id, projectId: 'p', sessionId: 'w', tabId: 'tab-' + id, title: 'Worker ' + id, provider: 'claude', controller: 'controller', opened: true, wizard: false, controlsLiveCoworkers: false, remote: false, ...change })
    states.set(id, { ...emptyProjection('claude'), phase: 'completed', sequence: 5, ...state })
    live.add(id); providers.set(id, change.provider ?? 'claude')
    if (change.opened !== false) settings.set(COWORKER_OPENED_PREFIX + id, 'controller')
  }
  const deliver = (id: string) => service.noteDelivery({ state: 'delivered', requestedBy: { kind: 'agent', agentSessionId: id, title: 'Worker' }, finishedAt: new Date().toISOString() } as DeliveryRun)
  return { service, settings, states, tabs, live, closed, notices, add, deliver, refuse: (why: string | null) => { refuse = why } }
}

/** Two sweeps a timeout apart: the first sees it settled, the second finds it idle long enough. */
async function idlePast(f: ReturnType<typeof fixture>, minutes = 10) {
  await f.service.sweep()
  vi.advanceTimersByTime(minutes * MINUTE)
  await f.service.sweep()
}

describe('coworker auto-close', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-25T10:00:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  it('names why a conversation is not settled', () => {
    expect(unsettledReason({ ...emptyProjection('claude'), phase: 'running' })).toMatch(/still running/)
    expect(unsettledReason({ ...emptyProjection('claude'), phase: 'waiting_approval' })).toMatch(/approval/)
    expect(unsettledReason({ ...emptyProjection('claude'), phase: 'completed', backgroundTasks: 2 })).toMatch(/2 background tasks/)
    expect(unsettledReason({ ...emptyProjection('claude'), phase: 'completed', limitResumeAt: '2026-09-25T12:00:00Z' })).toMatch(/usage limit/)
    expect(unsettledReason({ ...emptyProjection('claude'), phase: 'completed' })).toBeNull()
  })

  it('reads the setting with a ten-minute default and Off as 0', () => {
    expect(coworkerAutoCloseMinutes(() => null)).toBe(10)
    expect(coworkerAutoCloseMinutes(() => '0')).toBe(0)
    expect(coworkerAutoCloseMinutes(() => '30')).toBe(30)
    expect(coworkerAutoCloseMinutes(() => '7')).toBe(10)
    expect(normalizeCoworkerAutoCloseMinutes(5)).toBe(5)
    expect(() => normalizeCoworkerAutoCloseMinutes(7)).toThrow(/Choose one of/)
  })

  describe('agents.finish by the controller', () => {
    it('refuses while the coworker is running or has background tasks, naming why', async () => {
      const f = fixture()
      f.add('running', {}, { phase: 'running' })
      f.add('background', {}, { backgroundTasks: 1 })
      await expect(f.service.finish(f.tabs.get('running')!)).rejects.toThrow(/cannot be finished yet: its turn is still running/)
      await expect(f.service.finish(f.tabs.get('background')!)).rejects.toThrow(/1 background task still running/)
      expect(f.closed).toEqual([])
      expect([...f.live]).toEqual(['running', 'background'])
    })

    it('closes a settled coworker at once and releases its runtime', async () => {
      const f = fixture()
      f.add('done')
      const result = await f.service.finish(f.tabs.get('done')!)
      expect(result).toMatchObject({ finished: true, agentSessionId: 'done', tabId: 'tab-done' })
      expect(result.note).toMatch(/history kept/)
      expect(f.closed).toEqual(['done'])
      expect(f.live.has('done')).toBe(false)
      expect(f.settings.has(COWORKER_OPENED_PREFIX + 'done')).toBe(false)
    })

    it('never finishes a wizard tab or a controller with open coworkers', async () => {
      const f = fixture()
      f.add('wizard', { wizard: true })
      f.add('boss', { controlsLiveCoworkers: true })
      await expect(f.service.finish(f.tabs.get('wizard')!)).rejects.toThrow(/wizard tab/)
      await expect(f.service.finish(f.tabs.get('boss')!)).rejects.toThrow(/controls open coworkers/)
      expect(f.closed).toEqual([])
    })

    it('reports an unsent draft as the reason the tab stayed', async () => {
      const f = fixture()
      f.add('drafted'); f.refuse('it has an unsent draft')
      await expect(f.service.finish(f.tabs.get('drafted')!)).rejects.toThrow(/unsent draft/)
      expect(f.live.has('drafted')).toBe(true)
    })
  })

  describe('agents.finish({}) by the coworker itself', () => {
    it('waits for its own turn to settle, then closes and releases', async () => {
      const f = fixture()
      f.add('self', {}, { phase: 'running' })
      expect(f.service.requestSelfFinish(f.tabs.get('self')!)).toMatchObject({ finished: false })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(f.closed).toEqual([])
      f.states.set('self', { ...f.states.get('self')!, phase: 'completed' })
      await vi.advanceTimersByTimeAsync(2_500)
      expect(f.closed).toEqual(['self'])
      expect(f.live.has('self')).toBe(false)
    })

    it('still closes when the automatic timeout is Off', async () => {
      const f = fixture()
      f.settings.set(COWORKER_AUTOCLOSE_SETTING, '0')
      f.add('self')
      f.service.requestSelfFinish(f.tabs.get('self')!)
      await vi.advanceTimersByTimeAsync(2_500)
      expect(f.closed).toEqual(['self'])
    })

    it('is refused for the owner’s own tab, a wizard, a controller with coworkers and pending background tasks', () => {
      const f = fixture()
      f.add('owner', { controller: null, opened: false })
      f.add('wizard', { wizard: true })
      f.add('boss', { controlsLiveCoworkers: true })
      f.add('background', {}, { phase: 'running', backgroundTasks: 1 })
      expect(() => f.service.requestSelfFinish(f.tabs.get('owner')!)).toThrow(/owner’s own tab/)
      expect(() => f.service.requestSelfFinish(f.tabs.get('wizard')!)).toThrow(/wizard/)
      expect(() => f.service.requestSelfFinish(f.tabs.get('boss')!)).toThrow(/controls open coworkers/)
      expect(() => f.service.requestSelfFinish(f.tabs.get('background')!)).toThrow(/background task/)
    })

    it('tells the tab when a draft kept it open', async () => {
      const f = fixture()
      f.add('self'); f.refuse('it has an unsent draft')
      f.service.requestSelfFinish(f.tabs.get('self')!)
      await vi.advanceTimersByTimeAsync(2_500)
      expect(f.closed).toEqual([])
      expect(f.notices).toEqual([['self', expect.stringMatching(/kept .* open after agents.finish: it has an unsent draft/)]])
    })
  })

  describe('automatic close timer', () => {
    it('closes a delivered, settled coworker after ten idle minutes by default', async () => {
      const f = fixture()
      f.add('shipped'); f.deliver('shipped')
      await f.service.sweep()
      vi.advanceTimersByTime(9 * MINUTE)
      await f.service.sweep()
      expect(f.closed).toEqual([])
      vi.advanceTimersByTime(1 * MINUTE)
      await f.service.sweep()
      expect(f.closed).toEqual(['shipped'])
      expect(f.live.has('shipped')).toBe(false)
      expect(f.settings.has(COWORKER_DELIVERED_PREFIX + 'shipped')).toBe(false)
    })

    it('runs on its own interval once started', async () => {
      const f = fixture()
      f.add('shipped'); f.deliver('shipped')
      f.service.start()
      await vi.advanceTimersByTimeAsync(12 * MINUTE)
      expect(f.closed).toEqual(['shipped'])
      f.service.dispose()
    })

    it('restarts the idle clock when the conversation moves on', async () => {
      const f = fixture()
      f.add('shipped'); f.deliver('shipped')
      await f.service.sweep()
      vi.advanceTimersByTime(8 * MINUTE)
      f.states.set('shipped', { ...f.states.get('shipped')!, sequence: 9 })
      await f.service.sweep()
      vi.advanceTimersByTime(8 * MINUTE)
      await f.service.sweep()
      expect(f.closed).toEqual([])
      vi.advanceTimersByTime(2 * MINUTE)
      await f.service.sweep()
      expect(f.closed).toEqual(['shipped'])
    })

    it('leaves an undelivered coworker open', async () => {
      const f = fixture()
      f.add('unshipped')
      await idlePast(f, 30)
      expect(f.closed).toEqual([])
    })

    it('ignores deliveries that did not succeed or that the owner ran', () => {
      const f = fixture()
      f.service.noteDelivery({ state: 'failed', requestedBy: { kind: 'agent', agentSessionId: 'a', title: 'A' } } as DeliveryRun)
      f.service.noteDelivery({ state: 'delivered', requestedBy: { kind: 'owner' } } as DeliveryRun)
      expect(f.service.delivered('a')).toBe(false)
      f.deliver('a')
      expect(f.service.delivered('a')).toBe(true)
    })

    it.each([
      ['the owner’s own tab', { controller: null, opened: false }, {}],
      ['a tab a controller took over', { opened: false }, {}],
      ['a wizard tab', { wizard: true }, {}],
      ['a controller with live coworkers', { controlsLiveCoworkers: true }, {}],
      ['a tab on another machine', { remote: true }, {}],
      ['a tab waiting on an approval', {}, { phase: 'waiting_approval' }],
      ['a running turn', {}, { phase: 'running' }],
      ['a tab with background tasks', {}, { backgroundTasks: 1 }],
      ['a tab with a queued message', {}, { queuedPrompts: [{ id: 'q', text: 'next', settings: { permission: 'default', plan: false }, attachments: [] }] }]
    ] as Array<[string, Partial<FinishTarget>, Partial<SessionProjection>]>)('never closes %s', async (_label, change, state) => {
      const f = fixture()
      f.add('worker', change, state); f.deliver('worker')
      await idlePast(f, 60)
      expect(f.closed).toEqual([])
    })

    it('never closes a tab with an unsent draft, and asks again on the next pass', async () => {
      const f = fixture()
      f.add('drafted'); f.deliver('drafted'); f.refuse('it has an unsent draft')
      await idlePast(f)
      expect(f.closed).toEqual([])
      f.refuse(null)
      vi.advanceTimersByTime(MINUTE)
      await f.service.sweep()
      expect(f.closed).toEqual(['drafted'])
    })

    it('does nothing at all when the setting is Off', async () => {
      const f = fixture()
      f.settings.set(COWORKER_AUTOCLOSE_SETTING, '0')
      f.add('shipped'); f.deliver('shipped')
      f.add('owner', { controller: null, opened: false })
      await idlePast(f, 120)
      expect(f.closed).toEqual([])
      expect(f.live.size).toBe(2)
      expect(f.service.timeoutMs()).toBeNull()
    })
  })

  describe('idle CLI release', () => {
    it('releases a settled Claude or Codex runtime past the timeout and keeps the tab', async () => {
      const f = fixture()
      f.add('owner', { controller: null, opened: false })
      f.add('codex', { controller: null, opened: false, provider: 'codex' })
      await f.service.sweep()
      expect(f.live.size).toBe(2)
      vi.advanceTimersByTime(10 * MINUTE)
      await f.service.sweep()
      expect(f.live.size).toBe(0)
      expect(f.closed).toEqual([])
    })

    it('keeps local models, CLI handoffs and conversations with work', async () => {
      const f = fixture()
      f.add('local', { controller: null, opened: false, provider: 'local' })
      f.add('handed', { controller: null, opened: false }); f.settings.set('cliHandoff:handed', 'true')
      f.add('busy', { controller: null, opened: false }, { phase: 'running' })
      await idlePast(f, 30)
      expect([...f.live].sort()).toEqual(['busy', 'handed', 'local'])
    })

    it('releases a runtime whose tab is already closed', async () => {
      const f = fixture()
      f.add('gone', { controller: null, opened: false }); f.tabs.delete('gone')
      await idlePast(f)
      expect(f.live.has('gone')).toBe(false)
    })
  })
})
