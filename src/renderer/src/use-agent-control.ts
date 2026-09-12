import { useEffect, useRef } from 'react'
import type { AgentControlTab, AgentControlUiRequest } from '../../shared/agent-control'
import { conductorUri } from '../../shared/agent-control'
import type { PaneTab, SessionRecord, WorkspaceLayout } from '../../shared/models'
import { makeLauncherTab } from '../../shared/models'
import { activateTab, addTab, findGroup, listGroups, splitGroup, updateTab } from './layout/layout-operations'
import { applyWorkspaceTabAction } from './layout/workspace-tab-actions'
import { announceAgentControlSettings } from './agent-control-settings'

export interface AgentControlHost {
  detachedId?: string
  resolve(request: AgentControlUiRequest): Promise<SessionRecord>
  commit(session: SessionRecord, focusedGroupId: string, reveal: boolean): Promise<void>
  detach(session: SessionRecord, tab: PaneTab, layout: WorkspaceLayout): Promise<unknown>
  openFile(projectId: string, path: string): void
}

/** Serializes commands so subsequent requests always see the preceding saved layout. */
export function useAgentControl(host: AgentControlHost): void {
  const latest = useRef(host)
  latest.current = host
  useEffect(() => {
    let queue = Promise.resolve()
    return window.conductor.agentControl.onRequest(request => {
      queue = queue.then(async () => {
        try { window.conductor.agentControl.respond({ id: request.id, result: await handleAgentControlRequest(request, latest.current) }) }
        catch (reason) { window.conductor.agentControl.respond({ id: request.id, error: reason instanceof Error ? reason.message : String(reason) }) }
      })
    })
  }, [])
}

