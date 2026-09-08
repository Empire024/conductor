import { describe, expect, it, vi } from 'vitest'
import type { AgentControlUiRequest } from '../../shared/agent-control'
import type { SessionRecord } from '../../shared/models'
import { createDefaultLayout } from '../../shared/models'
import { listGroups } from './layout/layout-operations'
import { handleAgentControlRequest, type AgentControlHost } from './use-agent-control'

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
  it('rejects another workspace and stale tab IDs without modifying state', async () => {
    const { host, request } = fixture()
    await expect(handleAgentControlRequest({ ...request('tabs.list'), sessionId: 'wrong' }, host)).rejects.toThrow('not available')
    await expect(handleAgentControlRequest(request('tabs.close', { tabId: 'missing' }), host)).rejects.toThrow('no longer open')
    expect(host.commit).not.toHaveBeenCalled()
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
})
