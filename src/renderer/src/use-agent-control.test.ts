import { describe, expect, it, vi } from 'vitest'
import type { AgentControlUiRequest } from '../../shared/agent-control'
import type { SessionRecord } from '../../shared/models'
import { createDefaultLayout } from '../../shared/models'
import { listGroups } from './layout/layout-operations'
import { handleAgentControlRequest, KEYBOARD_PAUSE_MS, waitForKeyboardPause, type AgentControlHost } from './use-agent-control'
import { composerDraftKey } from './panes/composer-draft-store'
import { clearNewTab, newTabMarks } from './layout/new-tab-marks'

function fixture() {
  let session: SessionRecord = { id: 'session', projectId: 'project', name: 'Workspace', layout: createDefaultLayout(), maximizedGroupId: null, closedTabs: [], continueOnLimit: false, createdAt: '', updatedAt: '' }
  const host: AgentControlHost = { resolve: async () => session, commit: vi.fn(async next => { session = next }), detach: vi.fn(async () => ({ id: 'detached' })), openFile: vi.fn() }
  const request = (action: AgentControlUiRequest['action'], params: Record<string, unknown> = {}): AgentControlUiRequest => ({ id: 'request', action, params, projectId: 'project', sessionId: 'session', agentSessionId: 'controller' })
  return { host, request, current: () => session }
}

