import { afterEach, describe, expect, it } from 'vitest'
import { LOCAL_SWARM_LIMITS, planLocalCoworker, type LocalOpener } from './swarm'
import { agentTabIds, anonymousConversations, persistableClosedTabs, persistableLayout } from './anonymous'
import { MemoryResultStore } from './result-artifacts'
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
    expect(plan.prompt).toBe('Write tests')
  })

  it('may narrow but never widen permission and grants', () => {
    expect(planLocalCoworker(opener({ settings: { permission: 'accept-edits', plan: false, localGit: true } }), { repository: false, permission: 'read-only' })).toMatchObject({ open: { permission: 'read-only' }, grants: { localGit: false } })
    expect(() => planLocalCoworker(opener(), { repository: true })).toThrow(/repository-write grant/)
    expect(() => planLocalCoworker(opener(), { research: true })).toThrow(/deep-research grant/)
    expect(() => planLocalCoworker(opener({ settings: { permission: 'read-only', plan: false } }), {})).toThrow(/read-only/)
    expect(() => planLocalCoworker(opener(), { permission: 'auto' })).toThrow(/never more/)
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
