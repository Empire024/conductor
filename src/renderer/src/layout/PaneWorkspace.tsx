import { bindConversationTab, type ConversationIdentity } from '../panes/conversation-tab'
import { AgentControlLinks } from '../components/AgentControlLinks'
import { ProjectBacklogPane } from '../components/ProjectBacklogPane'
import '../navigation.css'
import { ProviderIcon } from '../components/ProviderIcon'
import { PaneTabMenu, TabGroupMenu } from '../components/PaneTabMenu'
import { TabActivityIndicator } from '../components/TabActivityIndicator'
import { applyTabGroupAction, applyWorkspaceTabAction } from './workspace-tab-actions'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import {
  Bot,
  FileText,
  FolderTree,
  Globe2,
  GripVertical,
  MoreHorizontal,
  Plus,
  TerminalSquare,
  TimerReset,
  Undo2,
  X
} from 'lucide-react'
import { fileTypeIcon } from '../file-types'
import type {
  AgentActivityPhase,
  AgentProviderId,
  LayoutNode,
  PaneGroupNode,
  PaneKind,
  PaneTab,
  ProjectRecord,
  SessionRecord,
  WorkspaceLayout
} from '../../../shared/models'
import { makeLauncherTab } from '../../../shared/models'
import {
  activateTab,
  addTab,
  applyTabDrop,
  closeTab,
  collapseTabGroup,
  findGroup,
  insertForeignTab,
  resizeSplit,
  tabDropLands,
  type TabDropTarget,
  replaceTab,
  updateTab
} from './layout-operations'
import { tabGroupsOf, tabStripSlots, type TabGroupAction } from './tab-groups'
import {
  CROSS_WINDOW_TAB_MIME,
  decodeCrossWindowTab,
  dropTargetAt,
  encodeCrossWindowTab,
  gapAnchorId,
  type CanvasEdge,
  type PaneGeometry,
  type TabRect
} from './tab-drag'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { createPaneTab } from '../panes/pane-factory'
import { createPlacedTab, readPlacement, writePlacement } from './machine-placement'
import { FilePreviewPane } from '../panes/FilePreviewPane'
import { RuntimeTerminal } from '../panes/RuntimeTerminal'
import { LauncherPane } from '../panes/LauncherPane'
import { FileTreePane } from '../panes/FileTreePane'
import { CodePane } from '../panes/CodePane'
import { BrowserPane } from '../panes/BrowserPane'
import { debugLog } from '../debug-log'

interface PaneWorkspaceProps {
  layout: WorkspaceLayout
  project: ProjectRecord
  session: SessionRecord
  /** Absent for the main window. Threaded through so a dragged tab's cross-window payload can
   *  name which detached window it came from, which is what lets that window close itself once
   *  the tab leaves it for good. */
  detachedId?: string
  focusedGroupId: string
  maximizedGroupId: string | null
  onLayout(layout: WorkspaceLayout): void
  onPersistLayout(layout: WorkspaceLayout): Promise<void>
  onFocus(groupId: string): void
  onMaximize(groupId: string | null): void
  onClosed(tab: PaneTab): void
  onDetach(groupId: string, tab: PaneTab, options?: { alwaysOnTop?: boolean }): void
  canReopen: boolean
  onReopen(groupId: string): void
  onOpenFile?(path: string, line?: number, mode?: 'editor' | 'preview', allowBinary?: boolean): void
  /** App.tsx's phase map, already downgraded away from 'complete' while a tab still owns active
   *  subagent work (see resolveActivityPhases in attention.ts). Falls back to this pane's own raw
   *  per-tab listener when absent, e.g. in a detached window that doesn't thread this prop. */
  correctedActivityPhases?: ReadonlyMap<string, AgentActivityPhase>
}

interface TabDragState { sourceGroupId: string; tab: PaneTab; width: number; x: number; y: number }

interface PaneDragActions {
  start(groupId: string, tab: PaneTab, width: number, point: { x: number; y: number }): void
}

const iconFor = (tab: PaneTab): typeof Bot => {
  if (tab.kind === 'agent') return Bot
  if (tab.kind === 'terminal') return TerminalSquare
  if (tab.kind === 'file-tree') return FolderTree
  // Same mapping the explorer, file tabs and Ctrl+E picker use, so a .tsx tab's icon matches everywhere.
  if (tab.kind === 'code' || tab.kind === 'preview') return fileTypeIcon((tab.state?.path as string) ?? tab.resourceId ?? '')
  if (tab.kind === 'browser') return Globe2
  return FileText
}

const TAB_ANIMATION_MS = 110
const TAB_SPOTLIGHT_MS = 1600

/** Stands in for a tab dragged in from another window while it is still in flight: its real
 * identity is locked inside the OS drag session and unreadable until it actually drops, but the
 * gap/ghost geometry needs some tab-shaped thing to measure against in the meantime. Its id never
 * matches a real tab, so it is never excluded from a bar's own insertion maths. */
const FOREIGN_DRAG_TAB: PaneTab = { id: '__conductor-foreign-drag__', kind: 'tasks', title: 'Tab' }
const FOREIGN_DRAG_WIDTH = 150

