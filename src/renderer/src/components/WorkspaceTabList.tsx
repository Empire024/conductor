import { useEffect, useRef, useState } from 'react'
import { Archive, ChevronDown, ChevronRight, FileText, MoreHorizontal, Pin, TerminalSquare } from 'lucide-react'
import type { AgentActivityPhase, PaneTab, SessionRecord } from '../../../shared/models'
import type { AgentControlLink } from '../../../shared/agent-control'
import { distinctTabLabels, statusLabel, tabPinned, type ClarityRow } from '../../../shared/workspace-clarity'
import { awaitingSentence } from '../../../shared/awaiting-results'
import { listGroups } from '../layout/layout-operations'
import { tabGroupsOf, type TabGroupAction } from '../layout/tab-groups'
import type { WorkspaceTabAction } from '../layout/workspace-tab-actions'
import { useWorkspaceClarity } from '../layout/use-workspace-clarity'
import { PaneTabMenu, SelectionTabMenu } from './PaneTabMenu'
import { EMPTY_SELECTION, isBulk, orderedSelection, pruneSelection, selectAll, selectionClick, type BulkTabAction, type TabSelection } from '../layout/tab-selection'
import { openTabArchive } from './TabArchiveDialog'
import './TabArchiveDialog.css'
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
/** How many closed tabs this workspace's archive holds, kept current while its list is shown. */
function useArchiveCount(sessionId: string, enabled: boolean): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled || !window.conductor.tabArchive) return
    let live = true
    const read = (): void => { void window.conductor.tabArchive.list(sessionId, '', 1).then(page => { if (live) setCount(page.total) }).catch(() => undefined) }
    read()
    const stop = window.conductor.tabArchive.onChanged(change => { if (change.sessionId === sessionId) read() })
    return () => { live = false; stop() }
  }, [sessionId, enabled])
  return count
}

