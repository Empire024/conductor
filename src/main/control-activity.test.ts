import { describe, expect, it } from 'vitest'
import type { Json, SessionProjection, TimelineItem } from '../shared/structured-agent'
import { APP_CONTROL_HISTORY_KEY, CONTROL_ROW_ACTION_LIMIT, controlActivityOf, controlledByOf, latestControlAction } from '../shared/control-activity'
import { ControlActivityRecorder, READ_FLUSH_MS } from './control-activity'

// conductor-task:44a4ba26-0ec7-4d40-a1d9-c2634b3b7206
function fixture() {
  const notices: Array<{ id: string; message: string; payload: Json; itemId?: string }> = []
  const settings = new Map<string, string>()
  const items = new Map<string, TimelineItem[]>([['controller', [{ id: 'p1', runtimeId: 'r', sequence: 3, timestamp: '', data: { type: 'text', role: 'user', text: 'go', mode: 'snapshot' } }]]])
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = []
  let clock = Date.parse('2026-09-25T10:00:00Z')
  const titles: Record<string, { agentSessionId: string; tabId: string; title: string }> = {
    controller: { agentSessionId: 'controller', tabId: 'tab-c', title: 'Swarm' },
    fx7: { agentSessionId: 'fx7', tabId: 'tab-7', title: 'FX7' },
    fx9: { agentSessionId: 'fx9', tabId: 'tab-9', title: 'FX9' }
  }
  const recorder = new ControlActivityRecorder({
    notice: (id, message, payload, itemId) => { notices.push({ id, message, payload, ...(itemId ? { itemId } : {}) }); return true },
    snapshot: id => ({ items: items.get(id) ?? [] }) as unknown as SessionProjection,
    describe: target => Object.values(titles).find(entry => target.tabId ? entry.tabId === target.tabId : entry.agentSessionId === target.agentSessionId),
    getSetting: key => settings.get(key) ?? null,
    setSetting: (key, value) => { settings.set(key, value) },
    now: () => clock,
    setTimer: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer },
    clearTimer: handle => { (handle as { cleared: boolean }).cleared = true }
  })
  const scope = { projectId: 'p', sessionId: 's', agentSessionId: 'controller' }
  const rows = () => notices.filter(notice => notice.id === 'controller' && notice.itemId)
  const lastRow = () => controlActivityOf({ type: 'notice', message: '', payload: rows().at(-1)!.payload })!
  return { recorder, notices, settings, items, timers, scope, rows, lastRow, titles, tick: (ms: number) => { clock += ms } }
}

