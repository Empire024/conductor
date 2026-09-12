import { Fragment, useEffect, useState } from 'react'
import { WorkspaceTabList, WorkspaceTabToggle } from './WorkspaceTabList'
import { RemoveProjectDialog } from './RemoveProjectDialog'
import { ProcessStatusSummary } from './ProcessStatusSummary'
import type { TabGroupAction } from '../layout/tab-groups'
import type { WorkspaceTabAction } from '../layout/workspace-tab-actions'
import type { ProjectActivityStatus, SessionActivityStatus } from '../attention'
import { displayActivityStatus } from '../attention'
import { createPortal } from 'react-dom'
import {
  X,
  Bell,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock3,
  FolderInput,
  FolderOpen,
  FolderGit2,
  FolderTree,
  GitBranch,
  Globe2,
  Gauge,
  LayoutGrid,
  ListTodo,
  MemoryStick,
  MoreHorizontal,
  MoveRight,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Search,
  Settings2,
  Trash2
} from 'lucide-react'
import type { AgentActivityPhase, FileEntry, PaneKind, ProjectRecord, SessionRecord } from '../../../shared/models'
import { WorkspaceSidebarPanel } from './WorkspaceSidebarPanel'
import { WorkspaceSessionMenu } from './WorkspaceSessionMenu'
import type { ExplorerOpenMode, WorkspaceSidebarMode } from './workspace-sidebar-types'
import type { RemoteFilesPaneProps } from '../panes/RemoteFilesPane'

interface SidebarProps {
  projects: ProjectRecord[]
  sessions: SessionRecord[]
  activeProjectId: string | null
  activeSessionId: string | null
  onSelectProject(id: string): void
  onSelectSession(id: string): void
  onCreateProject(): void
  renameProjectId?: string | null
  onRenameProject(id: string, name: string): Promise<void>
  onProjectRenameComplete(): void
  onOpenExistingProject(): void
  onMoveProject(id: string): void
  onRemoveProject(id: string): Promise<void>
  onTabAction(sessionId: string, groupId: string, tabId: string, action: WorkspaceTabAction): void
  onTabGroupAction(sessionId: string, groupId: string, tabId: string, action: TabGroupAction): void
  onRevealProject(path: string): void
  onCloseSession(id: string): void
  onRenameSession(id: string, name: string): void
  canRestoreWorkspace: boolean
  onRestoreWorkspace(): void
  onReorderProjects(ids: string[]): void
  onReorderSessions(ids: string[]): void
  onNewSession(): void
  onOpenPalette(): void
  onOpenSettings(): void
  collapsed: boolean
  onToggleCollapsed(): void
  onOpenTab(kind: PaneKind): void
  onOpenFile?(relativePath: string, mode: ExplorerOpenMode, projectId?: string): void
  onProjectRenamed?(project: ProjectRecord): void
  onPathChanged?(previousPath: string, nextPath: string, kind: FileEntry['kind'], projectId?: string): void
  onPathRemoved?(relativePath: string, kind: FileEntry['kind'], projectId?: string): void
  utilityPanel: WorkspacePanel | null
  onUtilityPanel(panel: WorkspacePanel | null): void
  attentionIds: ReadonlySet<string>
  sessionActivity: ReadonlyMap<string, SessionActivityStatus>
  activityPhases: ReadonlyMap<string, AgentActivityPhase>
  projectActivity: ReadonlyMap<string, ProjectActivityStatus>
  remoteFiles?: Omit<RemoteFilesPaneProps, 'files'>
}

export type WorkspacePanel = 'backlog' | 'agents' | 'tasks' | 'routines' | 'memory' | 'processes'

// "Workspace" and "Explorer" are the primary destinations. The rest are real, working
// panels too, except Source control and Schedules, which have no kind/sidebar/utility
// wired up yet - clicking them does nothing today, so they're pinned to the bottom and
// rendered disabled rather than opening a dead button.
const railItems: Array<{
  icon: typeof LayoutGrid
  label: string
  kind?: PaneKind
  sidebar?: WorkspaceSidebarMode
  utility?: WorkspacePanel
  group: 'primary' | 'secondary'
  unfinished?: boolean
}> = [
  { icon: LayoutGrid, label: 'Workspace', sidebar: 'workspace', group: 'primary' },
  { icon: FolderTree, label: 'Explorer', sidebar: 'explorer', group: 'primary' },
  { icon: Globe2, label: 'Browser', sidebar: 'browser', group: 'primary' },
  { icon: ListTodo, label: 'Project tasks', utility: 'backlog', group: 'secondary' },
  { icon: Bot, label: 'Automation', utility: 'agents', group: 'secondary' },
  { icon: MemoryStick, label: 'Memory', utility: 'memory', group: 'secondary' },
  { icon: Gauge, label: 'Processes', utility: 'processes', group: 'secondary' },
  { icon: GitBranch, label: 'Source control', group: 'secondary', unfinished: true },
  { icon: Clock3, label: 'Schedules', group: 'secondary', unfinished: true }
]

