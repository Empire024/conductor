import { ProviderIcon } from '../components/ProviderIcon'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import {
  Bell,
  Bot,
  Braces,
  Copy,
  ExternalLink,
  FileText,
  FileSearch,
  FolderTree,
  Globe2,
  GripVertical,
  Maximize2,
  MoreHorizontal,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Plus,
  TerminalSquare,
  TimerReset,
  Undo2,
  X
} from 'lucide-react'
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
  closeTab,
  dockTab,
  duplicateTab,
  findGroup,
  listGroups,
  resizeSplit,
  splitGroup,
  type DockEdge,
  replaceTab,
  updateTab
} from './layout-operations'
import { createPaneTab } from '../panes/pane-factory'
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
  focusedGroupId: string
  maximizedGroupId: string | null
  onLayout(layout: WorkspaceLayout): void
  onFocus(groupId: string): void
  onMaximize(groupId: string | null): void
  onClosed(tab: PaneTab): void
  onDetach(groupId: string, tab: PaneTab): void
  canReopen: boolean
  onReopen(groupId: string): void
  onOpenFile?(path: string, line?: number): void
}

interface PaneDragActions {
  start(groupId: string, tab: PaneTab, point: { x: number; y: number }): void
  end(): void
  preview(groupId: string, edge: DockEdge, rect: DOMRect): void
  arrive(groupId: string, edge: DockEdge): void
}

interface DockPreviewState {
  groupId: string
  edge: DockEdge
  title: string
  left: number
  top: number
  width: number
  height: number
}

const iconFor = (tab: PaneTab): typeof Bot => {
  if (tab.kind === 'agent') return Bot
  if (tab.kind === 'terminal') return TerminalSquare
  if (tab.kind === 'file-tree') return FolderTree
  if (tab.kind === 'code') return Braces
  if (tab.kind === 'preview') return FileSearch
  if (tab.kind === 'browser') return Globe2
  return FileText
}

const TAB_ANIMATION_MS = 110

const layoutShape = (layout: WorkspaceLayout): string => {
  const shape = (node: LayoutNode): unknown => node.type === 'group'
    ? { type: 'group', tabs: node.tabs.map((tab) => tab.id), active: node.activeTabId }
    : { type: 'split', direction: node.direction, sizes: node.sizes.map(Math.round), children: node.children.map(shape) }
  return JSON.stringify(shape(layout.root))
}

