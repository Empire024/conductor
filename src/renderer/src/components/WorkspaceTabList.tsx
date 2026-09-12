import { useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, MoreHorizontal, TerminalSquare } from 'lucide-react'
import type { AgentActivityPhase, PaneTab, SessionRecord } from '../../../shared/models'
import type { AgentControlLink } from '../../../shared/agent-control'
import { listGroups } from '../layout/layout-operations'
import { tabGroupsOf, type TabGroupAction } from '../layout/tab-groups'
import type { WorkspaceTabAction } from '../layout/workspace-tab-actions'
import { PaneTabMenu } from './PaneTabMenu'
import { TabActivityIndicator } from './TabActivityIndicator'
import { ProviderIcon } from './ProviderIcon'
import { useAgentControlLinks } from './useAgentControlLinks'
import './WorkspaceTabList.css'

export function tabControlRole(tabId: string, links: readonly AgentControlLink[]): { controlledBy?: AgentControlLink; controlling: AgentControlLink[] } {
  return { controlledBy: links.find(link => link.controlledTabId === tabId), controlling: links.filter(link => link.controllerTabId === tabId) }
}

export function tabRoleLabel(role: ReturnType<typeof tabControlRole>): 'Coworker' | 'Main' | 'Coworker · Main' | undefined {
  if (role.controlledBy && role.controlling.length) return 'Coworker · Main'
  if (role.controlledBy) return 'Coworker'
  if (role.controlling.length) return 'Main'
  return undefined
}

/** The disclosure control belongs beside the workspace name, not stranded between the name and
  * the tabs it opens; it lives here so its label and glyph stay with the list it governs. */
export function WorkspaceTabToggle({ expanded, name, onToggle }: { expanded: boolean; name: string; onToggle(): void }): React.JSX.Element {
  return <button className="workspace-tab-toggle" aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'List'} tabs in ${name}`} onClick={onToggle}>
    {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
  </button>
}

export function WorkspaceTabList({ session, active, expanded, activityPhases, onAction, onGroupAction }: { session: SessionRecord; active: boolean; expanded: boolean; activityPhases: ReadonlyMap<string, AgentActivityPhase>; onAction(groupId: string, tabId: string, action: WorkspaceTabAction): void; onGroupAction(groupId: string, tabId: string, action: TabGroupAction): void }): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number; groupId: string; tab: PaneTab } | null>(null)
  // Shared with every other spinner in this list (and, via the same epoch formula, the top tab
  // strip and stop button) so they all read as one in-phase system instead of drifting apart.
  const spinEpoch = useRef(Date.now()).current
  const groups = listGroups(session.layout.root)
  const links = useAgentControlLinks(session.projectId, session.id, expanded)
  // A tab can control several others at once but is controlled by at most one; the badge
  // click focuses the first target since this is a compact indicator, not the pane cable diagram.
  const titleOf = (tabId: string, fallback?: string): string => groups.flatMap(group => group.tabs).find(candidate => candidate.id === tabId)?.title ?? fallback ?? 'Agent tab'
  const focusLinkedTab = (tabId: string): void => { void window.conductor.agentControl.focusTab(session.projectId, session.id, tabId).catch(() => {}) }
  return <div className="workspace-tab-tree" onContextMenu={event => event.stopPropagation()}>
    {expanded && groups.flatMap(group => group.tabs.map(tab => {
      const tabPhase = (tab.resourceId ? activityPhases.get(tab.resourceId) : undefined) ?? 'idle'
      const role = tab.kind === 'agent' ? tabControlRole(tab.id, links) : { controlledBy: undefined, controlling: [] }
      const { controlledBy, controlling } = role
      const roleLabel = tabRoleLabel(role)
      const tabGroup = tab.tabGroupId ? tabGroupsOf(group).find(item => item.id === tab.tabGroupId) : undefined
      return <div key={tab.id} className={`workspace-tab-row${active && group.activeTabId === tab.id ? ' selected' : ''}`} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, groupId: group.id, tab }) }}>
      <button className="workspace-tab-select" title={tab.title} onClick={() => onAction(group.id, tab.id, 'focus')}>
        {tabGroup && <i className="tab-group-dot" data-tab-group-color={tabGroup.color} title={`In ${tabGroup.title || 'unnamed group'}`} />}
        {tab.kind === 'agent' ? <ProviderIcon provider={String(tab.state?.provider ?? 'codex')} size={12} /> : tab.kind === 'terminal' ? <TerminalSquare size={12} /> : <FileText size={12} />}
        <span className="ellipsis">{tab.title}</span>
        {tab.kind === 'agent' && <TabActivityIndicator phase={tabPhase} title={tab.title} spinEpoch={spinEpoch} />}
      </button>
      {roleLabel && <button type="button" className={`workspace-tab-role ${controlledBy && controlling.length ? 'both' : controlledBy ? 'coworker' : 'main'}`} title={controlledBy && controlling.length ? `${tab.title} is a coworker controlled by ${titleOf(controlledBy.controllerTabId, controlledBy.controllerTitle)} and a main coordinator for ${controlling.length} coworker${controlling.length === 1 ? '' : 's'} — show its main coordinating tab` : controlledBy ? `${tab.title} is a coworker controlled by ${titleOf(controlledBy.controllerTabId, controlledBy.controllerTitle)} — show the main coordinating tab` : `${tab.title} is the main coordinating tab and controls ${controlling.length === 1 ? titleOf(controlling[0]!.controlledTabId, controlling[0]!.controlledTitle) : controlling.length + ' coworkers'} — show ${controlling.length === 1 ? 'that coworker' : 'the first coworker'}`} aria-label={controlledBy ? `${tab.title} is ${roleLabel.toLowerCase()} controlled by ${titleOf(controlledBy.controllerTabId, controlledBy.controllerTitle)}; show the main tab` : `${tab.title} is the main coordinating tab and controls ${controlling.length === 1 ? titleOf(controlling[0]!.controlledTabId, controlling[0]!.controlledTitle) : controlling.length + ' coworkers'}; show its coworker`} onClick={() => focusLinkedTab(controlledBy?.controllerTabId ?? controlling[0]!.controlledTabId)}><span>{roleLabel}</span>{controlling.length > 0 && <b>{controlling.length}</b>}</button>}
      <button className="workspace-tab-more" aria-label={`${tab.title} tab actions`} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.right, y: rect.top, groupId: group.id, tab }) }}><MoreHorizontal size={12} /></button>
    </div>
    }))}
    {menu && <PaneTabMenu x={menu.x} y={menu.y} tab={menu.tab} maximized={session.maximizedGroupId === menu.groupId} continuation={menu.tab.state?.continueOnLimit === undefined ? session.continueOnLimit : Boolean(menu.tab.state.continueOnLimit)} groups={tabGroupsOf(groups.find(group => group.id === menu.groupId) ?? groups[0]!)} canReopen={session.closedTabs.length > 0} onDismiss={() => setMenu(null)} onAction={action => onAction(menu.groupId, menu.tab.id, action)} onGroupAction={action => onGroupAction(menu.groupId, menu.tab.id, action)} />}
  </div>
}
