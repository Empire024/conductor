import { useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, MoreHorizontal, Pin, TerminalSquare } from 'lucide-react'
import type { AgentActivityPhase, PaneTab, SessionRecord } from '../../../shared/models'
import type { AgentControlLink } from '../../../shared/agent-control'
import { distinctTabLabels, statusLabel, tabPinned, type ClarityRow } from '../../../shared/workspace-clarity'
import { listGroups } from '../layout/layout-operations'
import { tabGroupsOf, type TabGroupAction } from '../layout/tab-groups'
import type { WorkspaceTabAction } from '../layout/workspace-tab-actions'
import { useWorkspaceClarity } from '../layout/use-workspace-clarity'
import { PaneTabMenu } from './PaneTabMenu'
import { TabActivityIndicator } from './TabActivityIndicator'
import { ProviderIcon } from './ProviderIcon'
import { useAgentControlLinks } from './useAgentControlLinks'
import { ControlledByBadge } from './ControlActivity'
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

export function WorkspaceTabToggle({ expanded, name, onToggle }: { expanded: boolean; name: string; onToggle(): void }): React.JSX.Element {
  return <button className="workspace-tab-toggle" aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'List'} tabs in ${name}`} onClick={onToggle}>
    {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
  </button>
}

/**
 * One workspace's tabs in the sidebar, live work first (src/shared/workspace-clarity.ts): the
 * MAIN on top with its live coworkers nested under it, then other live or open tabs; everything
 * finished collapses into one "Done (N)" group, newest first, with the owner's one-click
 * "Close finished tabs".
 */
export function WorkspaceTabList({ session, active, expanded, activityPhases, onAction, onGroupAction }: { session: SessionRecord; active: boolean; expanded: boolean; activityPhases: ReadonlyMap<string, AgentActivityPhase>; onAction(groupId: string, tabId: string, action: WorkspaceTabAction): void; onGroupAction(groupId: string, tabId: string, action: TabGroupAction): void }): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number; groupId: string; tab: PaneTab } | null>(null)
  const [doneOpen, setDoneOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [closing, setClosing] = useState(false)
  const [closeNote, setCloseNote] = useState('')
  const spinEpoch = useRef(Date.now()).current
  const groups = listGroups(session.layout.root)
  const links = useAgentControlLinks(session.projectId, session.id, expanded)
  const clarity = useWorkspaceClarity(session.layout, links, activityPhases, expanded)
  const titleOf = (tabId: string, fallback?: string): string => groups.flatMap(group => group.tabs).find(candidate => candidate.id === tabId)?.title ?? fallback ?? 'Agent tab'
  // The same short labels the strip uses, so rows that start alike still read apart.
  const listed = [...clarity.live, ...clarity.done]
  const shortLabels = distinctTabLabels(listed.map(row => row.tab.title))
  const labelOf = new Map(listed.map((row, index) => [row.tab.id, shortLabels[index]!]))
  const focusLinkedTab = (tabId: string): void => { void window.conductor.agentControl.focusTab(session.projectId, session.id, tabId).catch(() => {}) }

  const renderTabRow = (row: ClarityRow, done = false): React.JSX.Element => {
    const { tab } = row
    const group = groups.find(item => item.id === row.groupId) ?? groups[0]!
    const tabPhase = (tab.resourceId ? activityPhases.get(tab.resourceId) : undefined) ?? (row.status === 'running' ? 'working' : row.status === 'waiting' ? 'waiting_input' : row.status === 'done' ? 'complete' : 'idle')
    const { controlledBy, controlling } = tab.kind === 'agent' ? tabControlRole(tab.id, links) : { controlledBy: undefined, controlling: [] }
    const tabGroup = tab.tabGroupId ? tabGroupsOf(group).find(item => item.id === tab.tabGroupId) : undefined
    const liveCoworkers = controlling.filter(link => clarity.live.some(candidate => candidate.tab.id === link.controlledTabId)).length
    const label = done ? statusLabel(row) : ''
    // One MAIN per workspace; any other live controller leads its own coworkers.
    const role = !done && row.role === 'main' ? 'Main' : !done && row.role === 'lead' ? 'Lead' : undefined
    return <div key={tab.id} data-clarity-row={tab.id} data-clarity-status={row.status} className={`workspace-tab-row${row.depth ? ' coworker-child' : ''}${active && group.activeTabId === tab.id ? ' selected' : ''} clarity-${row.status}${row.role === 'main' && !done ? ' clarity-main' : ''}`} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, groupId: group.id, tab }) }}>
      <button className="workspace-tab-select" title={row.controllerTitle ? `${tab.title} (coworker of ${row.controllerTitle})` : tab.title} onClick={() => onAction(group.id, tab.id, 'focus')}>
        {tabGroup && <i className="tab-group-dot" data-tab-group-color={tabGroup.color} title={`In ${tabGroup.title || 'unnamed group'}`} />}
        {tab.kind === 'agent' ? <ProviderIcon provider={String(tab.state?.provider ?? 'codex')} model={tab.state?.model as string | undefined} size={12} /> : tab.kind === 'terminal' ? <TerminalSquare size={12} /> : <FileText size={12} />}
        <span className="ellipsis">{labelOf.get(tab.id) ?? tab.title}</span>
        {tabPinned(tab) && <Pin className="workspace-tab-pin" size={10} aria-label="pinned" />}
        {label && <em className={`workspace-tab-status ${row.status}`}>{label}</em>}
        {tab.kind === 'agent' && !done && <TabActivityIndicator phase={tabPhase} title={tab.title} spinEpoch={spinEpoch} />}
      </button>
      {role && <button type="button" className={`workspace-tab-role ${row.role}`} title={`${tab.title} ${role === 'Main' ? 'is in charge of this workspace' : 'leads its own coworkers'}${liveCoworkers ? `: ${liveCoworkers} live coworker${liveCoworkers === 1 ? '' : 's'}` : ''}; show one`} aria-label={`${tab.title} is the ${role.toLowerCase()} tab${liveCoworkers ? ` with ${liveCoworkers} live coworkers` : ''}`} onClick={() => { const first = controlling[0]; if (first) focusLinkedTab(first.controlledTabId) }}><span>{role}</span>{liveCoworkers > 0 && <b>{liveCoworkers}</b>}</button>}
      {!role && !done && controlledBy && row.depth === 0 && <button type="button" className="workspace-tab-role coworker" title={`${tab.title} is controlled by ${titleOf(controlledBy.controllerTabId, controlledBy.controllerTitle)}; show the main tab`} aria-label={`${tab.title} is a coworker controlled by ${titleOf(controlledBy.controllerTabId, controlledBy.controllerTitle)}; show the main tab`} onClick={() => focusLinkedTab(controlledBy.controllerTabId)}><ControlledByBadge controllerTitle={titleOf(controlledBy.controllerTabId, controlledBy.controllerTitle)} /></button>}
      <button className="workspace-tab-more" aria-label={`${tab.title} tab actions`} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.right, y: rect.top, groupId: group.id, tab }) }}><MoreHorizontal size={12} /></button>
    </div>
  }

  const closable = clarity.done.filter(row => !tabPinned(row.tab))
  const closeFinished = (): void => {
    setConfirming(false); setClosing(true); setCloseNote('')
    window.conductor.workspaceClarity.closeFinished(session.projectId, session.id, closable.map(row => row.tab.id))
      .then(result => setCloseNote(result.kept.length ? `Closed ${result.closed}; kept ${result.kept.length}: ${result.kept.slice(0, 3).map(kept => `${kept.title} (${kept.reason})`).join('; ')}` : ''))
      .catch(reason => setCloseNote(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setClosing(false))
  }

  return <div className="workspace-tab-tree" onContextMenu={event => event.stopPropagation()}>
    {expanded && clarity.live.map(row => renderTabRow(row))}
    {expanded && clarity.done.length > 0 && <div className="workspace-done-group" data-done-count={clarity.done.length}>
      <div className="workspace-done-header">
        <button type="button" className="workspace-done-toggle" aria-expanded={doneOpen} onClick={() => setDoneOpen(open => !open)}>
          {doneOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}<span>Done ({clarity.done.length})</span>
        </button>
        {!confirming && closable.length > 0 && <button type="button" className="workspace-done-close" disabled={closing} title={`Close ${closable.length} finished tab${closable.length === 1 ? '' : 's'}; conversations stay in history`} onClick={() => setConfirming(true)}>{closing ? 'Closing…' : 'Close finished'}</button>}
      </div>
      {confirming && <div className="workspace-done-confirm" role="alertdialog" aria-label="Close finished tabs">
        <span>Close {closable.length} finished tab{closable.length === 1 ? '' : 's'}? History is kept.</span>
        <button type="button" className="danger" onClick={closeFinished}>Close {closable.length}</button>
        <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
      </div>}
      {closeNote && <small className="workspace-done-note" role="status">{closeNote}</small>}
      {doneOpen && clarity.done.map(row => renderTabRow(row, true))}
    </div>}
    {menu && <PaneTabMenu x={menu.x} y={menu.y} tab={menu.tab} maximized={session.maximizedGroupId === menu.groupId} continuation={menu.tab.state?.continueOnLimit === undefined ? session.continueOnLimit : Boolean(menu.tab.state.continueOnLimit)} groups={tabGroupsOf(groups.find(group => group.id === menu.groupId) ?? groups[0]!)} canReopen={session.closedTabs.length > 0} onDismiss={() => setMenu(null)} onAction={action => onAction(menu.groupId, menu.tab.id, action)} onGroupAction={action => onGroupAction(menu.groupId, menu.tab.id, action)} />}
  </div>
}