const PaneBody = ({
  tab,
  groupId,
  project,
  session,
  onOpen,
  onOpenFile,
  onUpdateTab
}: {
  tab: PaneTab
  groupId: string
  project: ProjectRecord
  session: SessionRecord
  onOpen(kind: PaneKind, provider?: AgentProviderId): void
  onOpenFile(path: string, line?: number): void
  onUpdateTab(tabId: string, state: Record<string, unknown>): void
}): React.JSX.Element => {
  if (tab.kind === 'launcher') return <LauncherPane onOpen={onOpen} />
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
        onModelChange={(model) => onUpdateTab(tab.id, { ...tab.state, model })}
        onEffortChange={(effort) => onUpdateTab(tab.id, { ...tab.state, effort })}
        onViewModeChange={(viewMode) => onUpdateTab(tab.id, { ...tab.state, viewMode })}
      />
    )
  }
  if (tab.kind === 'file-tree') return <FileTreePane project={project} onOpenFile={onOpenFile} />
  if (tab.kind === 'code') return <CodePane project={project} tabId={tab.id} path={(tab.state?.path as string) ?? tab.resourceId ?? ''} line={tab.state?.line as number | undefined} />
  if (tab.kind === 'preview') return <FilePreviewPane project={project} path={(tab.state?.path as string) ?? tab.resourceId ?? ''} onOpenEditor={onOpenFile} />
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
  arrivalEdge,
  hoverEdge,
  dragSourceGroupId,
  dragSourceTabId
}: {
  group: PaneGroupNode
  workspace: PaneWorkspaceProps
  dragActions: PaneDragActions
  arrivalEdge: DockEdge | null
  hoverEdge: DockEdge | null
  dragSourceGroupId: string | null
  dragSourceTabId: string | null
}): React.JSX.Element {
  const groupRef = useRef<HTMLElement>(null)
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null)
  const [activity, setActivity] = useState<Record<string, AgentActivityPhase>>({})
  const [closingTabIds, setClosingTabIds] = useState<Set<string>>(() => new Set())
  const [openingTabIds, setOpeningTabIds] = useState<Set<string>>(() => new Set())
  const knownTabIdsRef = useRef(new Set(group.tabs.map((tab) => tab.id)))
  const closeTimersRef = useRef(new Map<string, number>())
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const activeTab = group.tabs.find((tab) => tab.id === group.activeTabId) ?? group.tabs[0]!
  const focused = workspace.focusedGroupId === group.id
  const sourceGroup = dragSourceGroupId ? findGroup(workspace.layout.root, dragSourceGroupId) : null
  const possibleEdges: DockEdge[] = !sourceGroup
    ? []
    : sourceGroup.id !== group.id
      ? ['left', 'right', 'above', 'below', 'center']
      : sourceGroup.tabs.length > 1
        ? ['left', 'right', 'above', 'below']
        : []
  const currentShape = layoutShape(workspace.layout)
  const validEdges = possibleEdges.filter((edge) =>
    layoutShape(dockTab(workspace.layout, sourceGroup!.id, dragSourceTabId ?? '', group.id, edge)) !== currentShape
  )

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
    event.dataTransfer.setData('application/x-conductor-pane', JSON.stringify({ groupId: group.id, tabId: tab.id }))
    const transparentImage = document.createElement('canvas')
    transparentImage.width = 1
    transparentImage.height = 1
    event.dataTransfer.setDragImage(transparentImage, 0, 0)
    dragActions.start(group.id, tab, { x: event.clientX, y: event.clientY })
  }

  const finishDrag = (event: React.DragEvent, tab: PaneTab): void => {
    const wasNotDocked = event.dataTransfer.dropEffect === 'none'
    dragActions.end()
    if (!wasNotDocked) return

    // Native applications often zero out DragEvent screen coordinates when they
    // accept the drop. Electron's cursor position remains reliable across apps.
    void window.conductor.window.isCursorOutside().then((outsideWindow) => {
      if (outsideWindow) workspace.onDetach(group.id, tab)
    })
  }

  const previewDock = (edge: DockEdge, event: React.DragEvent): void => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = groupRef.current?.getBoundingClientRect()
    if (rect) dragActions.preview(group.id, edge, rect)
  }

  const showContextMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    workspace.onFocus(group.id)
    if (event.type === 'click' && menuPosition) { setMenuPosition(null); return }
    setMenuPosition({
      x: Math.min(event.clientX, window.innerWidth - 205),
      y: Math.min(event.clientY, window.innerHeight - 315)
    })
  }

  const open = (kind: PaneKind, provider?: AgentProviderId): void => {
    if (kind !== 'agent' && kind !== 'terminal') return
    const tab = createPaneTab(kind, { provider })
    workspace.onLayout(replaceTab(workspace.layout, group.id, activeTab.id, tab))
  }

  const openFile = (path: string, line?: number): void => {
    workspace.onOpenFile?.(path, line)
  }

  const setTabState = (tabId: string, state: Record<string, unknown>): void => {
    workspace.onLayout(updateTab(workspace.layout, group.id, tabId, (tab) => ({ ...tab, state })))
  }

  const split = (edge: Exclude<DockEdge, 'center'>): void => {
    const launcher = makeLauncherTab()
    const next = splitGroup(workspace.layout, group.id, edge, launcher)
    workspace.onLayout(next)
    const created = findGroup(next.root, group.id)
    const locateNew = (node: LayoutNode): string | null => {
      if (node.type === 'group') return node.tabs.some((tab) => tab.id === launcher.id) ? node.id : null
      return locateNew(node.children[0]) ?? locateNew(node.children[1])
    }
    workspace.onFocus(locateNew(next.root) ?? created?.id ?? group.id)
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
        if (result.closed) {
          currentWorkspace.onClosed(result.closed)
          debugLog('tabs', 'Tab closed', { sessionId: requestedSessionId, groupId: requestedGroupId, tabId: tab.id }, 'info')
        }
      }
      const transitionDocument = document as Document & { startViewTransition?: (update: () => void) => unknown }
      if (transitionDocument.startViewTransition) transitionDocument.startViewTransition(() => flushSync(apply))
      else apply()
    }, TAB_ANIMATION_MS)
    closeTimersRef.current.set(tab.id, timer)
  }

  const drop = (edge: DockEdge, event: React.DragEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    try {
      const data = JSON.parse(event.dataTransfer.getData('application/x-conductor-pane')) as {
        groupId: string
        tabId: string
      }
      const next = dockTab(workspace.layout, data.groupId, data.tabId, group.id, edge)
      const destination = listGroups(next.root).find((candidate) =>
        candidate.tabs.some((tab) => tab.id === data.tabId)
      )
      const destinationId = destination?.id ?? group.id
      const applySnap = (): void => {
        workspace.onLayout(next)
        workspace.onFocus(destinationId)
        dragActions.arrive(destinationId, edge)
      }
      const transitionDocument = document as Document & {
        startViewTransition?: (update: () => void) => { finished: Promise<void> }
      }
      if (transitionDocument.startViewTransition) {
        transitionDocument.startViewTransition(() => flushSync(applySnap))
      } else {
        flushSync(applySnap)
      }
    } finally {
      dragActions.end()
    }
  }

  return (
    <>
    <section
      ref={groupRef}
      className={`pane-group ${focused ? 'focused' : ''} ${group.tabs.length === 1 && closingTabIds.has(activeTab.id) ? 'closing' : ''} ${arrivalEdge ? `snap-arrival snap-${arrivalEdge}` : ''} ${hoverEdge ? `dock-hover dock-hover-${hoverEdge}` : ''}`}
      style={{ viewTransitionName: `pane-${group.id.replace(/[^a-zA-Z0-9_-]/g, '-')}` }}
      onMouseDown={() => workspace.onFocus(group.id)}
    >
      <header
        className="pane-header"
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest('button')) return
          workspace.onMaximize(workspace.maximizedGroupId === group.id ? null : group.id)
        }}
        onContextMenu={showContextMenu}
        onPointerDown={(event) => {
          if (event.button !== 1 || (event.target as HTMLElement).closest('.pane-controls')) return
          event.preventDefault()
          event.stopPropagation()
          close(activeTab)
        }}
      >
        <div className="pane-tabs">
          {group.tabs.map((tab) => {
            const Icon = iconFor(tab)
            const tabPhase = activity[tab.id] ?? 'idle'
            return (
              <button
                key={tab.id}
                className={`pane-tab ${tab.id === activeTab.id ? 'active' : ''} ${tabPhase === 'waiting_input' ? 'needs-attention' : ''} ${openingTabIds.has(tab.id) ? 'opening' : ''} ${closingTabIds.has(tab.id) ? 'closing' : ''}`}
                onClick={() => workspace.onLayout(activateTab(workspace.layout, group.id, tab.id))}
                onPointerDown={(event) => {
                  if (event.button !== 1) return
                  event.preventDefault()
                  event.stopPropagation()
                  close(tab)
                }}
                onAuxClick={(event) => event.preventDefault()}
                draggable
                onDragStart={(event) => beginDrag(event, tab)}
                onDragEnd={(event) => finishDrag(event, tab)}
              >
                {tab.kind === 'agent' ? <ProviderIcon provider={String(tab.state?.provider ?? 'codex')} size={14} /> : <Icon size={13} strokeWidth={1.8} />}
                <span className="pane-tab-title" title={tab.title}>{tab.title}</span>
                {tab.kind === 'agent' && (tab.state?.continueOnLimit === undefined ? workspace.session.continueOnLimit : Boolean(tab.state.continueOnLimit)) && (
                  <span className="tab-limit-continuation" title="Limit continuation is on for this agent"><TimerReset size={12} /></span>
                )}
                {tab.kind === 'agent' && (
                  <span className={`tab-activity ${tabPhase}`} aria-label={tabPhase === 'waiting_input' ? `${tab.title} needs your attention` : tabPhase} title={tabPhase === 'waiting_input' ? 'Needs your attention' : undefined}>
                    {tabPhase === 'waiting_input'
                      ? <Bell className="tab-attention-bell" aria-hidden="true" />
                      : <svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6" /><path d="M5.7 9.2 8 11.4l4.5-5" /></svg>}
                  </span>
                )}
                <i
                  className="tab-close"
                  role="button"
                  onClick={(event) => { event.stopPropagation(); close(tab) }}
                ><X size={11} /></i>
              </button>
            )
          })}
          <button className="pane-add-tab" title="New tab" onClick={() => workspace.onLayout(addTab(workspace.layout, group.id, makeLauncherTab()))}>
            <Plus size={13} />
          </button>
        </div>
        <div className="pane-controls">
          <button
            className="pane-drag-handle"
            draggable
            onDragStart={(event) => beginDrag(event, activeTab)}
            onDragEnd={(event) => finishDrag(event, activeTab)}
            title="Drag tab area"
          ><GripVertical size={17} /></button>
          <button className="pane-menu-button" onClick={(event) => showContextMenu(event)} title="Tab actions"><MoreHorizontal size={19} /></button>
          <button className="pane-close-button" onClick={() => close(activeTab)} title="Close tab"><X size={17} /></button>
        </div>
      </header>
      <div className="pane-content">
        {group.tabs.map((tab) => (
          <div key={tab.id} className="pane-tab-content" data-performance-tab-id={tab.id} style={{ display: tab.id === activeTab.id ? 'flex' : 'none' }}>
            <PaneBody tab={tab} groupId={group.id} project={workspace.project} session={workspace.session} onOpen={open} onOpenFile={openFile} onUpdateTab={setTabState} />
          </div>
        ))}
      </div>
      <div className="dock-overlay" aria-hidden="true">
        {validEdges.includes('left') && <button className="dock-zone dock-left" onDragEnter={(event) => previewDock('left', event)} onDragOver={(event) => previewDock('left', event)} onDrop={(event) => drop('left', event)}><PanelLeft size={20} /><span>Place left</span></button>}
        {validEdges.includes('right') && <button className="dock-zone dock-right" onDragEnter={(event) => previewDock('right', event)} onDragOver={(event) => previewDock('right', event)} onDrop={(event) => drop('right', event)}><PanelRight size={20} /><span>Place right</span></button>}
        {validEdges.includes('above') && <button className="dock-zone dock-top" onDragEnter={(event) => previewDock('above', event)} onDragOver={(event) => previewDock('above', event)} onDrop={(event) => drop('above', event)}><PanelTop size={20} /><span>Place above</span></button>}
        {validEdges.includes('below') && <button className="dock-zone dock-bottom" onDragEnter={(event) => previewDock('below', event)} onDragOver={(event) => previewDock('below', event)} onDrop={(event) => drop('below', event)}><PanelBottom size={20} /><span>Place below</span></button>}
        {validEdges.includes('center') && <button className="dock-zone dock-center" onDragEnter={(event) => previewDock('center', event)} onDragOver={(event) => previewDock('center', event)} onDrop={(event) => drop('center', event)}><Plus size={22} /><span>Join as tabs</span></button>}
        {validEdges.length === 0 && <div className="dock-detach-hint"><ExternalLink size={19} /><span>Drag outside Conductor for a separate window</span></div>}
      </div>
    </section>
    {menuPosition && createPortal(
      <div
        className="conductor-menu cursor-context-menu pane-context-menu"
        style={{ left: menuPosition.x, top: menuPosition.y }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="context-menu-label">{activeTab.title}</div>
        <button onClick={() => { split('left'); setMenuPosition(null) }}><PanelLeft size={13} /> Split left</button>
        <button onClick={() => { split('right'); setMenuPosition(null) }}><PanelRight size={13} /> Split right</button>
        <button onClick={() => { split('above'); setMenuPosition(null) }}><PanelTop size={13} /> Split above</button>
        <button onClick={() => { split('below'); setMenuPosition(null) }}><PanelBottom size={13} /> Split below</button>
        <div />
        <button onClick={() => { workspace.onLayout(addTab(workspace.layout, group.id, duplicateTab(activeTab))); setMenuPosition(null) }}><Copy size={13} /> Duplicate tab</button>
        <button onClick={() => { workspace.onDetach(group.id, activeTab); setMenuPosition(null) }}><ExternalLink size={13} /> Open as window</button>
        <button onClick={() => { workspace.onMaximize(workspace.maximizedGroupId === group.id ? null : group.id); setMenuPosition(null) }}><Maximize2 size={13} /> {workspace.maximizedGroupId === group.id ? 'Restore layout' : 'Maximize tab'}</button>
        {activeTab.kind === 'agent' && (
          <button onClick={() => {
            const effective = activeTab.state?.continueOnLimit === undefined
              ? workspace.session.continueOnLimit
              : Boolean(activeTab.state.continueOnLimit)
            setTabState(activeTab.id, { ...activeTab.state, continueOnLimit: !effective })
            setMenuPosition(null)
          }}><TimerReset size={13} /> {(activeTab.state?.continueOnLimit === undefined ? workspace.session.continueOnLimit : Boolean(activeTab.state.continueOnLimit)) ? 'Disable limit continuation' : 'Enable limit continuation'}</button>
        )}
        <button disabled={!workspace.canReopen} onClick={() => { workspace.onReopen(group.id); setMenuPosition(null) }}><Undo2 size={13} /> Retrieve closed tab</button>
        <div />
        <button className="danger" onClick={() => { close(activeTab); setMenuPosition(null) }}><X size={13} /> Close tab</button>
      </div>,
      document.body
    )}
    </>
  )
}