export function Sidebar(props: SidebarProps): React.JSX.Element {
  const [sidebarMode, setSidebarMode] = useState<WorkspaceSidebarMode>(() => {
    const saved = localStorage.getItem('conductor.sidebarMode')
    return saved === 'explorer' || saved === 'browser' ? saved : 'workspace'
  })
  const [tabListOverrides, setTabListOverrides] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<
    | { kind: 'project'; project: ProjectRecord; x: number; y: number }
    | { kind: 'projects'; x: number; y: number }
    | null
  >(null)
  const [workspaceMenu, setWorkspaceMenu] = useState<{ session: SessionRecord; x: number; y: number } | null>(null)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [sessionName, setSessionName] = useState('')
  const renameSession = (session: SessionRecord): void => { setEditingSessionId(session.id); setSessionName(session.name) }
  const finishSessionRename = (save: boolean): void => { const id = editingSessionId; setEditingSessionId(null); if (save && id && sessionName.trim()) props.onRenameSession(id, sessionName.trim()) }
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const [confirmingRemoval, setConfirmingRemoval] = useState<ProjectRecord | null>(null)
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('conductor.collapsedProjects') ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })

  const toggleProject = (project: ProjectRecord, active: boolean): void => {
    if (!active) {
      setCollapsedProjectIds((current) => {
        const next = new Set(current)
        next.delete(project.id)
        localStorage.setItem('conductor.collapsedProjects', JSON.stringify([...next]))
        return next
      })
      props.onSelectProject(project.id)
      return
    }
    setCollapsedProjectIds((current) => {
      const next = new Set(current)
      if (next.has(project.id)) next.delete(project.id)
      else next.add(project.id)
      localStorage.setItem('conductor.collapsedProjects', JSON.stringify([...next]))
      return next
    })
  }

  const beginProjectRename = (project: ProjectRecord): void => {
    setEditingProjectId(project.id)
    setProjectName(project.name)
    setMenu(null)
  }

  const finishProjectRename = (commit: boolean): void => {
    const id = editingProjectId
    const name = projectName.trim()
    setEditingProjectId(null)
    props.onProjectRenameComplete()
    if (commit && id && name) void props.onRenameProject(id, name)
  }

  useEffect(() => {
    if (!props.renameProjectId) return
    const project = props.projects.find((item) => item.id === props.renameProjectId)
    if (project) beginProjectRename(project)
  }, [props.projects, props.renameProjectId])

  useEffect(() => {
    const requestMode = (event: Event): void => {
      const detail = (event as CustomEvent<WorkspaceSidebarMode | { mode: WorkspaceSidebarMode; toggle?: boolean }>).detail
      const mode = typeof detail === 'string' ? detail : detail.mode
      if (!['workspace', 'explorer', 'browser'].includes(mode)) return
      if (typeof detail !== 'string' && detail.toggle && sidebarMode === mode && !props.collapsed) { props.onToggleCollapsed(); return }
      setSidebarMode(mode)
      localStorage.setItem('conductor.sidebarMode', mode)
      if (props.collapsed) props.onToggleCollapsed()
    }
    window.addEventListener('conductor:sidebar-mode', requestMode)
    return () => window.removeEventListener('conductor:sidebar-mode', requestMode)
  }, [sidebarMode, props.collapsed, props.onToggleCollapsed])

  useEffect(() => {
    if (!menu) return
    const close = (event?: Event): void => { if (event?.target instanceof Element && event.target.closest('.project-more, [data-project-menu-trigger]')) return; setMenu(null) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', escape)
    }
  }, [menu])

  const showProjectMenu = (event: React.MouseEvent, project: ProjectRecord): void => {
    event.preventDefault()
    event.stopPropagation()
    setConfirmingRemoval(null)
    if (menu?.kind === 'project' && menu.project.id === project.id && event.type === 'click') { setMenu(null); return }
    setMenu({
      kind: 'project',
      project,
      x: Math.min(event.clientX, window.innerWidth - 210),
      y: Math.min(event.clientY, window.innerHeight - 285)
    })
  }

  // The sidebar and the dockable utility drawer are independent surfaces:
  // picking Explorer must not close Project tasks, and neither one owns the other.
  const renderRailItem = ({ icon: Icon, label, kind, sidebar, utility, unfinished }: (typeof railItems)[number]): React.JSX.Element => {
    if (unfinished) {
      return (
        <button
          key={label}
          className="rail-unfinished"
          title={`${label} — not ready yet`}
          aria-label={`${label}, not ready yet`}
          aria-disabled="true"
          disabled
        >
          <Icon size={18} strokeWidth={1.75} />
        </button>
      )
    }
    const active = sidebar
      ? sidebarMode === sidebar && !props.collapsed
      : utility === props.utilityPanel
    return (
      <button key={label} className={active ? 'active' : ''} title={label} aria-label={label} onClick={() => {
        if (sidebar) {
          const wasActive = sidebarMode === sidebar && !props.collapsed
          setSidebarMode(sidebar)
          localStorage.setItem('conductor.sidebarMode', sidebar)
          if (props.collapsed || wasActive) props.onToggleCollapsed()
        } else if (kind) {
          props.onUtilityPanel(null)
          props.onOpenTab(kind)
        }
        else if (utility) props.onUtilityPanel(props.utilityPanel === utility ? null : utility)
      }}>
        <Icon size={18} strokeWidth={1.75} />
      </button>
    )
  }

  return (
    <div className={`left-shell${props.collapsed ? ' rail-only' : ''}${sidebarMode === 'browser' ? ' browser-active' : ''}`}>
      {workspaceMenu && <WorkspaceSessionMenu x={workspaceMenu.x} y={workspaceMenu.y} canRestore={props.canRestoreWorkspace} onRename={() => renameSession(workspaceMenu.session)} onNew={props.onNewSession} onRestore={props.onRestoreWorkspace} onCloseWorkspace={() => props.onCloseSession(workspaceMenu.session.id)} onDismiss={() => setWorkspaceMenu(null)} />}<nav className="activity-rail" aria-label="Activity">
        <div className="rail-primary">
          {railItems.filter((item) => item.group === 'primary').map(renderRailItem)}
          <div className="rail-divider" role="separator" aria-orientation="horizontal" />
          {railItems
            .filter((item) => item.group === 'secondary')
            .sort((a, b) => Number(Boolean(a.unfinished)) - Number(Boolean(b.unfinished)))
            .map(renderRailItem)}
        </div>
        <div className="rail-bottom">
          <button
            title={props.collapsed ? 'Open workspace sidebar' : 'Close workspace sidebar'}
            aria-label={props.collapsed ? 'Open workspace sidebar' : 'Close workspace sidebar'}
            onClick={props.onToggleCollapsed}
          >{props.collapsed ? <PanelLeftOpen size={18} strokeWidth={1.75} /> : <PanelLeftClose size={18} strokeWidth={1.75} />}</button>
          <button title="Settings" aria-label="Settings" onClick={props.onOpenSettings}><Settings2 size={18} strokeWidth={1.75} /></button>
        </div>
      </nav>

      <aside className="sidebar" aria-hidden={props.collapsed || undefined}>
        <WorkspaceSidebarPanel
          mode={sidebarMode}
          projects={props.projects}
          project={props.projects.find((project) => project.id === props.activeProjectId) ?? null}
          onOpenFile={props.onOpenFile}
          onPathChanged={props.onPathChanged}
          onPathRemoved={props.onPathRemoved}
          remoteFiles={props.remoteFiles}
          onProjectRenamed={(project) => {
            props.onProjectRenamed?.(project)
            window.dispatchEvent(new CustomEvent('conductor:project-renamed', { detail: project }))
          }}
          workspace={<>
        <button className="sidebar-search" onClick={props.onOpenPalette}>
          <Search size={14} />
          <span>Jump to...</span>
          <kbd>Ctrl K</kbd>
        </button>

        <section className="sidebar-section projects-section">
          <div className="sidebar-heading">
            <span>Projects</span>
            <div className="heading-actions">
              <button onClick={props.onCreateProject} title="Create new project"><Plus size={14} /></button>
              <button
                data-project-menu-trigger
                title="More project actions"
                onClick={(event) => {
                  event.stopPropagation()
                  const rect = event.currentTarget.getBoundingClientRect()
                  setMenu((current) => current?.kind === 'projects' ? null : { kind: 'projects', x: Math.min(rect.right - 8, window.innerWidth - 210), y: rect.bottom + 3 })
                }}
              ><MoreHorizontal size={14} /></button>
            </div>
          </div>
          <div className="project-list">
            {props.projects.map((project) => {
              const active = project.id === props.activeProjectId
              const expanded = active && !collapsedProjectIds.has(project.id)
              const projectStatus = props.projectActivity.get(project.id) ?? 'idle'
              return (
                <div key={project.id} onContextMenu={(event) => showProjectMenu(event, project)}>
                  <div className={`project-row-wrap ${active ? 'active' : ''}`} draggable={editingProjectId !== project.id}
                    onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-conductor-project', project.id) }}
                    onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-conductor-project')) { event.preventDefault(); event.currentTarget.classList.add('reorder-target') } }}
                    onDragLeave={(event) => event.currentTarget.classList.remove('reorder-target')}
                    onDrop={(event) => { event.preventDefault(); event.currentTarget.classList.remove('reorder-target'); const dragged = event.dataTransfer.getData('application/x-conductor-project'); if (!dragged || dragged === project.id) return; const ids = props.projects.map((item) => item.id).filter((id) => id !== dragged); ids.splice(ids.indexOf(project.id) + (event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.clientHeight / 2 ? 1 : 0), 0, dragged); props.onReorderProjects(ids) }}>
                    {editingProjectId === project.id ? (
                      <div className={`project-row project-row-editing ${active ? 'active' : ''}`}>
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        <span className="project-glyph"><FolderGit2 size={14} /></span>
                        <input
                          className="project-rename-input"
                          value={projectName}
                          autoFocus
                          aria-label="Rename project"
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => setProjectName(event.target.value)}
                          onBlur={() => finishProjectRename(true)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') { event.preventDefault(); finishProjectRename(true) }
                            if (event.key === 'Escape') { event.preventDefault(); finishProjectRename(false) }
                          }}
                        />
                      </div>
                    ) : (
                      <>
                      <button
                        className="project-toggle"
                        onClick={(event) => { event.stopPropagation(); toggleProject(project, active) }}
                        title={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
                        aria-label={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
                      >
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </button>
                      <button
                        className={`project-row ${active ? 'active' : ''}`}
                        onClick={() => { if (!active) props.onSelectProject(project.id) }}
                        onDoubleClick={(event) => { event.preventDefault(); beginProjectRename(project) }}
                        onKeyDown={(event) => { if (event.key === 'F2') { event.preventDefault(); beginProjectRename(project) } }}
                        title={project.path}
                      >
                        <span className="project-glyph"><FolderGit2 size={14} /></span>
                        <span className="ellipsis">{project.name}</span>
                        {projectStatus === 'attention' && <span className="session-attention-badge" title="An agent in this project needs your attention"><Bell size={11} strokeWidth={1.7} /></span>}
                        {projectStatus !== 'attention' && projectStatus !== 'idle' && <span className={`session-activity-dot ${projectStatus}`} title={projectStatus === 'working' ? 'Actively working' : projectStatus === 'waiting' ? 'Waiting on you' : 'Finished working'} />}
                      </button>
                      </>
                    )}
                    <button className="project-more" title={`${project.name} actions`} onClick={(event) => showProjectMenu(event, project)}>
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                  {expanded && (
                    <div className="session-tree">
                      {props.sessions.map((session, index) => {
                      const attention = props.attentionIds.has(session.id)
                      // A workspace whose only warning is a disconnected tab reports 'stalled';
                      // it paints the same amber dot, but it never outranked a sibling working.
                      const activity = props.sessionActivity.get(session.id)
                      const activityDot = activity ? displayActivityStatus(activity) : undefined
                      return (
                        <Fragment key={session.id}><div className="sidebar-session-row" draggable={editingSessionId !== session.id} onContextMenu={event => { if (editingSessionId === session.id) return; event.preventDefault(); event.stopPropagation(); setMenu(null); setWorkspaceMenu({ session, x: event.clientX, y: event.clientY }) }}
                          onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-conductor-session', session.id) }}
                          onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-conductor-session')) { event.preventDefault(); event.currentTarget.classList.add('reorder-target') } }}
                          onDragLeave={(event) => event.currentTarget.classList.remove('reorder-target')}
                          onDrop={(event) => { event.preventDefault(); event.currentTarget.classList.remove('reorder-target'); const dragged = event.dataTransfer.getData('application/x-conductor-session'); if (!dragged || dragged === session.id) return; const ids = props.sessions.map((item) => item.id).filter((id) => id !== dragged); ids.splice(ids.indexOf(session.id) + (event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.clientHeight / 2 ? 1 : 0), 0, dragged); props.onReorderSessions(ids) }}>
                        <WorkspaceTabToggle expanded={tabListOverrides[session.id] ?? session.id === props.activeSessionId} name={session.name} onToggle={() => setTabListOverrides(current => ({ ...current, [session.id]: !(current[session.id] ?? session.id === props.activeSessionId) }))} />
                        <button
                          className={`sidebar-session-open ${session.id === props.activeSessionId ? 'active' : ''} ${attention ? 'needs-attention' : ''}`}
                          onClick={() => props.onSelectSession(session.id)}
                          onDoubleClick={event => { event.preventDefault(); renameSession(session) }}
                          onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); event.stopPropagation(); renameSession(session) } }}
                        >
                          <span className="session-number">{String(index + 1).padStart(2, '0')}</span>
                          <span className="ellipsis">{editingSessionId === session.id ? <input className="sidebar-session-rename" aria-label="Workspace name" autoFocus value={sessionName} onFocus={event => event.currentTarget.select()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onChange={event => setSessionName(event.target.value)} onBlur={() => finishSessionRename(true)} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); finishSessionRename(true) }; if (event.key === 'Escape') { event.preventDefault(); finishSessionRename(false) } }} /> : session.name}</span>
                          {attention && <span className="session-attention-badge" title="An agent in this workspace needs your attention"><Bell size={11} strokeWidth={1.7} /></span>}
                          {!attention && activityDot && <span className={`session-activity-dot ${activityDot}`} title={activityDot === 'working' ? 'Actively working' : activityDot === 'waiting' ? 'Waiting on you' : 'Finished working'} />}
                        </button>
                        <button className="sidebar-session-close" aria-label={'Close ' + session.name} title={'Close ' + session.name} onClick={() => props.onCloseSession(session.id)}><X size={11} /></button>
                        </div>
                        <WorkspaceTabList session={session} active={session.id === props.activeSessionId} expanded={tabListOverrides[session.id] ?? session.id === props.activeSessionId} activityPhases={props.activityPhases} onAction={(groupId, tabId, action) => props.onTabAction(session.id, groupId, tabId, action)} onGroupAction={(groupId, tabId, action) => props.onTabGroupAction(session.id, groupId, tabId, action)} />
                        </Fragment>
                      )})}
                      <button className="new-session" onClick={props.onNewSession}>
                        <Plus size={12} /> New workspace
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>

        <ProcessStatusSummary projects={props.projects} onOpen={() => props.onUtilityPanel(props.utilityPanel === 'processes' ? null : 'processes')} />
          </>}
        />
      </aside>
      {confirmingRemoval && <RemoveProjectDialog project={confirmingRemoval} onRemove={() => props.onRemoveProject(confirmingRemoval.id)} onDismiss={() => setConfirmingRemoval(null)} />}
      {menu && createPortal(
        <div
          className="cursor-context-menu project-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {menu.kind === 'projects' ? (
            <>
              <button onClick={() => { setMenu(null); props.onCreateProject() }}><Plus size={14} /> Create new project</button>
              <button onClick={() => { setMenu(null); props.onOpenExistingProject() }}><FolderInput size={14} /> Open existing folder</button>
              <div />
              <button onClick={() => { setMenu(null); props.onOpenSettings() }}><Settings2 size={14} /> Project settings</button>
            </>
          ) : (
            <>
              <div className="context-menu-label">{menu.project.name}</div>
              <button onClick={() => beginProjectRename(menu.project)}><Pencil size={14} /> Rename project</button>
              <button onClick={() => { setMenu(null); props.onRevealProject(menu.project.path) }}><FolderOpen size={14} /> Show in File Explorer</button>
              <button onClick={() => { const id = menu.project.id; setMenu(null); props.onMoveProject(id) }}><MoveRight size={14} /> Move project…</button>
              <div />
              <button className="danger" onClick={() => { setConfirmingRemoval(menu.project); setMenu(null) }}><Trash2 size={14} /> Remove from Conductor</button>
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