describe('visible agent control', () => {
  it('opens, renames, focuses and closes the same real tab with persistent layout changes', async () => {
    const { host, request, current } = fixture()
    const tab = { id: 'created', kind: 'agent', title: 'Worker', resourceId: 'worker' }
    const opened = await handleAgentControlRequest(request('tabs.open', { tab }), host)
    expect(opened).toMatchObject({ id: 'created', uri: 'conductor://project/tab/created' })
    await handleAgentControlRequest(request('tabs.rename', { tabId: tab.id, title: 'Reviewer' }), host)
    await handleAgentControlRequest(request('tabs.focus', { tabId: tab.id }), host)
    expect(listGroups(current().layout.root)[0]!.tabs.find(item => item.id === tab.id)?.title).toBe('Reviewer')
    expect(listGroups(current().layout.root)[0]!.activeTabId).toBe(tab.id)
    await handleAgentControlRequest(request('tabs.close', { tabId: tab.id }), host)
    expect(current().closedTabs.at(-1)?.id).toBe(tab.id)
    expect(host.commit).toHaveBeenCalledTimes(4)
  })
  it('keeps a tab with an unsent draft when a finished coworker is closed for it', async () => {
    const stored = new Map<string, string>([[composerDraftKey('project', 'drafted'), JSON.stringify({ version: 1, revision: 'r1', message: 'not sent yet', attachments: [] })]])
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value) }, removeItem: (key: string) => { stored.delete(key) } })
    try {
      const { host, request, current } = fixture()
      for (const resourceId of ['drafted', 'clean']) await handleAgentControlRequest(request('tabs.open', { tab: { id: resourceId + '-tab', kind: 'agent', title: resourceId, resourceId } }), host)
      await expect(handleAgentControlRequest(request('tabs.close', { tabId: 'drafted-tab', unlessDraft: true }), host)).rejects.toThrow('unsent draft')
      await handleAgentControlRequest(request('tabs.close', { tabId: 'clean-tab', unlessDraft: true }), host)
      expect(current().closedTabs.map(tab => tab.id)).toEqual(['clean-tab'])
      // An ordinary close still closes it; only Conductor's own finish keeps the draft.
      await handleAgentControlRequest(request('tabs.close', { tabId: 'drafted-tab' }), host)
      expect(current().closedTabs.map(tab => tab.id)).toEqual(['clean-tab', 'drafted-tab'])
    } finally { vi.unstubAllGlobals() }
  })
  it('rejects another workspace and stale tab IDs without modifying state', async () => {
    const { host, request } = fixture()
    await expect(handleAgentControlRequest({ ...request('tabs.list'), sessionId: 'wrong' }, host)).rejects.toThrow('not available')
    await expect(handleAgentControlRequest(request('tabs.close', { tabId: 'missing' }), host)).rejects.toThrow('no longer open')
    expect(host.commit).not.toHaveBeenCalled()
  })
  it('restores and focuses only the exact retained origin tab', async () => {
    const { host, request, current } = fixture()
    const initial = listGroups(current().layout.root)[0]!
    const retained = { id: 'retained-source-tab', kind: 'agent' as const, title: 'Retained source', resourceId: 'retained-source' }
    current().closedTabs = [{ id: 'same-title', kind: 'agent', title: 'Retained source', resourceId: 'different-source' }, retained]
    const restored = await handleAgentControlRequest(request('tabs.focus-origin', { agentSessionId: retained.resourceId }), host)
    expect(restored).toMatchObject({ id: retained.id, uri: 'conductor://project/tab/' + retained.id })
    expect(listGroups(current().layout.root)[0]!.tabs.find(tab => tab.id === retained.id)).toEqual(retained)
    expect(listGroups(current().layout.root)[0]!.activeTabId).toBe(retained.id)
    expect(current().closedTabs).toEqual([expect.objectContaining({ id: 'same-title' })])
    expect(host.commit).toHaveBeenLastCalledWith(current(), initial.id, true)
    await expect(handleAgentControlRequest(request('tabs.focus-origin', { agentSessionId: 'guessed-source' }), host)).rejects.toThrow('no longer retained')
  })
  it('persists only model and effort on the exact visible agent tab', async () => {
    const { host, request, current } = fixture()
    const group = listGroups(current().layout.root)[0]!
    const tab = { id: 'worker-tab', kind: 'agent' as const, title: 'Worker', resourceId: 'worker', state: { provider: 'codex', model: 'old-model', effort: 'low', machineId: 'local', permission: 'accept-edits' } }
    current().layout = { ...current().layout, root: { ...group, activeTabId: tab.id, tabs: [...group.tabs, tab] } }
    const result = await handleAgentControlRequest(request('agents.configure', { tabId: tab.id, agentSessionId: tab.resourceId, provider: 'codex', model: 'new-model', effort: 'high', permission: 'auto' }), host)
    expect(result).toMatchObject({ id: tab.id, state: { provider: 'codex', model: 'new-model', effort: 'high', machineId: 'local', permission: 'accept-edits' } })
    expect(listGroups(current().layout.root)[0]!.tabs.find(candidate => candidate.id === tab.id)?.state).toEqual({ provider: 'codex', model: 'new-model', effort: 'high', machineId: 'local', permission: 'accept-edits' })
    expect(host.commit).toHaveBeenLastCalledWith(current(), group.id, false)
    await expect(handleAgentControlRequest(request('agents.configure', { tabId: tab.id, agentSessionId: 'someone-else', provider: 'codex', model: 'x', effort: 'low' }), host)).rejects.toThrow('no longer open')
  })
  it('announces only a durable confirmation that still matches visible metadata', async () => {
    class TestCustomEvent<T = unknown> extends Event { detail: T; constructor(type: string, init: CustomEventInit<T>) { super(type); this.detail = init.detail as T } }
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('CustomEvent', TestCustomEvent)
    const { host, request, current } = fixture()
    const group = listGroups(current().layout.root)[0]!
    const tab = { id: 'worker-tab', kind: 'agent' as const, title: 'Worker', resourceId: 'worker', state: { provider: 'codex', model: 'new-model', effort: 'high' } }
    current().layout = { ...current().layout, root: { ...group, tabs: [...group.tabs, tab] } }
    const changes: unknown[] = []
    const listener = (event: Event): void => { changes.push((event as CustomEvent).detail) }
    window.addEventListener('conductor:agent-control-settings-changed', listener)
    await expect(handleAgentControlRequest(request('agents.configure-confirmed', { tabId: tab.id, agentSessionId: 'worker', model: 'new-model', effort: 'high' }), host)).resolves.toEqual({ notified: true })
    await expect(handleAgentControlRequest(request('agents.configure-confirmed', { tabId: tab.id, agentSessionId: 'worker', model: 'stale-model', effort: 'low' }), host)).resolves.toEqual({ notified: false, superseded: true })
    window.removeEventListener('conductor:agent-control-settings-changed', listener)
    expect(changes).toEqual([{ agentSessionId: 'worker', model: 'new-model', effort: 'high' }])
    expect(host.commit).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
  it('announces a confirmed grant change only for the open local tab it names', async () => {
    class TestCustomEvent<T = unknown> extends Event { detail: T; constructor(type: string, init: CustomEventInit<T>) { super(type); this.detail = init.detail as T } }
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('CustomEvent', TestCustomEvent)
    const { host, request, current } = fixture()
    const group = listGroups(current().layout.root)[0]!
    const tab = { id: 'local-tab', kind: 'agent' as const, title: 'Local', resourceId: 'local-worker', state: { provider: 'local', model: 'local-synthetic' } }
    current().layout = { ...current().layout, root: { ...group, tabs: [...group.tabs, tab] } }
    const changes: unknown[] = []
    const listener = (event: Event): void => { changes.push((event as CustomEvent).detail) }
    window.addEventListener('conductor:agent-control-grants-changed', listener)
    await expect(handleAgentControlRequest(request('agents.grant-confirmed', { tabId: tab.id, agentSessionId: 'local-worker', repository: true, research: false }), host)).resolves.toEqual({ notified: true })
    await expect(handleAgentControlRequest(request('agents.grant-confirmed', { tabId: tab.id, agentSessionId: 'someone-else', repository: true }), host)).rejects.toThrow('no longer open')
    window.removeEventListener('conductor:agent-control-grants-changed', listener)
    expect(changes).toEqual([{ agentSessionId: 'local-worker', repository: true, research: false }])
    expect(host.commit).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
  it('splits into a visible new group and identifies detached tabs in list results', async () => {
    const { host, request, current } = fixture()
    host.detachedId = 'floating'
    const initial = listGroups(current().layout.root)[0]!.tabs[0]!
    await handleAgentControlRequest(request('tabs.split', { tabId: initial.id, direction: 'vertical' }), host)
    expect(listGroups(current().layout.root)).toHaveLength(2)
    const tabs = await handleAgentControlRequest(request('tabs.list'), host)
    expect(tabs).toEqual(expect.arrayContaining([expect.objectContaining({ detachedId: 'floating', id: initial.id })]))
  })
  it('waits for persistence before acknowledging a newly created tab', async () => {
    const { host, request } = fixture()
    let release!: () => void
    let done = false
    host.commit = () => new Promise(resolve => { release = resolve })
    const promise = handleAgentControlRequest(request('tabs.open', { tab: { id: 'worker', kind: 'agent' } }), host).then(() => { done = true })
    await Promise.resolve(); await Promise.resolve()
    expect(done).toBe(false)
    release(); await promise
    expect(done).toBe(true)
  })
  it('opens an agent-created tab active in its own group without revealing it to the owner', async () => {
    const { host, request, current } = fixture()
    const initial = listGroups(current().layout.root)[0]!
    const tab = { id: 'quiet-worker', kind: 'agent', title: 'Coworker', resourceId: 'quiet' }
    await handleAgentControlRequest(request('tabs.open', { tab }), host)
    expect(listGroups(current().layout.root)[0]!.activeTabId).toBe(tab.id)
    expect(host.commit).toHaveBeenLastCalledWith(current(), initial.id, false)
    await handleAgentControlRequest(request('tabs.open', { tab: { id: 'seen-worker', kind: 'agent' }, focus: true }), host)
    expect(host.commit).toHaveBeenLastCalledWith(current(), initial.id, true)
  })
  it('keeps the current task pane and utility panel open until the owner explicitly focuses an assigned tab', async () => {
    const { host, request, current } = fixture()
    const initial = listGroups(current().layout.root)[0]!
    const activeTabId = initial.activeTabId
    current().maximizedGroupId = initial.id
    const tab = { id: 'assigned', kind: 'agent', title: 'Task worker', resourceId: 'assigned-worker' }
    const opened = await handleAgentControlRequest(request('tabs.open', { tab, focus: false }), host)
    expect(opened).toMatchObject({ id: tab.id, uri: 'conductor://project/tab/assigned' })
    expect(listGroups(current().layout.root)[0]!.tabs.some(item => item.id === tab.id)).toBe(true)
    expect(listGroups(current().layout.root)[0]!.activeTabId).toBe(activeTabId)
    expect(current().maximizedGroupId).toBe(initial.id)
    expect(host.commit).toHaveBeenLastCalledWith(current(), initial.id, false)
    await handleAgentControlRequest(request('tabs.open', { tab, focus: false }), host)
    expect(listGroups(current().layout.root)[0]!.activeTabId).toBe(activeTabId)
    await handleAgentControlRequest(request('tabs.focus', { tabId: tab.id }), host)
    expect(listGroups(current().layout.root)[0]!.activeTabId).toBe(tab.id)
    expect(host.commit).toHaveBeenLastCalledWith(current(), initial.id, true)
  })
  it('marks a tab an agent opened in the background as new, keeping the owner on the active tab (FX21)', async () => {
    const { host, request, current } = fixture()
    const initial = listGroups(current().layout.root)[0]!
    await handleAgentControlRequest(request('tabs.open', { tab: { id: 'bg-one', kind: 'agent', title: 'One', resourceId: 'one' }, focus: false }), host)
    await handleAgentControlRequest(request('tabs.open', { tab: { id: 'bg-two', kind: 'agent', title: 'Two', resourceId: 'two' }, focus: false }), host)
    expect(listGroups(current().layout.root)[0]!.activeTabId).toBe(initial.activeTabId)
    expect(host.commit).toHaveBeenLastCalledWith(current(), initial.id, false)
    expect([...newTabMarks()]).toEqual(expect.arrayContaining(['bg-one', 'bg-two']))
    // A tab opened in front is not new; the owner is already looking at it.
    await handleAgentControlRequest(request('tabs.open', { tab: { id: 'fg', kind: 'agent', title: 'Front', resourceId: 'front' }, focus: true }), host)
    expect(newTabMarks().has('fg')).toBe(false)
    clearNewTab('bg-one'); clearNewTab('bg-two')
    expect(newTabMarks().has('bg-one') || newTabMarks().has('bg-two')).toBe(false)
  })
  it('holds an agent-asked focus until the keyboard has been still for the pause, and gives up on endless typing (FX21)', async () => {
    let clock = 0
    const sleep = async (ms: number): Promise<void> => { clock += ms }
    await expect(waitForKeyboardPause(() => Math.min(clock, 3000), () => clock, sleep)).resolves.toBe(true)
    expect(clock).toBeGreaterThanOrEqual(3000 + KEYBOARD_PAUSE_MS)
    clock = 0
    await expect(waitForKeyboardPause(() => clock, () => clock, sleep)).resolves.toBe(false)
  })
})
