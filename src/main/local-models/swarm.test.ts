import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_SWARM_LIMITS, planLocalCoworker, watchLocalCoworker, type LocalOpener } from './swarm'
import { agentTabIds, anonymousConversations, persistableClosedTabs, persistableLayout } from './anonymous'
import { MemoryResultStore } from './result-artifacts'
import { LOCAL_COWORKER_BRIEF } from './briefing'
import type { PaneTab, WorkspaceLayout } from '../../shared/models'

afterEach(() => anonymousConversations.clearForTests())

const opener = (overrides: Partial<LocalOpener> = {}): LocalOpener => ({
  model: 'local/dolphin', settings: { permission: 'accept-edits', plan: false }, anonymous: false, openedByLocal: false, liveCoworkers: 0, ...overrides
})

describe('local swarm plan', () => {
  it('opens a coworker of the same model with the same grants and the prompt', () => {
    const plan = planLocalCoworker(opener({ settings: { permission: 'accept-edits', plan: false, localGit: true, localResearch: false } }), { title: 'Tests for add', prompt: 'Write tests' })
    expect(plan.open).toEqual({ kind: 'agent', provider: 'local', model: 'local/dolphin', title: 'Tests for add' })
    expect(plan.grants).toEqual({ localGit: true, localResearch: false })
    // The swarm brief rides in front: report with agents.report, numbers from calculate.
    expect(plan.prompt).toBe(`${LOCAL_COWORKER_BRIEF}\n\nWrite tests`)
  })

  it('may narrow but never widen permission and grants', () => {
    expect(planLocalCoworker(opener({ settings: { permission: 'accept-edits', plan: false, localGit: true } }), { repository: false, permission: 'read-only' })).toMatchObject({ open: { permission: 'read-only' }, grants: { localGit: false } })
    expect(() => planLocalCoworker(opener(), { repository: true })).toThrow(/repository-write grant/)
    expect(() => planLocalCoworker(opener(), { research: true })).toThrow(/deep-research grant/)
    expect(() => planLocalCoworker(opener({ settings: { permission: 'read-only', plan: false } }), {})).toThrow(/read-only/)
    // Wider than the opener, or a word that is no mode at all: the opener's own mode, never an
    // error a small model cannot repair (VR9a: "read" refused twice, one coworker lost).
    expect(planLocalCoworker(opener(), { permission: 'auto' }).open.permission).toBe('accept-edits')
    expect(planLocalCoworker(opener(), { permission: 'read' }).open.permission).toBe('accept-edits')
    expect(planLocalCoworker(opener({ settings: { permission: 'default', plan: false } }), { permission: 'full-access' }).open.permission).toBe('default')
    expect(planLocalCoworker(opener(), { permission: 'default' }).open.permission).toBe('default')
    expect(planLocalCoworker(opener(), {}).open).not.toHaveProperty('permission')
  })

  it('hands the controller a stalled coworker\'s last computed numbers with its automatic report', async () => {
    const delivered: string[] = []
    const items = [
      { sequence: 2, data: { type: 'tool', name: 'calculate', status: 'completed', input: { path: 'week1.csv' }, output: 'ana = 21.75\nben = 19.75\ncara = 12.75' } },
      { sequence: 3, data: { type: 'tool', name: 'calculate', status: 'failed', input: {}, output: 'denied: Give exactly one' } },
      { sequence: 4, data: { type: 'text', role: 'assistant', text: 'Could not complete the task: the calculate approach has produced equivalent results 6 times.' } }
    ]
    let state: { phase: string; sequence: number; items: typeof items } = { phase: 'running', sequence: 1, items: [] }
    const stop = watchLocalCoworker('agent_w1', 'Week 1', { snapshot: () => state as never, deliver: async text => { delivered.push(text) }, intervalMs: 5 })
    state = { phase: 'failed', sequence: 4, items }
    await new Promise(resolve => setTimeout(resolve, 40))
    stop()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('Could not complete the task')
    expect(delivered[0]).toContain('Its last calculate result:\nana = 21.75\nben = 19.75\ncara = 12.75')
  })

  it('refuses another model, another provider and anything but its own fields', () => {
    expect(() => planLocalCoworker(opener(), { provider: 'claude' })).toThrow(/only local coworkers/)
    expect(() => planLocalCoworker(opener(), { model: 'local/other' })).toThrow(/own model/)
    expect(planLocalCoworker(opener(), { provider: 'local', model: 'dolphin', kind: 'agent' }).open.model).toBe('local/dolphin')
    expect(() => planLocalCoworker(opener(), { anonymous: false })).toThrow(/only local coworkers/)
  })

  it('bounds the swarm: coworker count and depth', () => {
    expect(() => planLocalCoworker(opener({ liveCoworkers: LOCAL_SWARM_LIMITS.coworkers }), {})).toThrow(/most a local swarm/)
    expect(() => planLocalCoworker(opener({ openedByLocal: true }), {})).toThrow(/1 level deep/)
  })

  it('keeps an anonymous opener\'s coworkers anonymous', () => {
    expect(planLocalCoworker(opener({ anonymous: true }), {}).open.anonymous).toBe(true)
  })

  it('keeps a bounded task\'s coworker inside the opener\'s paths', () => {
    const bounded = opener({ settings: { permission: 'accept-edits', plan: false, localContract: { allowedPaths: ['src/', 'README.md'] } } })
    expect(planLocalCoworker(bounded, {}).open.contract).toEqual({ allowedPaths: ['src/', 'README.md'] })
    expect(planLocalCoworker(bounded, { contract: { allowedPaths: ['src/a.test.ts'] } }).open.contract).toEqual({ allowedPaths: ['src/a.test.ts'] })
    expect(() => planLocalCoworker(bounded, { contract: { allowedPaths: ['package.json'] } })).toThrow(/only paths this conversation may write/)
    // A JSON-string contract, as a small model sends it, is held to the same rules.
    expect(planLocalCoworker(opener(), { contract: JSON.stringify({ allowedPaths: ['test/a.test.js'], acceptance: { command: 'node --test test/a.test.js' } }) }).open.contract).toEqual({ allowedPaths: ['test/a.test.js'], acceptance: { command: 'node --test test/a.test.js' } })
    expect(() => planLocalCoworker(bounded, { contract: JSON.stringify({ allowedPaths: ['package.json'] }) })).toThrow(/only paths this conversation may write/)
  })
})

