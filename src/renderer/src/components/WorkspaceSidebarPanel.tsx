import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { FileEntry, ProjectRecord } from '../../../shared/models'
import { BrowserSidebar } from './BrowserSidebar'
import { ExplorerSidebar } from './ExplorerSidebar'
import type { ExplorerOpenMode, WorkspaceSidebarMode } from './workspace-sidebar-types'
import { persistMountedBrowserProjects, savedMountedBrowserProjects } from './browser-presentation'
import { RemoteFilesPane, type RemoteFilesPaneProps } from '../panes/RemoteFilesPane'

interface WorkspaceSidebarPanelProps {
  mode: WorkspaceSidebarMode
  project: ProjectRecord | null
  projects?: ProjectRecord[]
  workspace: ReactNode
  onOpenFile?(relativePath: string, mode: ExplorerOpenMode, projectId?: string): void
  onProjectRenamed?(project: ProjectRecord): void
  onPathChanged?(previousPath: string, nextPath: string, kind: FileEntry['kind'], projectId?: string): void
  onPathRemoved?(relativePath: string, kind: FileEntry['kind'], projectId?: string): void
  remoteFiles?: Omit<RemoteFilesPaneProps, 'files'>
}

/**
 * Switches the contents beside the activity rail. The workspace content is passed
 * through so the existing project/session navigation remains owned by Sidebar.
 */
export function WorkspaceSidebarPanel({
  mode,
  project,
  projects,
  workspace,
  onOpenFile,
  onProjectRenamed,
  onPathChanged,
  onPathRemoved,
  remoteFiles
}: WorkspaceSidebarPanelProps): React.JSX.Element {
  const [mountedBrowserProjects, setMountedBrowserProjects] = useState<Set<string>>(() => {
    const mounted = savedMountedBrowserProjects()
    if (mode === 'browser' && project) mounted.add(project.id)
    return mounted
  })
  useEffect(() => {
    if (mode !== 'browser' || !project || mountedBrowserProjects.has(project.id)) return
    setMountedBrowserProjects(current => {
      const next = new Set(current).add(project.id)
      persistMountedBrowserProjects(next)
      return next
    })
  }, [mode, mountedBrowserProjects, project])
  const availableProjects = useMemo(() => {
    const byId = new Map((projects ?? []).map(item => [item.id, item]))
    if (project) byId.set(project.id, project)
    return [...byId.values()]
  }, [project, projects])
  const browsers = availableProjects
    .filter(item => mountedBrowserProjects.has(item.id) || (mode === 'browser' && item.id === project?.id))
    .map(item => <BrowserSidebar key={`browser:${item.id}`} projectId={item.id} active={mode === 'browser' && item.id === project?.id} />)
  // Every explicitly opened project browser remains one mounted guest. Hiding the sidebar or
  // selecting another project changes only presentation, so background agent work retains its
  // page, cookies, console buffer and project partition without opening a workspace tab.
  if (mode === 'workspace') return <>{workspace}{browsers}</>
  if (mode === 'browser') return <>{browsers}</>
  if (remoteFiles) return <><RemoteFilesPane {...remoteFiles} files={window.conductor.remote.files} />{browsers}</>
  if (projects?.length || project) {
    return <><section className="workspace-sidebar-pane" aria-label="Explorer">
      <header className="workspace-sidebar-title"><span>Explorer</span></header>
      <div className="all-project-explorer">
        {(projects ?? (project ? [project] : [])).map((item) => <ExplorerSidebar key={item.id} project={item} defaultCollapsed={item.id !== project?.id}
          onOpenFile={(path, mode) => onOpenFile?.(path, mode, item.id)}
          onProjectRenamed={onProjectRenamed}
          onPathChanged={(previous, next, kind) => onPathChanged?.(previous, next, kind, item.id)}
          onPathRemoved={(path, kind) => onPathRemoved?.(path, kind, item.id)} />)}
      </div>
    </section>{browsers}</>
  }
  return (
    <><section className="workspace-sidebar-pane" aria-label="Explorer">
      <header className="workspace-sidebar-title">Explorer</header>
      <div className="explorer-empty">Open a project to browse its files.</div>
    </section>{browsers}</>
  )
}
