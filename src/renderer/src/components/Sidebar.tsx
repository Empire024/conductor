import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  X,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock3,
  Folder,
  FolderInput,
  FolderOpen,
  FolderGit2,
  FolderTree,
  GitBranch,
  Gauge,
  LayoutGrid,
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
import type { FileEntry, PaneKind, ProjectRecord, SessionRecord } from '../../../shared/models'
import { WorkspaceSidebarPanel } from './WorkspaceSidebarPanel'
import { WorkspaceSessionMenu } from './WorkspaceSessionMenu'
import type { ExplorerOpenMode, WorkspaceSidebarMode } from './workspace-sidebar-types'

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
  onRemoveProject(id: string): void
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
}

export type WorkspacePanel = 'agents' | 'tasks' | 'routines' | 'memory' | 'processes'

const railItems: Array<{
  icon: typeof LayoutGrid
  label: string
  kind?: PaneKind
  sidebar?: WorkspaceSidebarMode
  utility?: WorkspacePanel
}> = [
  { icon: LayoutGrid, label: 'Workspace', sidebar: 'workspace' },
  { icon: FolderTree, label: 'Explorer', sidebar: 'explorer' },
  { icon: GitBranch, label: 'Source control' },
  { icon: Bot, label: 'Automation', utility: 'agents' },
  { icon: MemoryStick, label: 'Memory', utility: 'memory' },
  { icon: Gauge, label: 'Processes', utility: 'processes' },
  { icon: Clock3, label: 'Schedules' }
]

export function Sidebar(props: SidebarProps): React.JSX.Element {
  const [sidebarMode, setSidebarMode] = useState<WorkspaceSidebarMode>(() => {
    const saved = localStorage.getItem('conductor.sidebarMode')
    return saved === 'explorer' || saved === 'browser' ? saved : 'workspace'
  })
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
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null)
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
      props.onUtilityPanel(null)
      if (typeof detail !== 'string' && detail.toggle && sidebarMode === mode && !props.collapsed) { props.onToggleCollapsed(); return }
      setSidebarMode(mode)
      localStorage.setItem('conductor.sidebarMode', mode)
      if (props.collapsed) props.onToggleCollapsed()
    }
    window.addEventListener('conductor:sidebar-mode', requestMode)
    return () => window.removeEventListener('conductor:sidebar-mode', requestMode)
  }, [sidebarMode, props.collapsed, props.onToggleCollapsed, props.onUtilityPanel])

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

  return (
    <div className={`left-shell ${props.collapsed ? 'rail-only' : ''}`}>
      {workspaceMenu && <WorkspaceSessionMenu x={workspaceMenu.x} y={workspaceMenu.y} canRestore={props.canRestoreWorkspace} onRename={() => renameSession(workspaceMenu.session)} onNew={props.onNewSession} onRestore={props.onRestoreWorkspace} onCloseWorkspace={() => props.onCloseSession(workspaceMenu.session.id)} onDismiss={() => setWorkspaceMenu(null)} />}<nav className="activity-rail" aria-label="Activity">
        <div className="rail-primary">
          {railItems.map(({ icon: Icon, label, kind, sidebar, utility }) => {
            const active = sidebar
              ? sidebarMode === sidebar && props.utilityPanel === null && !props.collapsed
              : utility === props.utilityPanel
            return (
            <button key={label} className={active ? 'active' : ''} title={label} aria-label={label} onClick={() => {
              if (sidebar) {
                const wasActive = sidebarMode === sidebar && props.utilityPanel === null
                props.onUtilityPanel(null)
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
          })}
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

      {!props.collapsed && <aside className="sidebar">
        <WorkspaceSidebarPanel
          mode={sidebarMode}
          projects={props.projects}
          project={props.projects.find((project) => project.id === props.activeProjectId) ?? null}
          onOpenFile={props.onOpenFile}
          onPathChanged={props.onPathChanged}
          onPathRemoved={props.onPathRemoved}
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
                      </button>
                      </>
                    )}
                    <button className="project-more" title={`${project.name} actions`} onClick={(event) => showProjectMenu(event, project)}>
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                  {expanded && (
                    <div className="session-tree">
                      {props.sessions.map((session, index) => (
                        <div key={session.id} className="sidebar-session-row" draggable={editingSessionId !== session.id} onContextMenu={event => { if (editingSessionId === session.id) return; event.preventDefault(); event.stopPropagation(); setMenu(null); setWorkspaceMenu({ session, x: event.clientX, y: event.clientY }) }}
                          onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-conductor-session', session.id) }}
                          onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-conductor-session')) { event.preventDefault(); event.currentTarget.classList.add('reorder-target') } }}
                          onDragLeave={(event) => event.currentTarget.classList.remove('reorder-target')}
                          onDrop={(event) => { event.preventDefault(); event.currentTarget.classList.remove('reorder-target'); const dragged = event.dataTransfer.getData('application/x-conductor-session'); if (!dragged || dragged === session.id) return; const ids = props.sessions.map((item) => item.id).filter((id) => id !== dragged); ids.splice(ids.indexOf(session.id) + (event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.clientHeight / 2 ? 1 : 0), 0, dragged); props.onReorderSessions(ids) }}>
                        <button
                          className={session.id === props.activeSessionId ? 'active' : ''}
                          onClick={() => props.onSelectSession(session.id)}
                          onDoubleClick={event => { event.preventDefault(); renameSession(session) }}
                          onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); event.stopPropagation(); renameSession(session) } }}
                        >
                          <span className="session-number">{String(index + 1).padStart(2, '0')}</span>
                          <span className="ellipsis">{editingSessionId === session.id ? <input className="sidebar-session-rename" aria-label="Workspace name" autoFocus value={sessionName} onFocus={event => event.currentTarget.select()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onChange={event => setSessionName(event.target.value)} onBlur={() => finishSessionRename(true)} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); finishSessionRename(true) }; if (event.key === 'Escape') { event.preventDefault(); finishSessionRename(false) } }} /> : session.name}</span>
                          {session.id === props.activeSessionId && <i className="live-dot" />}
                        </button>
                        <button className="sidebar-session-close" aria-label={'Close ' + session.name} title={'Close ' + session.name} onClick={() => props.onCloseSession(session.id)}><X size={11} /></button>
                        </div>
                      ))}
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

        <section className="sidebar-section status-section">
          <div className="sidebar-heading"><span>Local status</span></div>
          <div className="status-card">
            <div><span className="status-light online" /> Runtime host</div>
            <span>ready</span>
          </div>
          <div className="status-card">
            <div><Folder size={13} /> State store</div>
            <span>SQLite</span>
          </div>
        </section>

        <footer className="sidebar-footer">
          <div className="avatar">LC</div>
          <div><strong>Local workspace</strong><span>Private · on this PC</span></div>
        </footer>
          </>}
        />
      </aside>}
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
              {confirmingRemoval === menu.project.id ? (
                <div className="project-remove-confirm">
                  <span>Remove from Conductor? Files stay on disk.</span>
                  <div>
                    <button onClick={() => setConfirmingRemoval(null)}>Cancel</button>
                    <button className="danger" onClick={() => { const id = menu.project.id; setMenu(null); setConfirmingRemoval(null); props.onRemoveProject(id) }}><Trash2 size={13} /> Remove</button>
                  </div>
                </div>
              ) : (
                <button className="danger" onClick={() => setConfirmingRemoval(menu.project.id)}><Trash2 size={14} /> Remove from Conductor</button>
              )}
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