describe('anonymous registry and layouts', () => {
  const tab = (id: string, anonymous = false): PaneTab => ({ id: 'pane-' + id, kind: 'agent', title: id, resourceId: id, state: { provider: 'local', ...(anonymous ? { anonymous: true } : {}) } })
  const layout = (tabs: PaneTab[]): WorkspaceLayout => ({ version: 1, root: { type: 'group', id: 'group-1', tabs, activeTabId: tabs.at(-1)!.id } })

  it('leaves anonymous tabs out of what is written, keeping a launcher in an emptied group', () => {
    const stored = persistableLayout(layout([tab('kept'), tab('secret', true)]))
    expect(stored.removed).toBe(true)
    expect(stored.layout.root.type === 'group' && stored.layout.root.tabs.map(item => item.id)).toEqual(['pane-kept'])
    expect(stored.layout.root.type === 'group' && stored.layout.root.activeTabId).toBe('pane-kept')
    const emptied = persistableLayout(layout([tab('secret', true)]))
    expect(emptied.layout.root.type === 'group' && emptied.layout.root.tabs.map(item => item.kind)).toEqual(['launcher'])
    expect(persistableLayout(layout([tab('kept')])).removed).toBe(false)
    expect(persistableClosedTabs([tab('kept'), tab('secret', true)]).map(item => item.id)).toEqual(['pane-kept'])
  })

  it('names keys of anonymous conversations and reports a tab closed only after it was seen', () => {
    anonymousConversations.mark('agent_secret')
    expect(anonymousConversations.ownsKey('local-session-checkpoint:["project","agent_secret"]')).toBe(true)
    expect(anonymousConversations.ownsKey('agentControlParent:agent_other')).toBe(false)
    // Registered before its tab reaches a layout: not closed yet.
    expect(anonymousConversations.closed(new Set())).toEqual([])
    expect(anonymousConversations.closed(agentTabIds([layout([tab('agent_secret', true)])]))).toEqual([])
    expect(anonymousConversations.closed(new Set(['agent_kept']))).toEqual(['agent_secret'])
    const forgotten: string[] = []
    const stop = anonymousConversations.onForget(id => forgotten.push(id))
    anonymousConversations.forget('agent_secret')
    stop()
    expect(forgotten).toEqual(['agent_secret'])
    expect(anonymousConversations.has('agent_secret')).toBe(false)
  })

  it('holds an anonymous conversation\'s command output in memory with the same handles', () => {
    const store = new MemoryResultStore()
    const id = store.save('owner', 'hello world')
    expect(store.read('owner', id, 6, 5)).toContain('\nworld')
    expect(() => store.read('someone else', id)).toThrow(/Unknown/)
  })
})

describe('automatic coworker report', () => {
  const state = (phase: string, sequence: number, items: Array<Record<string, unknown>>) => ({ phase, sequence, items: items as never, queuedPrompts: [] }) as never
  const text = (sequence: number, value: string) => ({ id: 't' + sequence, sequence, data: { type: 'text', role: 'assistant', text: value, mode: 'snapshot' } })
  const report = (sequence: number) => ({ id: 'r' + sequence, sequence, data: { type: 'tool', name: 'conductor', status: 'completed', input: { method: 'agents.report', args: { text: 'done' } } } })

  it('reports a settled turn that did not report itself, once, and leaves a reported turn alone', async () => {
    vi.useFakeTimers()
    try {
      let current = state('running', 2, [])
      const delivered: string[] = []
      const stop = watchLocalCoworker('agent_w', 'add tests', { snapshot: () => current, deliver: async value => { delivered.push(value) }, intervalMs: 10 })
      current = state('running', 5, [text(5, 'working')])
      await vi.advanceTimersByTimeAsync(30)
      expect(delivered).toEqual([])
      current = state('completed', 6, [text(6, 'All 4 tests pass.')])
      await vi.advanceTimersByTimeAsync(30)
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toMatch(/^\[Automatic report: add tests ended its turn \(completed\) without agents\.report\] All 4 tests pass\./)
      await vi.advanceTimersByTimeAsync(30)
      expect(delivered).toHaveLength(1)
      current = state('completed', 9, [text(6, 'old'), report(8), text(9, 'Reported.')])
      await vi.advanceTimersByTimeAsync(30)
      expect(delivered).toHaveLength(1)
      stop()
    } finally { vi.useRealTimers() }
  })
})