export async function handleAgentControlRequest(request: AgentControlUiRequest, host: AgentControlHost): Promise<unknown> {
  const session = await host.resolve(request)
  if (session.id !== request.sessionId || session.projectId !== request.projectId) throw new Error('The requested workspace is not available in this window.')
  const groups = listGroups(session.layout.root)
  const serialize = (tab: PaneTab, groupId: string): AgentControlTab => ({ ...tab, groupId, ...(host.detachedId ? { detachedId: host.detachedId } : {}), uri: conductorUri(session.projectId, 'tab', tab.id) })
  if (request.action === 'workspace.focus') { await host.commit(session, groups[0]?.id ?? '', true); return { id: session.id, uri: conductorUri(session.projectId, 'workspace', session.id) } }
  if (request.action === 'tabs.list') return groups.flatMap(group => group.tabs.map(tab => serialize(tab, group.id)))
  let group = typeof request.params.tabId === 'string' ? groups.find(candidate => candidate.tabs.some(tab => tab.id === request.params.tabId)) : groups.find(candidate => candidate.id === request.params.groupId) ?? groups[0]
  if (!group) throw new Error('The requested tab is no longer open.')
  if (request.action === 'tabs.focus-origin') {
    const agentSessionId = typeof request.params.agentSessionId === 'string' ? request.params.agentSessionId : ''
    const retained = agentSessionId && [...session.closedTabs].reverse().find(candidate => candidate.kind === 'agent' && candidate.resourceId === agentSessionId)
    if (!retained) throw new Error('The originating agent tab is no longer retained.')
    const layout = addTab(session.layout, group.id, retained)
    const next = { ...session, layout, maximizedGroupId: null, closedTabs: session.closedTabs.filter(candidate => candidate.id !== retained.id) }
    await host.commit(next, group.id, true)
    return serialize(retained, group.id)
  }
  let tab = group.tabs.find(candidate => candidate.id === request.params.tabId) ?? group.tabs.find(candidate => candidate.id === group!.activeTabId)
  let next = session
  let focusedGroupId = group.id
  let result: unknown
  let reveal = false
  if (request.action === 'files.open') {
    const path = String(request.params.path ?? '')
    if (!path) throw new Error('A file path is required.')
    await host.commit(session, group.id, true)
    host.openFile(session.projectId, path)
    return { path, uri: conductorUri(session.projectId, 'file', path) }
  }
  if (request.action === 'agents.configure') {
    const agentSessionId = String(request.params.agentSessionId ?? '')
    const provider = String(request.params.provider ?? '')
    const model = String(request.params.model ?? '')
    const effort = request.params.effort === undefined ? undefined : String(request.params.effort)
    if (!tab || tab.kind !== 'agent' || tab.resourceId !== agentSessionId) throw new Error('The requested agent tab is no longer open.')
    if (!provider || tab.state?.provider !== provider || !model || (request.params.effort !== undefined && !effort)) throw new Error('Invalid agent configuration.')
    if (request.params.expectedModel !== undefined && (tab.state?.model !== request.params.expectedModel || (tab.state?.effort ?? 'auto') !== request.params.expectedEffort)) throw new Error('The agent tab settings changed before rollback.')
    tab = { ...tab, state: { ...tab.state, model, effort: effort ?? 'auto' } }
    next = { ...session, layout: updateTab(session.layout, group.id, tab.id, () => tab!) }
    await host.commit(next, group.id, false)
    return serialize(tab, group.id)
  }
  if (request.action === 'agents.configure-confirmed') {
    const agentSessionId = String(request.params.agentSessionId ?? '')
    const model = String(request.params.model ?? '')
    const effort = request.params.effort === undefined ? undefined : String(request.params.effort)
    if (!tab || tab.kind !== 'agent' || tab.resourceId !== agentSessionId || !model) throw new Error('The requested agent tab is no longer open.')
    // The owner may have picked something newer between durable save and this renderer hop. In
    // that case the newer layout wins and the stale confirmation never reaches React state.
    if (tab.state?.model !== model || (tab.state.effort ?? 'auto') !== (effort ?? 'auto')) return { notified: false, superseded: true }
    announceAgentControlSettings({ agentSessionId, model, effort })
    return { notified: true }
  }
  if (request.action === 'workspace.rename') {
    const name = String(request.params.name ?? request.params.title ?? '').trim()
    if (!name) throw new Error('A workspace name is required.')
    await window.conductor.sessions.rename(session.id, name)
    next = { ...session, name }
    result = { id: session.id, name }
  } else if (request.action === 'tabs.open') {
    const created = request.params.tab as PaneTab | undefined
    if (!created?.id || !created.kind) throw new Error('A prepared tab is required.')
    const existing = groups.find(candidate => candidate.tabs.some(item => item.id === created.id))
    const focus = request.params.focus !== false
    if (existing) { group = existing; if (focus) next = { ...session, layout: activateTab(session.layout, existing.id, created.id), maximizedGroupId: null } }
    else {
      const added = addTab(session.layout, group.id, created)
      // Owner task assignment keeps its dialog alive until native submission
      // returns, including when Project tasks is itself the active pane tab.
      next = { ...session, layout: focus ? added : activateTab(added, group.id, group.activeTabId), maximizedGroupId: focus ? null : session.maximizedGroupId }
    }
    // A tab an agent opens lands active in its own group, so it's already there the moment the
    // owner looks - but only an explicit focus:true asks to move the owner's actual attention
    // there. Without it, the window, project and workspace the owner is looking at never move.
    focusedGroupId = group.id; tab = created; reveal = request.params.focus === true; result = serialize(created, group.id)
  } else {
    if (!tab) throw new Error('The requested tab is no longer open.')
    if (request.action === 'tabs.rename') {
      const title = String(request.params.title ?? '').trim()
      if (!title) throw new Error('A tab title is required.')
      tab = { ...tab, title }
      next = { ...session, layout: updateTab(session.layout, group.id, tab.id, () => tab!) }
      result = serialize(tab, group.id)
    } else if (request.action === 'tabs.split') {
      const direction = String(request.params.direction)
      if (!['horizontal', 'vertical'].includes(direction)) throw new Error('Invalid split direction.')
      const created = (request.params.tab as PaneTab | undefined) ?? makeLauncherTab()
      const layout = splitGroup(session.layout, group.id, direction === 'horizontal' ? 'right' : 'below', created)
      focusedGroupId = listGroups(layout.root).find(candidate => candidate.tabs.some(item => item.id === created.id))!.id
      next = { ...session, layout, maximizedGroupId: null }; reveal = true; result = serialize(created, focusedGroupId)
    } else {
      const action = request.action === 'tabs.focus' ? 'focus' : request.action === 'tabs.close' ? 'close' : request.action === 'tabs.detach' ? 'detach' : null
      if (!action) throw new Error('Unsupported workspace action.')
      if (action === 'close' && tab.kind === 'code') {
        window.dispatchEvent(new Event('conductor:flush-editors'))
        if (!await window.conductor.files.confirmClose([tab.id])) throw new Error('Closing the file was cancelled.')
      }
      const changed = applyWorkspaceTabAction(session, group.id, tab.id, action)
      next = changed.session; focusedGroupId = changed.focusedGroupId; reveal = action === 'focus'
      result = action === 'detach' ? await host.detach(session, tab, next.layout) : { tabId: tab.id, closed: action === 'close' }
    }
  }
  await host.commit(next, focusedGroupId, reveal)
  return result
}