function SplitView({
  node,
  workspace,
  dragActions,
  snapArrival,
  dockHover,
  dragSourceGroupId,
  dragSourceTabId
}: {
  node: LayoutNode
  workspace: PaneWorkspaceProps
  dragActions: PaneDragActions
  snapArrival: { groupId: string; edge: DockEdge } | null
  dockHover: { groupId: string; edge: DockEdge } | null
  dragSourceGroupId: string | null
  dragSourceTabId: string | null
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [resizing, setResizing] = useState(false)
  if (node.type === 'group') {
    return (
      <PaneGroup
        key={`${workspace.session.id}:${node.id}`}
        group={node}
        workspace={workspace}
        dragActions={dragActions}
        arrivalEdge={snapArrival?.groupId === node.id ? snapArrival.edge : null}
        hoverEdge={dockHover?.groupId === node.id ? dockHover.edge : null}
        dragSourceGroupId={dragSourceGroupId}
        dragSourceTabId={dragSourceTabId}
      />
    )
  }

  const startResize = (event: React.PointerEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const gutter = event.currentTarget
    gutter.setPointerCapture(event.pointerId)
    const axisSize = node.direction === 'horizontal' ? rect.width : rect.height
    const minimumPixels = Math.min(190, axisSize * 0.38)
    const minimumPercent = Math.max(8, (minimumPixels / axisSize) * 100)
    let animationFrame = 0
    let pendingFirst = node.sizes[0]
    let finished = false

    const commit = (): void => {
      animationFrame = 0
      workspace.onLayout(resizeSplit(workspace.layout, node.id, [pendingFirst, 100 - pendingFirst]))
    }
    const move = (moveEvent: PointerEvent): void => {
      const raw = node.direction === 'horizontal'
        ? ((moveEvent.clientX - rect.left) / rect.width) * 100
        : ((moveEvent.clientY - rect.top) / rect.height) * 100
      pendingFirst = Math.min(100 - minimumPercent, Math.max(minimumPercent, raw))
      if (!animationFrame) animationFrame = requestAnimationFrame(commit)
    }
    const stop = (upEvent: PointerEvent): void => {
      if (finished) return
      finished = true
      if (animationFrame) {
        cancelAnimationFrame(animationFrame)
        commit()
      }
      if (gutter.hasPointerCapture(upEvent.pointerId)) gutter.releasePointerCapture(upEvent.pointerId)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      gutter.removeEventListener('lostpointercapture', lostCapture)
      document.body.classList.remove('resizing-horizontal', 'resizing-vertical')
      setResizing(false)
    }
    const lostCapture = (lostEvent: Event): void => stop(lostEvent as PointerEvent)
    document.body.classList.add(`resizing-${node.direction}`)
    setResizing(true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    gutter.addEventListener('lostpointercapture', lostCapture)
  }

  const nudgeResize = (event: React.KeyboardEvent): void => {
    const relevant = node.direction === 'horizontal'
      ? ['ArrowLeft', 'ArrowRight']
      : ['ArrowUp', 'ArrowDown']
    if (!relevant.includes(event.key)) return
    event.preventDefault()
    const decreasing = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    const first = Math.min(90, Math.max(10, node.sizes[0] + (decreasing ? -2 : 2)))
    workspace.onLayout(resizeSplit(workspace.layout, node.id, [first, 100 - first]))
  }

  return (
    <div ref={containerRef} className={`split-node ${node.direction}`}>
      <div className="split-child" style={{ flexBasis: `${node.sizes[0]}%` }}>
        <SplitView node={node.children[0]} workspace={workspace} dragActions={dragActions} snapArrival={snapArrival} dockHover={dockHover} dragSourceGroupId={dragSourceGroupId} dragSourceTabId={dragSourceTabId} />
      </div>
      <button
        className={`split-gutter ${resizing ? 'active' : ''}`}
        onPointerDown={startResize}
        onDoubleClick={() => workspace.onLayout(resizeSplit(workspace.layout, node.id, [50, 50]))}
        onKeyDown={nudgeResize}
        role="separator"
        aria-label="Resize tab areas"
        aria-orientation={node.direction === 'horizontal' ? 'vertical' : 'horizontal'}
        aria-valuemin={10}
        aria-valuemax={90}
        aria-valuenow={Math.round(node.sizes[0])}
      >
        <i />
        {resizing && <span>{Math.round(node.sizes[0])} / {Math.round(node.sizes[1])}</span>}
      </button>
      <div className="split-child" style={{ flexBasis: `${node.sizes[1]}%` }}>
        <SplitView node={node.children[1]} workspace={workspace} dragActions={dragActions} snapArrival={snapArrival} dockHover={dockHover} dragSourceGroupId={dragSourceGroupId} dragSourceTabId={dragSourceTabId} />
      </div>
    </div>
  )
}

export function PaneWorkspace(props: PaneWorkspaceProps): React.JSX.Element {
  const [dragging, setDragging] = useState<{ sourceGroupId: string; tab: PaneTab; x: number; y: number } | null>(null)
  const [dockPreview, setDockPreview] = useState<DockPreviewState | null>(null)
  const [snapArrival, setSnapArrival] = useState<{ groupId: string; edge: DockEdge } | null>(null)
  const dragGhostRef = useRef<HTMLDivElement>(null)
  const maximized = props.maximizedGroupId ? findGroup(props.layout.root, props.maximizedGroupId) : null
  const emptyGroup = props.layout.root.type === 'group' && props.layout.root.tabs.length === 0

  useEffect(() => {
    if (!dragging) return
    const trackPointer = (event: DragEvent): void => {
      if (!event.clientX && !event.clientY) return
      if (dragGhostRef.current) {
        dragGhostRef.current.style.transform = `translate3d(${event.clientX + 16}px, ${event.clientY + 16}px, 0)`
      }
    }
    const cancel = (): void => {
      setDragging(null)
      setDockPreview(null)
    }
    document.addEventListener('dragover', trackPointer, true)
    document.addEventListener('dragend', cancel, true)
    return () => {
      document.removeEventListener('dragover', trackPointer, true)
      document.removeEventListener('dragend', cancel, true)
    }
  }, [dragging])

  useEffect(() => {
    if (!snapArrival) return
    const timer = window.setTimeout(() => setSnapArrival(null), 320)
    return () => window.clearTimeout(timer)
  }, [snapArrival])

  const dragActions: PaneDragActions = {
    start: (sourceGroupId, tab, point) => {
      setDockPreview(null)
      setDragging({ sourceGroupId, tab, ...point })
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
    },
    end: () => {
      setDragging(null)
      setDockPreview(null)
    },
    arrive: (groupId, edge) => setSnapArrival({ groupId, edge }),
    preview: (groupId, edge, rect) => {
      const inset = 5
      const availableWidth = Math.max(0, rect.width - inset * 2)
      const availableHeight = Math.max(0, rect.height - inset * 2)
      const halfWidth = availableWidth / 2
      const halfHeight = availableHeight / 2
      setDockPreview({
        groupId,
        edge,
        title: dragging?.tab.title ?? 'Tab',
        left: rect.left + inset + (edge === 'right' ? halfWidth : 0),
        top: rect.top + inset + (edge === 'below' ? halfHeight : 0),
        width: edge === 'left' || edge === 'right' ? halfWidth : availableWidth,
        height: edge === 'above' || edge === 'below' ? halfHeight : availableHeight
      })
    }
  }
  const DragIcon = dragging ? iconFor(dragging.tab) : FileText
  return (
    <div className={`pane-workspace ${dragging ? 'dragging' : ''}`}>
      {emptyGroup ? (
        <div className="empty-pane-workspace">
          <div>
            <strong>No tabs open</strong>
          </div>
          <button onClick={() => props.onLayout(addTab(props.layout, props.layout.root.id, makeLauncherTab()))}><Plus size={15} /> New tab</button>
          <button disabled={!props.canReopen} onClick={() => props.onReopen(props.layout.root.id)}><Undo2 size={14} /> Reopen</button>
        </div>
      ) : (
        <SplitView node={maximized ?? props.layout.root} workspace={props} dragActions={dragActions} snapArrival={snapArrival} dockHover={dockPreview ? { groupId: dockPreview.groupId, edge: dockPreview.edge } : null} dragSourceGroupId={dragging?.sourceGroupId ?? null} dragSourceTabId={dragging?.tab.id ?? null} />
      )}
      {maximized && <div className="maximized-badge">MAXIMIZED</div>}
      {dockPreview && (
        <div
          className={`dock-snap-preview ${dockPreview.edge}`}
          style={{ left: dockPreview.left, top: dockPreview.top, width: dockPreview.width, height: dockPreview.height }}
        >
          <span>{dockPreview.edge === 'center' ? 'Join tab group' : `Snap ${dockPreview.edge}`}</span>
        </div>
      )}
      {dragging && createPortal(
        <div
          ref={dragGhostRef}
          className="pane-drag-ghost"
          style={{ transform: `translate3d(${dragging.x + 16}px, ${dragging.y + 16}px, 0)` }}
        >
          <header><DragIcon size={14} /><strong>{dragging.tab.title}</strong></header>
          <div><i /><i /><i /></div>
          <small>Move tab</small>
        </div>,
        document.body
      )}
    </div>
  )
}