describe('control activity recorder', () => {
  it('keeps one chip row per turn for the caller and tells each opened tab who opened it', () => {
    const f = fixture()
    f.recorder.record({ scope: f.scope, method: 'tabs.open', args: { title: 'FX9' }, result: { id: 'tab-9', resourceId: 'fx9', title: 'FX9' } })
    f.recorder.record({ scope: f.scope, method: 'agents.steer', args: { agentSessionId: 'fx7', prompt: 'x' }, result: { agentSessionId: 'fx7' } })
    f.recorder.record({ scope: f.scope, method: 'git.ship', args: { message: 'm' }, result: { id: 'run-1', state: 'running', commit: null } })
    expect(new Set(f.rows().map(row => row.itemId))).toEqual(new Set(['control-activity:3']))
    expect(f.lastRow().actions.map(action => [action.method, action.label, action.target?.tabId])).toEqual([
      ['tabs.open', 'Opened FX9', 'tab-9'], ['agents.steer', 'Steered FX7', 'tab-7'], ['git.ship', 'git.ship', undefined]
    ])
    // The steered tab already names its sender on the prompt; only the opened tab gets a notice.
    const driven = f.notices.filter(notice => notice.id !== 'controller')
    expect(driven.map(notice => [notice.id, controlledByOf({ type: 'notice', message: notice.message, payload: notice.payload })])).toEqual([
      ['fx9', { agentSessionId: 'controller', tabId: 'tab-c', title: 'Swarm', verb: 'Opened', method: 'tabs.open', at: '2026-09-25T10:00:00.000Z' }]
    ])
    expect(driven[0]!.message).toBe('Opened by Swarm (tabs.open)')
  })

  it('collapses reads into one count written at most once per flush window', () => {
    const f = fixture()
    for (let index = 0; index < 30; index++) f.recorder.record({ scope: f.scope, method: index % 2 ? 'agents.snapshot' : 'tabs.list', args: {}, result: {} })
    expect(f.rows()).toHaveLength(0)
    expect(f.timers.filter(timer => !timer.cleared)).toHaveLength(1)
    expect(f.timers[0]!.ms).toBe(READ_FLUSH_MS)
    f.timers[0]!.callback()
    expect(f.rows()).toHaveLength(1)
    expect(f.lastRow()).toMatchObject({ reads: 30, readMethods: { 'tabs.list': 15, 'agents.snapshot': 15 }, actions: [] })
    expect(f.rows()[0]!.message).toBe('Used Conductor: read 30 times')
  })

  it('starts a new row on the next prompt and seeds a row a previous process already wrote', () => {
    const f = fixture()
    f.recorder.record({ scope: f.scope, method: 'agents.interrupt', args: { agentSessionId: 'fx7' }, result: {} })
    f.items.get('controller')!.push({ id: 'p2', runtimeId: 'r', sequence: 9, timestamp: '', data: { type: 'text', role: 'user', text: 'next', mode: 'snapshot' } })
    f.recorder.record({ scope: f.scope, method: 'tabs.close', args: { tabId: 'tab-9' }, result: {} })
    expect(f.rows().map(row => row.itemId)).toEqual(['control-activity:3', 'control-activity:9'])
    expect(f.lastRow().actions.map(action => action.label)).toEqual(['Closed FX9'])
    expect(f.notices.filter(notice => notice.id === 'fx9').map(notice => notice.message)).toEqual(['Closed by Swarm (tabs.close)'])

    const restarted = fixture()
    restarted.items.get('controller')!.push({ id: 'row', runtimeId: 'r', nativeItemId: 'control-activity:3', sequence: 4, timestamp: '', data: { type: 'notice', message: '', payload: f.rows()[0]!.payload } })
    restarted.recorder.record({ scope: restarted.scope, method: 'files.write', args: { path: 'src/a/b.ts' }, result: {} })
    expect(restarted.lastRow().actions.map(action => action.label)).toEqual(['Interrupted FX7', 'Wrote b.ts'])
  })

  it('puts the commit on the ship chip once git.ship.status reports it', () => {
    const f = fixture()
    f.recorder.record({ scope: f.scope, method: 'git.ship', args: {}, result: { id: 'run-1', state: 'running', commit: null } })
    f.recorder.record({ scope: f.scope, method: 'git.ship.status', args: {}, result: { id: 'run-1', state: 'delivered', commit: '634b1fa0123456789' } })
    expect(f.lastRow().actions[0]).toMatchObject({ kind: 'ship', runId: 'run-1', commit: '634b1fa0123456789' })
    expect(f.rows().at(-1)!.message).toBe('Used Conductor: git.ship → 634b1fa · read 1 time')
  })

  it('records failed mutations as failed chips and never notifies their target', () => {
    const f = fixture()
    f.recorder.record({ scope: f.scope, method: 'agents.finish', args: { agentSessionId: 'fx7' }, error: 'Finish only a coworker this agent controls' })
    expect(f.lastRow().actions[0]).toMatchObject({ label: 'Finished FX7', failed: true, error: 'Finish only a coworker this agent controls' })
    expect(f.notices.some(notice => notice.id === 'fx7')).toBe(false)
  })

  it('names a closed tab and tells it who closed it, resolved before the close ran (VR1 C1)', () => {
    const f = fixture()
    const call = { scope: f.scope, method: 'tabs.close', args: { tabId: 'tab-9' } }
    const prepared = f.recorder.prepare(call)
    // The close is announced while the coworker is still open: a closed conversation takes no notice.
    const told = f.notices.filter(notice => notice.id === 'fx9')
    expect(told.map(notice => [notice.message, controlledByOf({ type: 'notice', message: notice.message, payload: notice.payload })?.verb])).toEqual([['Closed by Swarm (tabs.close)', 'Closed']])
    delete f.titles.fx9
    f.recorder.record({ ...call, result: { closed: true }, prepared })
    expect(f.lastRow().actions[0]).toMatchObject({ method: 'tabs.close', label: 'Closed FX9', target: { tabId: 'tab-9', agentSessionId: 'fx9', title: 'FX9' } })
    expect(f.notices.filter(notice => notice.id === 'fx9')).toHaveLength(1)
  })

  it('corrects an announced close that failed, and prepares nothing for reads or untargeted calls', () => {
    const f = fixture()
    const call = { scope: f.scope, method: 'agents.release', args: { agentSessionId: 'fx7' } }
    const prepared = f.recorder.prepare(call)
    f.recorder.record({ ...call, error: 'Release only a coworker this agent controls', prepared })
    expect(f.notices.filter(notice => notice.id === 'fx7').map(notice => notice.message)).toEqual([
      'Released by Swarm (agents.release)', 'Released by Swarm did not happen (agents.release): Release only a coworker this agent controls'
    ])
    expect(f.lastRow().actions[0]).toMatchObject({ label: 'Released FX7', failed: true })
    expect(f.recorder.prepare({ scope: f.scope, method: 'tabs.list', args: {} })).toBeUndefined()
    expect(f.recorder.prepare({ scope: f.scope, method: 'agents.finish', args: {} })).toBeUndefined()
    // A rename is told after it happened, as before.
    const rename = { scope: f.scope, method: 'tabs.rename', args: { tabId: 'tab-7', title: 'FX7b' } }
    const renamed = f.recorder.prepare(rename)
    expect(f.notices.filter(notice => notice.id === 'fx7')).toHaveLength(2)
    f.recorder.record({ ...rename, result: {}, prepared: renamed })
    expect(f.notices.filter(notice => notice.id === 'fx7').at(-1)!.message).toBe('Renamed by Swarm (tabs.rename)')
  })

  it('keeps a bounded history of app-wide actions, including the owner credential\'s', () => {
    const f = fixture()
    f.recorder.record({ scope: f.scope, method: 'app.update.install', args: {}, result: { installing: true } })
    f.recorder.record({ scope: { projectId: 'p', sessionId: 's', agentSessionId: '\0owner', owner: true }, method: 'app.restart', args: {}, result: { restarting: true } })
    f.recorder.record({ scope: f.scope, method: 'app.update.rollback', args: {}, result: {} })
    f.recorder.record({ scope: f.scope, method: 'app.update.check', args: {}, result: {} })
    expect(f.recorder.appHistory().map(entry => [entry.label, entry.by.title])).toEqual([['Installed the update', 'Swarm'], ['Restarted Conductor', 'the owner'], ['Rolled back the app', 'Swarm']])
    for (let index = 0; index < 40; index++) f.recorder.record({ scope: f.scope, method: 'app.restart', args: {}, result: {} })
    expect(JSON.parse(f.settings.get(APP_CONTROL_HISTORY_KEY)!)).toHaveLength(30)
    // The owner credential has no timeline of its own, so it writes no chip row.
    expect(f.notices.filter(notice => notice.id === '\0owner')).toHaveLength(0)
  })

  it('bounds a row and names every dispatched coworker', () => {
    const f = fixture()
    f.recorder.record({ scope: f.scope, method: 'router.dispatch', args: { tasks: [{ title: 'FX7' }, { title: 'Late' }] }, result: [{ tabId: 'tab-7', agentSessionId: 'fx7', accepted: true }, { tabId: 'tab-x', agentSessionId: 'gone', accepted: false, error: 'refused' }] })
    expect(f.lastRow().actions.map(action => [action.label, action.failed ?? false])).toEqual([['Dispatched FX7', false], ['Dispatched Late', true]])
    expect(f.notices.filter(notice => !notice.itemId).map(notice => notice.id)).toEqual(['fx7'])
    for (let index = 0; index < CONTROL_ROW_ACTION_LIMIT + 5; index++) f.recorder.record({ scope: f.scope, method: 'tasks.update', args: {}, result: {} })
    expect(f.lastRow().actions).toHaveLength(CONTROL_ROW_ACTION_LIMIT)
    expect(f.lastRow().dropped).toBe(7)
    expect(JSON.stringify(f.rows().at(-1)!.payload).length).toBeLessThan(8000)
  })

  it('never throws into the call it describes', () => {
    const recorder = new ControlActivityRecorder({ notice: () => { throw new Error('closed') }, snapshot: () => undefined, describe: () => undefined, getSetting: () => null, setSetting: () => {} })
    expect(() => recorder.record({ scope: { projectId: 'p', sessionId: 's', agentSessionId: 'a' }, method: 'tabs.open', args: {}, result: {} })).not.toThrow()
  })
})

describe('latest control action', () => {
  it('reads the newest action taken by or on a conversation', () => {
    const at = (minute: number) => `2026-09-25T10:0${minute}:00.000Z`
    const items = [
      { id: '1', runtimeId: 'r', sequence: 1, timestamp: '', data: { type: 'notice', message: '', payload: { controlActivity: { actions: [{ method: 'git.ship', kind: 'ship', label: 'git.ship', at: at(1), commit: 'abcdef1234' }], reads: 2, readMethods: {}, dropped: 0 } } } },
      { id: '2', runtimeId: 'r', sequence: 2, timestamp: '', data: { type: 'notice', message: '', payload: { controlledBy: { agentSessionId: 'c', title: 'Swarm', verb: 'Interrupted', method: 'agents.interrupt', at: at(0) } } } }
    ] as TimelineItem[]
    expect(latestControlAction(items)).toEqual({ text: 'git.ship → abcdef1', at: at(1) })
    expect(latestControlAction(items.slice(1))).toEqual({ text: 'Interrupted by Swarm', at: at(0), by: 'Swarm' })
    expect(latestControlAction([])).toBeNull()
  })
})