export function WorkspaceTabList({ session, active, expanded, activityPhases, onAction, onGroupAction, onBulkAction }: { session: SessionRecord; active: boolean; expanded: boolean; activityPhases: ReadonlyMap<string, AgentActivityPhase>; onAction(groupId: string, tabId: string, action: WorkspaceTabAction): void; onGroupAction(groupId: string, tabId: string, action: TabGroupAction): void; onBulkAction?(tabIds: string[], action: BulkTabAction): void }): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number; groupId: string; tab: PaneTab } | null>(null)
  const [selectionState, setSelection] = useState<TabSelection>(EMPTY_SELECTION)
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number } | null>(null)
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
  const archived = useArchiveCount(session.id, expanded)
  // Selection runs over the rows as listed (live, then Done when it is open), like files in Explorer.
  const rowOrder = [...clarity.live, ...(doneOpen ? clarity.done : [])].map(row => row.tab.id)
  const selection = pruneSelection(selectionState, rowOrder)
  const bulk = Boolean(onBulkAction) && isBulk(selection)
  const selectedIds = bulk ? orderedSelection(selection, rowOrder) : []
  const selectedTabs = selectedIds.flatMap(id => listed.filter(row => row.tab.id === id).map(row => row.tab))
  const activeTabId = active ? groups.find(group => group.tabs.some(tab => tab.id === group.activeTabId))?.activeTabId ?? null : null
  const runBulk = (action: BulkTabAction): void => { if (selectedIds.length > 1) { setSelection(EMPTY_SELECTION); onBulkAction?.(selectedIds, action) } }
  const showSelectionMenu = (event: React.MouseEvent): void => { event.preventDefault(); event.stopPropagation(); setMenu(null); setSelectionMenu({ x: event.clientX, y: event.clientY }) }

  const renderTabRow = (row: ClarityRow, done = false): React.JSX.Element => {
    const { tab } = row
    const group = groups.find(item => item.id === row.groupId) ?? groups[0]!
    // A tab waiting for others' results reads by its label, not as a completed turn.
    const tabPhase = row.status === 'awaiting' ? 'idle' : (tab.resourceId ? activityPhases.get(tab.resourceId) : undefined) ?? (row.status === 'running' ? 'working' : row.status === 'waiting' ? 'waiting_input' : row.status === 'done' ? 'complete' : 'idle')
    const { controlledBy, controlling } = tab.kind === 'agent' ? tabControlRole(tab.id, links) : { controlledBy: undefined, controlling: [] }
    const tabGroup = tab.tabGroupId ? tabGroupsOf(group).find(item => item.id === tab.tabGroupId) : undefined
    const liveCoworkers = controlling.filter(link => clarity.live.some(candidate => candidate.tab.id === link.controlledTabId)).length
    const label = done || row.status === 'awaiting' ? statusLabel(row) : ''
    // One MAIN per workspace; any other live controller leads its own coworkers.
    const role = !done && row.role === 'main' ? 'Main' : !done && row.role === 'lead' ? 'Lead' : undefined
    const picked = bulk && selection.ids.has(tab.id)
    return <div key={tab.id} data-clarity-row={tab.id} data-clarity-status={row.status} aria-selected={bulk ? picked : undefined} className={`workspace-tab-row${picked ? ' multi-selected' : ''}${row.depth ? ' coworker-child' : ''}${active && group.activeTabId === tab.id ? ' selected' : ''} clarity-${row.status}${row.role === 'main' && !done ? ' clarity-main' : ''}`} onContextMenu={event => { if (picked) { showSelectionMenu(event); return } event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, groupId: group.id, tab }) }}>
      <button className="workspace-tab-select" title={row.controllerTitle ? `${tab.title} (coworker of ${row.controllerTitle})` : tab.title} onClick={event => {
        if (onBulkAction && (event.ctrlKey || event.metaKey || event.shiftKey)) { setSelection(current => selectionClick(rowOrder, pruneSelection(current, rowOrder), tab.id, activeTabId, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey })); return }
        setSelection(EMPTY_SELECTION)
        onAction(group.id, tab.id, 'focus')
      }}>
        {tabGroup && <i className="tab-group-dot" data-tab-group-color={tabGroup.color} title={`In ${tabGroup.title || 'unnamed group'}`} />}
        {tab.kind === 'agent' ? <ProviderIcon provider={String(tab.state?.provider ?? 'codex')} model={tab.state?.model as string | undefined} size={12} /> : tab.kind === 'terminal' ? <TerminalSquare size={12} /> : <FileText size={12} />}
        <span className="ellipsis">{labelOf.get(tab.id) ?? tab.title}</span>
        {tabPinned(tab) && <Pin className="workspace-tab-pin" size={10} aria-label="pinned" />}
        {label && <em className={`workspace-tab-status ${row.status}`} title={row.awaiting ? awaitingSentence(row.awaiting) : undefined}>{label}</em>}
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

  const allTabIds = groups.flatMap(group => group.tabs.map(tab => tab.id))
  return <div className="workspace-tab-tree" aria-multiselectable={onBulkAction ? true : undefined} onContextMenu={event => event.stopPropagation()} onKeyDown={event => {
    if (!onBulkAction) return
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'a') { event.preventDefault(); event.stopPropagation(); setSelection(selectAll(rowOrder)); return }
    if (event.key === 'Escape' && selection.ids.size) { event.stopPropagation(); setSelection(EMPTY_SELECTION); return }
    if (event.key === 'Delete' && bulk) { event.preventDefault(); runBulk({ kind: 'close' }) }
  }}>
    {expanded && bulk && <div className="workspace-selection-bar" role="toolbar" aria-label={`${selectedIds.length} selected tabs`}>
      <span>{selectedIds.length} selected</span>
      <button type="button" onClick={showSelectionMenu}>Actions…</button>
      <button type="button" title="Close the selected tabs; they stay in this workspace's archive" onClick={() => runBulk({ kind: 'close' })}>Close {selectedIds.length}</button>
      <button type="button" title="Clear the selection (Esc)" onClick={() => setSelection(EMPTY_SELECTION)}>Clear</button>
    </div>}
    {expanded && clarity.live.map(row => renderTabRow(row))}
    {expanded && clarity.done.length > 0 && <div className="workspace-done-group" data-done-count={clarity.done.length}>
      <div className="workspace-done-header">
        <button type="button" className="workspace-done-toggle" aria-expanded={doneOpen} onClick={() => setDoneOpen(open => !open)}>
          {doneOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}<span>Done ({clarity.done.length})</span>
        </button>
        <button type="button" className="workspace-archive-link" title={`Every tab closed in ${session.name}: search, reopen, delete for good`} aria-label={`Archive of ${session.name}${archived ? `: ${archived} closed tabs` : ''}`} onClick={() => openTabArchive(session.id)}><Archive size={10} />{archived || ''}</button>
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
    {expanded && clarity.done.length === 0 && archived > 0 && <button type="button" className="workspace-archive-link" title={`Every tab closed in ${session.name}: search, reopen, delete for good`} onClick={() => openTabArchive(session.id)}><Archive size={10} />Archive ({archived})</button>}
    {selectionMenu && bulk && <SelectionTabMenu x={selectionMenu.x} y={selectionMenu.y} count={selectedIds.length}
      panes={groups.length > 1 ? groups.map(group => ({ groupId: group.id, label: `the pane with “${(group.tabs.find(tab => tab.id === group.activeTabId) ?? group.tabs[0])?.title ?? 'tabs'}”` })) : []}
      canSplit={selectedIds.length < allTabIds.length} canDetach={!selectedTabs.some(tab => tab.state?.anonymous === true)}
      onAction={runBulk} onClear={() => setSelection(EMPTY_SELECTION)} onDismiss={() => setSelectionMenu(null)} />}
    {menu && <PaneTabMenu x={menu.x} y={menu.y} tab={menu.tab} maximized={session.maximizedGroupId === menu.groupId} continuation={menu.tab.state?.continueOnLimit === undefined ? session.continueOnLimit : Boolean(menu.tab.state.continueOnLimit)} groups={tabGroupsOf(groups.find(group => group.id === menu.groupId) ?? groups[0]!)} canReopen={session.closedTabs.length > 0} onDismiss={() => setMenu(null)} onAction={action => onAction(menu.groupId, menu.tab.id, action)} onGroupAction={action => onGroupAction(menu.groupId, menu.tab.id, action)} />}
  </div>
}