const PaneBody = ({
  tab,
  groupId,
  project,
  session,
  onOpen,
  onOpenFile,
  onUpdateTab,
  onConversationChange,
  placement,
  placementError,
  onSelectMachine
}: {
  tab: PaneTab
  groupId: string
  project: ProjectRecord
  session: SessionRecord
  placement: string
  placementError: string
  onSelectMachine(machineId: string): void
  onOpen(kind: PaneKind, provider?: AgentProviderId, model?: string): void
  onOpenFile(path: string, line?: number, mode?: 'editor' | 'preview', allowBinary?: boolean): void
  onUpdateTab(tabId: string, state: Record<string, unknown>): void
  onConversationChange(tabId: string, conversation: ConversationIdentity): Promise<void>
}): React.JSX.Element => {
  if (tab.kind === 'launcher') return <LauncherPane machineId={placement} error={placementError} onSelectMachine={onSelectMachine} onOpen={onOpen} />
  if (tab.kind === 'terminal') {
    return (
      <RuntimeTerminal
        mode="terminal"
        resourceId={tab.resourceId!}
        title={tab.title}
        project={project}
        session={session}
        onOpenFile={onOpenFile}
      />
    )
  }
  if (tab.kind === 'agent') {
    return (
      <RuntimeTerminal
        mode="agent"
        provider={(tab.state?.provider as AgentProviderId) ?? 'codex'}
        resume={Boolean(tab.state?.resume)}
        model={(tab.state?.model as string) ?? 'default'}
        effort={(tab.state?.effort as import('../../../shared/models').AgentEffort) ?? 'auto'}
        continueOnLimit={tab.state?.continueOnLimit === undefined ? session.continueOnLimit : Boolean(tab.state.continueOnLimit)}
        viewMode={(tab.state?.viewMode as 'visual' | 'cli') ?? 'visual'}
        resourceId={tab.resourceId!}
        title={tab.title}
        project={project}
        session={session}
        onOpenFile={onOpenFile}
        onConversationChange={conversation => onConversationChange(tab.id, conversation)}
        onModelChange={(model) => onUpdateTab(tab.id, { ...tab.state, model })}
        onEffortChange={(effort) => onUpdateTab(tab.id, { ...tab.state, effort })}
        onViewModeChange={(viewMode) => onUpdateTab(tab.id, { ...tab.state, viewMode })}
      />
    )
  }
  if (tab.kind === 'file-tree') return <FileTreePane project={project} onOpenFile={onOpenFile} />
  if (tab.kind === 'tasks') return <ProjectBacklogPane project={project} />
  if (tab.kind === 'code') return <CodePane project={project} tabId={tab.id} path={(tab.state?.path as string) ?? tab.resourceId ?? ''} line={tab.state?.line as number | undefined} />
  if (tab.kind === 'preview') return <FilePreviewPane project={project} path={(tab.state?.path as string) ?? tab.resourceId ?? ''} onOpenEditor={(path, allowBinary) => onOpenFile(path, undefined, 'editor', allowBinary)} />
  if (tab.kind === 'browser') return <BrowserPane performanceTabId={tab.id} initialUrl={(tab.state?.url as string) ?? undefined} onUrlChange={(url) => onUpdateTab(tab.id, { ...tab.state, url })} />
  return (
    <div className="coming-pane">
      <span>{tab.kind}</span>
      <strong>Unavailable</strong>
    </div>
  )
}

function PaneGroup({
  group,
  workspace,
  dragActions,
  dragging,
  dropTarget,
  snapArrival
}: {
  group: PaneGroupNode
  workspace: PaneWorkspaceProps
  dragActions: PaneDragActions
  dragging: TabDragState | null
  dropTarget: TabDropTarget | null
  snapArrival: { groupId: string; edge: CanvasEdge } | null
}): React.JSX.Element {
  const groupRef = useRef<HTMLElement>(null)
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const [placement, setPlacement] = useState(() => readPlacement(workspace.session.id))
  const [placementError, setPlacementError] = useState('')
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; tabGroupId: string } | null>(null)
  /** A group created from the tab menu opens its name editor as soon as the chip exists,
   * the way Chrome drops you straight into naming a new group. */
  const [pendingRename, setPendingRename] = useState<string | null>(null)
  const [activity, setActivity] = useState<Record<string, AgentActivityPhase>>({})
  // One clock reading per group, shared by every spinner it renders, anchors them all to the
  // same epoch so a tab mounting later still lands in step with tabs already spinning.
  const spinEpoch = useRef(Date.now()).current
  const [closingTabIds, setClosingTabIds] = useState<Set<string>>(() => new Set())
  const [openingTabIds, setOpeningTabIds] = useState<Set<string>>(() => new Set())
  const [spotlight, setSpotlight] = useState<{ tabId: string; key: number } | null>(null)
  const knownTabIdsRef = useRef(new Set(group.tabs.map((tab) => tab.id)))
  const closeTimersRef = useRef(new Map<string, number>())
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const activeTab = group.tabs.find((tab) => tab.id === group.activeTabId) ?? group.tabs[0]!
  const menuTab = group.tabs.find(tab => tab.id === menuPosition?.tabId) ?? activeTab
  const menuGroup = tabGroupsOf(group).find(item => item.id === groupMenu?.tabGroupId)
  const focused = workspace.focusedGroupId === group.id
  const isSourceGroup = dragging?.sourceGroupId === group.id
  const barIndex = dropTarget?.kind === 'bar' && dropTarget.groupId === group.id ? dropTarget.index : null
  const canvasEdge = dropTarget?.kind === 'canvas' && dropTarget.groupId === group.id ? dropTarget.edge : null
  const gapBeforeId = barIndex === null ? undefined : gapAnchorId(group.tabs.map((tab) => tab.id), isSourceGroup ? dragging!.tab.id : null, barIndex)

  useEffect(() => {
    if (!menuPosition) return
    const closeMenu = (event?: Event): void => { if (event?.target instanceof Element && event.target.closest('.pane-menu-button') && groupRef.current?.contains(event.target)) return; setMenuPosition(null) }
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') closeMenu() }
    window.addEventListener('mousedown', closeMenu)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', closeMenu)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuPosition])

  useEffect(() => {
    const onActivity = (event: Event): void => {
      const detail = (event as CustomEvent<{ id: string; phase: AgentActivityPhase }>).detail
      const tab = group.tabs.find((item) => item.resourceId === detail.id)
      if (tab) setActivity((current) => ({ ...current, [tab.id]: detail.phase }))
    }
    window.addEventListener('conductor:agent-activity', onActivity)
    return () => window.removeEventListener('conductor:agent-activity', onActivity)
  }, [group.tabs])

  useEffect(() => {
    const onSpotlight = (event: Event): void => {
      const tabId = (event as CustomEvent<{ tabId?: string }>).detail?.tabId
      if (tabId) setSpotlight({ tabId, key: Date.now() })
    }
    window.addEventListener('conductor:spotlight-tab', onSpotlight)
    return () => window.removeEventListener('conductor:spotlight-tab', onSpotlight)
  }, [])

  useLayoutEffect(() => {
    if (!pendingRename) return
    setPendingRename(null)
    const chip = groupRef.current?.querySelector<HTMLElement>(`.tab-group-chip[data-tab-group-id="${CSS.escape(pendingRename)}"]`)
    if (!chip) return
    const rect = chip.getBoundingClientRect()
    setGroupMenu({ x: Math.min(rect.left, window.innerWidth - 235), y: rect.bottom + 2, tabGroupId: pendingRename })
  }, [pendingRename])

  useEffect(() => {
    if (!spotlight) return
    const timer = window.setTimeout(() => setSpotlight(null), TAB_SPOTLIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [spotlight])

  useLayoutEffect(() => {
    const nextIds = new Set(group.tabs.map((tab) => tab.id))
    const addedIds = group.tabs
      .map((tab) => tab.id)
      .filter((id) => !knownTabIdsRef.current.has(id))
    knownTabIdsRef.current = nextIds
    setOpeningTabIds((current) => addedIds.length || current.size ? new Set(addedIds) : current)
    if (addedIds.length === 0) return
    debugLog('tabs', 'Tab opened', { sessionId: workspace.session.id, groupId: group.id, tabIds: addedIds }, 'info')
    const timer = window.setTimeout(() => setOpeningTabIds(new Set()), TAB_ANIMATION_MS)
    return () => window.clearTimeout(timer)
  }, [group.id, group.tabs, workspace.session.id])

  useEffect(() => () => {
    if (closeTimersRef.current.size) {
      debugLog('tabs', 'Cancelled pending tab closes when pane was disposed', {
        sessionId: workspace.session.id,
        groupId: group.id,
        tabIds: [...closeTimersRef.current.keys()]
      }, 'info')
    }
    for (const timer of closeTimersRef.current.values()) window.clearTimeout(timer)
    closeTimersRef.current.clear()
  }, [])

  const beginDrag = (event: React.DragEvent, tab: PaneTab): void => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(CROSS_WINDOW_TAB_MIME, encodeCrossWindowTab({
      tab,
      sourceGroupId: group.id,
      projectId: workspace.project.id,
      sessionId: workspace.session.id,
      ...(workspace.detachedId ? { detachedId: workspace.detachedId } : {})
    }))
    const transparentImage = document.createElement('canvas')
    transparentImage.width = 1
    transparentImage.height = 1
    event.dataTransfer.setDragImage(transparentImage, 0, 0)
    dragActions.start(group.id, tab, event.currentTarget.getBoundingClientRect().width, { x: event.clientX, y: event.clientY })
  }

  const showContextMenu = (event: React.MouseEvent, tab: PaneTab = activeTab): void => {
    event.preventDefault()
    event.stopPropagation()
    workspace.onFocus(group.id)
    if (event.type === 'click' && menuPosition) { setMenuPosition(null); return }
    setMenuPosition({
      x: Math.min(event.clientX, window.innerWidth - 205),
      y: event.clientY,
      tabId: tab.id
    })
  }

  const showGroupMenu = (event: React.MouseEvent, tabGroupId: string): void => {
    event.preventDefault()
    event.stopPropagation()
    workspace.onFocus(group.id)
    setMenuPosition(null)
    setGroupMenu({ x: Math.min(event.clientX, window.innerWidth - 235), y: event.clientY, tabGroupId })
  }

  const runGroupAction = (action: TabGroupAction, tab: PaneTab): void => {
    const result = applyTabGroupAction({ ...workspace.session, layout: workspace.layout }, group.id, tab.id, action)
    workspace.onLayout(result.session.layout)
    for (const closed of result.session.closedTabs.slice(workspace.session.closedTabs.length)) workspace.onClosed(closed)
    if (result.tabGroupId) setPendingRename(result.tabGroupId)
  }

  /** Remembering the choice is what makes the next tab inherit this machine. */
  const choose = (machineId: string): void => {
    setPlacement(machineId)
    setPlacementError('')
    writePlacement(workspace.session.id, machineId)
  }

  const open = (kind: PaneKind, provider?: AgentProviderId, model?: string): void => {
    if (kind !== 'agent' && kind !== 'terminal') return
    // Placing a tab on another machine has to reach that machine first, so the launcher stays put
    // until it answers; a refusal leaves the launcher open with the reason rather than a dead tab.
    void createPlacedTab({ kind, provider, model, machineId: placement, projectId: workspace.project.id, sessionId: workspace.session.id })
      .then(tab => workspace.onLayout(replaceTab(workspace.layout, group.id, activeTab.id, tab)))
      .catch((reason: unknown) => setPlacementError(String(reason instanceof Error ? reason.message : reason)))
  }

  const openFile = (path: string, line?: number, mode?: 'editor' | 'preview', allowBinary?: boolean): void => {
    workspace.onOpenFile?.(path, line, mode, allowBinary)
  }

  const setTabState = (tabId: string, state: Record<string, unknown>): void => {
    workspace.onLayout(updateTab(workspace.layout, group.id, tabId, (tab) => ({ ...tab, state })))
  }


  const changeConversation = async (tabId: string, conversation: ConversationIdentity): Promise<void> => {
    const current = workspaceRef.current
    const currentGroup = findGroup(current.layout.root, group.id)
    if (current.session.id !== workspace.session.id || !currentGroup?.tabs.some(tab => tab.id === tabId)) throw new Error('This conversation tab is no longer open.')
    await window.conductor.structured.bindWorkspace(conversation.id, current.session.id)
    const latest = workspaceRef.current
    if (latest.session.id !== current.session.id || !findGroup(latest.layout.root, group.id)?.tabs.some(tab => tab.id === tabId)) throw new Error('This conversation tab is no longer open.')
    const layout = updateTab(latest.layout, group.id, tabId, tab => bindConversationTab(tab, conversation))
    flushSync(() => latest.onLayout(layout))
    await latest.onPersistLayout(layout)
  }

  const close = (tab: PaneTab): void => {
    if (closingTabIds.has(tab.id)) return
    const requestedSessionId = workspace.session.id
    const requestedGroupId = group.id
    debugLog('tabs', 'Tab close requested', { sessionId: requestedSessionId, groupId: requestedGroupId, tabId: tab.id, kind: tab.kind })
    setClosingTabIds((current) => new Set(current).add(tab.id))
    const timer = window.setTimeout(() => {
      closeTimersRef.current.delete(tab.id)
      const currentWorkspace = workspaceRef.current
      const currentGroup = findGroup(currentWorkspace.layout.root, requestedGroupId)
      if (currentWorkspace.session.id !== requestedSessionId || !currentGroup?.tabs.some((item) => item.id === tab.id)) {
        debugLog('tabs', 'Tab close cancelled because its workspace changed', { sessionId: requestedSessionId, groupId: requestedGroupId, tabId: tab.id }, 'warn')
        setClosingTabIds((current) => {
          const next = new Set(current)
          next.delete(tab.id)
          return next
        })
        return
      }
      const apply = (): void => {
        const result = closeTab(currentWorkspace.layout, requestedGroupId, tab.id)
        currentWorkspace.onLayout(result.layout)
        setClosingTabIds(current => { const next = new Set(current); next.delete(tab.id); return next })
        if (result.closed) {
          currentWorkspace.onClosed(result.closed)
          debugLog('tabs', 'Tab closed', { sessionId: requestedSessionId, groupId: requestedGroupId, tabId: tab.id }, 'info')
        }
      }
      // The surviving neighbour must not remount when a split collapses into it, so this
      // relies on SplitView's own flex-basis transition instead of a view-transition snapshot.
      apply()
    }, TAB_ANIMATION_MS)
    closeTimersRef.current.set(tab.id, timer)
  }

  /** One tab button. `gapHere` opens the drag insertion gap in front of it; for the first tab
   * of a group the gap belongs on the group wrapper instead, so the tab never detaches from
   * its own chip mid-drag. */
  const renderTab = (tab: PaneTab, gapHere: boolean): React.JSX.Element => {
    const Icon = iconFor(tab)
    const rawPhase = activity[tab.id] ?? 'idle'
    const correctedPhase = tab.resourceId ? workspace.correctedActivityPhases?.get(tab.resourceId) : undefined
    const tabPhase = correctedPhase ?? rawPhase
    return (
      <button
        key={tab.id}
        data-control-tab-id={tab.id}
        data-control-agent-id={tab.resourceId}
        data-drop-slot-id={tab.id}
        className={`pane-tab ${tab.id === activeTab.id ? 'active' : ''} ${tabPhase === 'waiting_input' ? 'needs-attention' : ''} ${openingTabIds.has(tab.id) ? 'opening' : ''} ${spotlight?.tabId === tab.id ? 'spotlight' : ''} ${closingTabIds.has(tab.id) ? 'closing' : ''} ${isSourceGroup && dragging!.tab.id === tab.id ? 'drag-lifted' : ''}`}
        style={{ marginLeft: gapHere ? dragging!.width : undefined }}
        onClick={() => workspace.onLayout(activateTab(workspace.layout, group.id, tab.id))}
        onContextMenu={event => showContextMenu(event, tab)}
        onPointerDown={(event) => {
          if (event.button !== 1) return
          event.preventDefault()
          event.stopPropagation()
          close(tab)
        }}
        onAuxClick={(event) => event.preventDefault()}
        data-autoscroll="off"
        draggable
        onDragStart={(event) => beginDrag(event, tab)}
      >
        {tab.kind === 'agent' ? <ProviderIcon provider={String(tab.state?.provider ?? 'codex')} size={14} /> : <Icon size={13} strokeWidth={1.8} />}
        <span className="pane-tab-title" title={tab.title}>{tab.title}</span>
        {tab.kind === 'agent' && (tab.state?.continueOnLimit === undefined ? workspace.session.continueOnLimit : Boolean(tab.state.continueOnLimit)) && (
          <span className="tab-limit-continuation" title="Limit continuation is on for this agent"><TimerReset size={12} /></span>
        )}
        {tab.kind === 'agent' && <TabActivityIndicator phase={tabPhase} title={tab.title} spinEpoch={spinEpoch} />}
        <i
          className="tab-close"
          role="button"
          onClick={(event) => { event.stopPropagation(); close(tab) }}
        ><X size={11} /></i>
      </button>
    )
  }

  return (
    <>
    <section
      ref={groupRef}
      data-group-id={group.id}
      className={`pane-group ${focused ? 'focused' : ''} ${group.tabs.length === 1 && closingTabIds.has(activeTab.id) ? 'closing' : ''} ${snapArrival?.groupId === group.id ? `snap-arrival snap-${snapArrival.edge}` : ''} ${canvasEdge ? `dock-hover dock-hover-${canvasEdge}` : ''}`}
      style={{ viewTransitionName: `pane-${group.id.replace(/[^a-zA-Z0-9_-]/g, '-')}` }}
      onMouseDown={() => workspace.onFocus(group.id)}
    >
      {canvasEdge && <div className="dock-preview" />}
      <header
        className="pane-header"
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest('button')) return
          workspace.onMaximize(workspace.maximizedGroupId === group.id ? null : group.id)
        }}
        onContextMenu={event => showContextMenu(event)}
        onPointerDown={(event) => {
          if (event.button !== 1 || (event.target as HTMLElement).closest('.pane-controls')) return
          event.preventDefault()
          event.stopPropagation()
          close(activeTab)
        }}
      >
        <div className="pane-tabs">
          {tabStripSlots(group).map((slot) => {
            if (slot.kind === 'tab') return renderTab(slot.tab, gapBeforeId === slot.tab.id)
            // The gap in front of a group's first tab opens before its chip, so a tab dropped
            // at the head of a run lands outside the group's outline rather than inside it.
            const runFirstId = slot.tabs[0]!.id
            const count = slot.tabs.length
            return (
              <div
                key={slot.group.id}
                className={`tab-group ${slot.collapsed ? 'collapsed' : ''} ${slot.tabs.some((tab) => tab.id === activeTab.id) ? 'has-active' : ''}`}
                data-tab-group-id={slot.group.id}
                data-tab-group-color={slot.group.color}
                style={{ marginLeft: gapBeforeId === runFirstId ? dragging!.width : undefined }}
                {...(slot.collapsed ? { 'data-drop-slot-id': slot.group.id, 'data-drop-span': count } : {})}
              >
                <button
                  className="tab-group-chip"
                  data-tab-group-id={slot.group.id}
                  aria-expanded={!slot.collapsed}
                  title={`${slot.group.title || 'Unnamed group'} - ${count} tab${count === 1 ? '' : 's'}`}
                  onClick={() => workspace.onLayout(collapseTabGroup(workspace.layout, group.id, slot.group.id, !slot.collapsed))}
                  onContextMenu={(event) => showGroupMenu(event, slot.group.id)}
                >
                  <i className="tab-group-dot" data-tab-group-color={slot.group.color} />
                  {slot.group.title && <span className="tab-group-name">{slot.group.title}</span>}
                  {slot.collapsed && <span className="tab-group-count">{count}</span>}
                  {slot.collapsed ? <ChevronRight size={11} className="tab-group-caret" /> : <ChevronDown size={11} className="tab-group-caret" />}
                </button>
                {!slot.collapsed && slot.tabs.map((tab) => renderTab(tab, gapBeforeId === tab.id && tab.id !== runFirstId))}
              </div>
            )
          })}
          <button className="pane-add-tab" style={{ marginLeft: barIndex !== null && gapBeforeId === null ? dragging!.width : undefined }} title="New tab" onClick={() => workspace.onLayout(addTab(workspace.layout, group.id, makeLauncherTab()))}>
            <Plus size={13} />
          </button>
        </div>
        <div className="pane-controls">
          <button
            className="pane-drag-handle"
            draggable
            onDragStart={(event) => beginDrag(event, activeTab)}
            title="Drag tab area"
          ><GripVertical size={17} /></button>
          <button className="pane-menu-button" onClick={(event) => showContextMenu(event)} title="Tab actions"><MoreHorizontal size={19} /></button>
          <button className="pane-close-button" onClick={() => close(activeTab)} title="Close tab"><X size={17} /></button>
        </div>
      </header>
      <div className="pane-content">
        {group.tabs.map((tab) => (
          <div key={tab.id} className="pane-tab-content" data-performance-tab-id={tab.id} style={{ display: tab.id === activeTab.id ? 'flex' : 'none' }}>
            <PaneBody tab={tab} groupId={group.id} project={workspace.project} session={workspace.session} onOpen={open} onOpenFile={openFile} onUpdateTab={setTabState} onConversationChange={changeConversation}
              placement={placement} placementError={placementError} onSelectMachine={choose} />
          </div>
        ))}
      </div>
    </section>
    {menuPosition && <PaneTabMenu x={menuPosition.x} y={menuPosition.y} tab={menuTab}
      maximized={workspace.maximizedGroupId === group.id}
      continuation={menuTab.state?.continueOnLimit === undefined ? workspace.session.continueOnLimit : Boolean(menuTab.state.continueOnLimit)}
      groups={tabGroupsOf(group)}
      onGroupAction={action => runGroupAction(action, menuTab)}
      canReopen={workspace.canReopen} onDismiss={() => setMenuPosition(null)} onAction={action => {
        if (action === 'close') { close(menuTab); return }
        if (action === 'detach' || action === 'show') { workspace.onDetach(group.id, menuTab, { alwaysOnTop: action === 'show' }); return }
        if (action === 'reopen') { workspace.onReopen(group.id); return }
        const result = applyWorkspaceTabAction({ ...workspace.session, layout: workspace.layout, maximizedGroupId: workspace.maximizedGroupId }, group.id, menuTab.id, action)
        workspace.onLayout(result.session.layout)
        workspace.onMaximize(result.session.maximizedGroupId)
        workspace.onFocus(result.focusedGroupId)
      }} />}
    {groupMenu && menuGroup && <TabGroupMenu x={groupMenu.x} y={groupMenu.y} group={menuGroup}
      tabCount={group.tabs.filter(tab => tab.tabGroupId === menuGroup.id).length}
      onDismiss={() => setGroupMenu(null)}
      onAction={action => runGroupAction(action, activeTab)} />}

    </>
  )
}

function SplitView({
  node,
  workspace,
  dragActions,
  dragging,
  dropTarget,
  snapArrival
}: {
  node: LayoutNode
  workspace: PaneWorkspaceProps
  dragActions: PaneDragActions
  dragging: TabDragState | null
  dropTarget: TabDropTarget | null
  snapArrival: { groupId: string; edge: CanvasEdge } | null
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [resizing, setResizing] = useState(false)
  // While the gutter is actually being dragged, sizes are painted from this local state instead
  // of round-tripping every pointer move through workspace.onLayout: that call lands all the way
  // up in the app's own session state, and re-rendering everything hanging off it on every frame
  // is what made dragging the gutter feel janky. The real layout only gets one commit, on release.
  const [liveSizes, setLiveSizes] = useState<[number, number] | null>(null)
  // Dropping the painted sizes before the commit has come back through the layout would show
  // the pane at its old width for a frame, so the drag is held on screen until it lands.
  const committedFirst = node.type === 'split' ? node.sizes[0] : undefined
  useEffect(() => setLiveSizes(null), [committedFirst])
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  // When a group's last tab closes, its parent split collapses and this same slot is handed
  // the surviving child directly (see removeFromNode in layout-operations.ts). Remembering the
  // split shape here lets us keep rendering that child through the same wrapper/position instead
  // of switching this component's return type from <div className="split-node"> to <PaneGroup>,
  // which is what was remounting (and flashing) the surviving pane.
  const prevNodeRef = useRef<LayoutNode>(node)
  const remnantRef = useRef<{ direction: 'horizontal' | 'vertical'; survivorSide: 0 | 1 } | null>(null)
  const prevNode = prevNodeRef.current
  if (node.type === 'split') remnantRef.current = null
  else if (prevNode.type === 'split' && (prevNode.children[0].id === node.id || prevNode.children[1].id === node.id)) {
    remnantRef.current = { direction: prevNode.direction, survivorSide: prevNode.children[0].id === node.id ? 0 : 1 }
  }
  prevNodeRef.current = node
  const remnant = remnantRef.current

  if (node.type === 'group' && !remnant) {
    return (
      <PaneGroup
        key={`${workspace.session.id}:${node.id}`}
        group={node}
        workspace={workspace}
        dragActions={dragActions}
        dragging={dragging}
        dropTarget={dropTarget}
        snapArrival={snapArrival}
      />
    )
  }

  const split = node.type === 'split' ? node : null
  const direction = split ? split.direction : remnant!.direction
  const sizes: [number, number] = split && liveSizes ? liveSizes : split ? split.sizes : remnant!.survivorSide === 0 ? [100, 0] : [0, 100]

  const startResize = (event: React.PointerEvent): void => {
    if (!split || event.button !== 0) return
    event.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const gutter = event.currentTarget
    gutter.setPointerCapture(event.pointerId)
    const axisSize = split.direction === 'horizontal' ? rect.width : rect.height
    const minimumPixels = Math.min(190, axisSize * 0.38)
    const minimumPercent = Math.max(8, (minimumPixels / axisSize) * 100)
    let animationFrame = 0
    let pendingFirst = split.sizes[0]
    let finished = false

    const paint = (): void => {
      animationFrame = 0
      setLiveSizes([pendingFirst, 100 - pendingFirst])
    }
    const move = (moveEvent: PointerEvent): void => {
      const raw = split.direction === 'horizontal'
        ? ((moveEvent.clientX - rect.left) / rect.width) * 100
        : ((moveEvent.clientY - rect.top) / rect.height) * 100
      pendingFirst = Math.min(100 - minimumPercent, Math.max(minimumPercent, raw))
      if (!animationFrame) animationFrame = requestAnimationFrame(paint)
    }
    const stop = (upEvent: PointerEvent): void => {
      if (finished) return
      finished = true
      if (animationFrame) cancelAnimationFrame(animationFrame)
      workspace.onLayout(resizeSplit(workspace.layout, split.id, [pendingFirst, 100 - pendingFirst]))
      if (gutter.hasPointerCapture(upEvent.pointerId)) gutter.releasePointerCapture(upEvent.pointerId)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      gutter.removeEventListener('lostpointercapture', lostCapture)
      document.body.classList.remove('resizing-horizontal', 'resizing-vertical')
      setResizing(false)
    }
    const lostCapture = (lostEvent: Event): void => stop(lostEvent as PointerEvent)
    document.body.classList.add(`resizing-${split.direction}`)
    setResizing(true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    gutter.addEventListener('lostpointercapture', lostCapture)
  }

  const nudgeResize = (event: React.KeyboardEvent): void => {
    if (!split) return
    const relevant = split.direction === 'horizontal'
      ? ['ArrowLeft', 'ArrowRight']
      : ['ArrowUp', 'ArrowDown']
    if (!relevant.includes(event.key)) return
    event.preventDefault()
    const decreasing = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    const first = Math.min(90, Math.max(10, split.sizes[0] + (decreasing ? -2 : 2)))
    workspace.onLayout(resizeSplit(workspace.layout, split.id, [first, 100 - first]))
  }

  const renderChild = (side: 0 | 1): React.JSX.Element | null => {
    if (split) return <SplitView node={split.children[side]} workspace={workspace} dragActions={dragActions} dragging={dragging} dropTarget={dropTarget} snapArrival={snapArrival} />
    if (side === remnant!.survivorSide) return <SplitView node={node} workspace={workspace} dragActions={dragActions} dragging={dragging} dropTarget={dropTarget} snapArrival={snapArrival} />
    return null
  }

  return (
    <div ref={containerRef} className={`split-node ${direction} ${ready && !resizing ? 'animate-resize' : ''}`}>
      <div className="split-child" style={{ flexBasis: `${sizes[0]}%` }}>{renderChild(0)}</div>
      <button
        className={`split-gutter ${resizing ? 'active' : ''}`}
        style={{ display: split ? undefined : 'none' }}
        onPointerDown={startResize}
        onDoubleClick={() => split && workspace.onLayout(resizeSplit(workspace.layout, split.id, [50, 50]))}
        onKeyDown={nudgeResize}
        role="separator"
        aria-hidden={!split}
        tabIndex={split ? 0 : -1}
        aria-label="Resize tab areas"
        aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
        aria-valuemin={10}
        aria-valuemax={90}
        aria-valuenow={Math.round(sizes[0])}
      >
        <i />
        {resizing && <span>{Math.round(sizes[0])} / {Math.round(sizes[1])}</span>}
      </button>
      <div className="split-child" style={{ flexBasis: `${sizes[1]}%` }}>{renderChild(1)}</div>
    </div>
  )
}

/** Measures the pane under the pointer (falling back to the drag's own pane so a drop always
 * lands somewhere). Only `.pane-group` and `.pane-header` are read: the dock preview squeezes
 * `.pane-content`, so its box lies about where the pane really is mid-drag. */
const measurePaneAt = (x: number, y: number, fallbackGroupId: string): PaneGeometry | null => {
  const el = document.elementFromPoint(x, y)
  const groupEl = (el?.closest('.pane-group') as HTMLElement | null) ?? (document.querySelector(`.pane-group[data-group-id="${CSS.escape(fallbackGroupId)}"]`) as HTMLElement | null)
  const groupId = groupEl?.dataset.groupId
  if (!groupEl || !groupId) return null
  const rect = groupEl.getBoundingClientRect()
  const header = groupEl.querySelector<HTMLElement>('.pane-header')
  const tabs: TabRect[] = Array.from(groupEl.querySelectorAll<HTMLElement>('.pane-tabs [data-drop-slot-id]')).map((slotEl) => {
    const slotRect = slotEl.getBoundingClientRect()
    return {
      id: slotEl.dataset.dropSlotId!,
      left: slotRect.left,
      right: slotRect.right,
      span: slotEl.dataset.dropSpan ? Number(slotEl.dataset.dropSpan) : 1
    }
  })
  return {
    groupId,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    headerBottom: header ? header.getBoundingClientRect().bottom : rect.top,
    tabs
  }
}

/** Chrome-exact drop resolution for a pointer position: over a tab bar it's an insertion
 * index into that bar, anywhere else it's the nearest edge of whatever pane sits under the
 * pointer, so a drop always lands somewhere. */
const resolveDropTarget = (x: number, y: number, sourceGroupId: string, draggedTabId: string): TabDropTarget | null => {
  const pane = measurePaneAt(x, y, sourceGroupId)
  return pane ? dropTargetAt({ x, y }, pane, draggedTabId) : null
}

const sameDropTarget = (a: TabDropTarget | null, b: TabDropTarget | null): boolean => JSON.stringify(a) === JSON.stringify(b)

export function PaneWorkspace(props: PaneWorkspaceProps): React.JSX.Element {
  const [dragging, setDragging] = useState<TabDragState | null>(null)
  const [dropTarget, setDropTarget] = useState<TabDropTarget | null>(null)
  const [snapArrival, setSnapArrival] = useState<{ groupId: string; edge: CanvasEdge } | null>(null)
  const dragGhostRef = useRef<HTMLDivElement>(null)
  const latestTargetRef = useRef<TabDropTarget | null>(null)
  // Mirrors `dragging` synchronously from the dragstart handler. The listeners below are
  // registered once for the lifetime of the workspace rather than by an effect keyed on
  // `dragging`, so they cannot miss the first dragover while React is still committing.
  const draggingRef = useRef<TabDragState | null>(null)
  // Whether *this* window's own commitDrop already handled the drop in progress. dragend fires
  // in the window a drag started in no matter which window actually received the drop, so this
  // is what tells that difference apart from a plain rejected drag.
  const consumedRef = useRef(false)
  const propsRef = useRef(props)
  propsRef.current = props
  const maximized = props.maximizedGroupId ? findGroup(props.layout.root, props.maximizedGroupId) : null
  const emptyGroup = props.layout.root.type === 'group' && props.layout.root.tabs.length === 0

  useEffect(() => {
    let foreignStaleTimer = 0
    const clearForeignSoon = (): void => {
      window.clearTimeout(foreignStaleTimer)
      // A foreign drag never fires dragend or dragleave reliably in this window - only the
      // window it started in gets those - so its preview has to expire itself once dragover
      // stops arriving, which is what happens the instant the pointer leaves for good.
      foreignStaleTimer = window.setTimeout(() => {
        latestTargetRef.current = null
        setDragging(null)
        setDropTarget(null)
      }, 150)
    }
    const endDrag = (event: DragEvent): void => {
      window.clearTimeout(foreignStaleTimer)
      const drag = draggingRef.current
      if (drag && !consumedRef.current) {
        if (event.dataTransfer?.dropEffect === 'move') {
          // Nothing in this window accepted the drop, yet it was accepted somewhere: another
          // Conductor window just grafted this tab into its own layout, so this window's copy
          // has to go, and with it a detached window that has nothing left to show.
          const current = propsRef.current
          const result = closeTab(current.layout, drag.sourceGroupId, drag.tab.id)
          if (result.closed) current.onLayout(result.layout)
        } else {
          // Native applications often zero out DragEvent screen coordinates when they accept
          // the drop. Electron's cursor position remains reliable across apps, and every
          // dragover inside a Conductor window already preventDefaults, so dropEffect only
          // stays 'none' here when the drag ended outside every one of them entirely.
          void window.conductor.window.isCursorOutside().then((outsideWindow) => {
            if (outsideWindow) propsRef.current.onDetach(drag.sourceGroupId, drag.tab)
          })
        }
      }
      latestTargetRef.current = null
      draggingRef.current = null
      consumedRef.current = false
      setDragging(null)
      setDropTarget(null)
    }
    const trackPointer = (event: DragEvent): void => {
      const drag = draggingRef.current
      if (drag) {
        if (!event.clientX && !event.clientY) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
        if (dragGhostRef.current) dragGhostRef.current.style.transform = `translate3d(${event.clientX + 14}px, ${event.clientY + 14}px, 0)`
        const found = resolveDropTarget(event.clientX, event.clientY, drag.sourceGroupId, drag.tab.id)
        const resolved = found && tabDropLands(propsRef.current.layout, drag.sourceGroupId, drag.tab.id, found) ? found : null
        latestTargetRef.current = resolved
        setDropTarget((current) => sameDropTarget(current, resolved) ? current : resolved)
        return
      }
      // A tab dragged in from another window: its own data is unreadable until it drops, but
      // the mimetype alone is enough to preview and accept the drop here.
      if (!event.dataTransfer?.types.includes(CROSS_WINDOW_TAB_MIME)) return
      if (!event.clientX && !event.clientY) return
      event.preventDefault()
      clearForeignSoon()
      if (dragGhostRef.current) dragGhostRef.current.style.transform = `translate3d(${event.clientX + 14}px, ${event.clientY + 14}px, 0)`
      const found = resolveDropTarget(event.clientX, event.clientY, '', FOREIGN_DRAG_TAB.id)
      if (event.dataTransfer) event.dataTransfer.dropEffect = found ? 'move' : 'none'
      latestTargetRef.current = found
      setDragging((current) => current ?? { sourceGroupId: '', tab: FOREIGN_DRAG_TAB, width: FOREIGN_DRAG_WIDTH, x: event.clientX, y: event.clientY })
      setDropTarget((current) => sameDropTarget(current, found) ? current : found)
    }
    const commitDrop = (event: DragEvent): void => {
      const drag = draggingRef.current
      if (drag) {
        event.preventDefault()
        consumedRef.current = true
        const target = latestTargetRef.current
        if (target) {
          const current = propsRef.current
          current.onLayout(applyTabDrop(current.layout, drag.sourceGroupId, drag.tab.id, target))
          current.onFocus(target.groupId)
          if (target.kind === 'canvas') setSnapArrival({ groupId: target.groupId, edge: target.edge })
        }
        endDrag(event)
        return
      }
      const raw = event.dataTransfer?.getData(CROSS_WINDOW_TAB_MIME)
      const payload = raw ? decodeCrossWindowTab(raw) : null
      const target = latestTargetRef.current
      if (payload && target) {
        event.preventDefault()
        const current = propsRef.current
        current.onLayout(insertForeignTab(current.layout, payload.tab, target))
        current.onFocus(target.groupId)
        if (target.kind === 'canvas') setSnapArrival({ groupId: target.groupId, edge: target.edge })
      }
      window.clearTimeout(foreignStaleTimer)
      latestTargetRef.current = null
      setDragging(null)
      setDropTarget(null)
    }
    document.addEventListener('dragover', trackPointer, true)
    document.addEventListener('drop', commitDrop, true)
    document.addEventListener('dragend', endDrag, true)
    return () => {
      window.clearTimeout(foreignStaleTimer)
      document.removeEventListener('dragover', trackPointer, true)
      document.removeEventListener('drop', commitDrop, true)
      document.removeEventListener('dragend', endDrag, true)
    }
  }, [])

  useEffect(() => {
    if (!snapArrival) return
    const timer = window.setTimeout(() => setSnapArrival(null), 320)
    return () => window.clearTimeout(timer)
  }, [snapArrival])

  const dragActions: PaneDragActions = {
    start: (sourceGroupId, tab, width, point) => {
      draggingRef.current = { sourceGroupId, tab, width, ...point }
      consumedRef.current = false
      setDragging(draggingRef.current)
      if (props.maximizedGroupId) {
        window.setTimeout(() => {
          const transitionDocument = document as Document & {
            startViewTransition?: (update: () => void) => { finished: Promise<void> }
          }
          if (transitionDocument.startViewTransition) {
            transitionDocument.startViewTransition(() => flushSync(() => props.onMaximize(null)))
          } else {
            flushSync(() => props.onMaximize(null))
          }
        }, 0)
      }
    }
  }
  const DragIcon = dragging ? iconFor(dragging.tab) : FileText
  return (
    <div className={`pane-workspace ${dragging ? 'dragging' : ''}`}>
      <AgentControlLinks projectId={props.project.id} sessionId={props.session.id} layout={props.layout} />
      {emptyGroup ? (
        <div className="empty-pane-workspace">
          <div>
            <strong>No tabs open</strong>
          </div>
          <button onClick={() => props.onLayout(addTab(props.layout, props.layout.root.id, makeLauncherTab()))}><Plus size={15} /> New tab</button>
          <button disabled={!props.canReopen} onClick={() => props.onReopen(props.layout.root.id)}><Undo2 size={14} /> Reopen</button>
        </div>
      ) : (
        <SplitView node={maximized ?? props.layout.root} workspace={props} dragActions={dragActions} dragging={dragging} dropTarget={dropTarget} snapArrival={snapArrival} />
      )}
      {maximized && <div className="maximized-badge">MAXIMIZED</div>}
      {dragging && createPortal(
        <div
          ref={dragGhostRef}
          className="pane-drag-ghost"
          style={{ transform: `translate3d(${dragging.x + 14}px, ${dragging.y + 14}px, 0)` }}
        >
          <DragIcon size={13} strokeWidth={1.8} /><span>{dragging.tab.title}</span>
        </div>,
        document.body
      )}
    </div>
  )
}
