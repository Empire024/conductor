import type { ReactNode } from 'react'
import type { FileEntry, ProjectRecord } from '../../../shared/models'
import { BrowserSidebar } from './BrowserSidebar'
import { ExplorerSidebar } from './ExplorerSidebar'
import type { ExplorerOpenMode, WorkspaceSidebarMode } from './workspace-sidebar-types'

interface WorkspaceSidebarPanelProps {
  mode: WorkspaceSidebarMode
  project: ProjectRecord | null
  projects?: ProjectRecord[]
  workspace: ReactNode
  onOpenFile?(relativePath: string, mode: ExplorerOpenMode, projectId?: string): void
  onProjectRenamed?(project: ProjectRecord): void
  onPathChanged?(previousPath: string, nextPath: string, kind: FileEntry['kind'], projectId?: string): void
  onPathRemoved?(relativePath: string, kind: FileEntry['kind'], projectId?: string): void
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
  onPathRemoved
}: WorkspaceSidebarPanelProps): React.JSX.Element {
  if (mode === 'workspace') return <>{workspace}</>
  if (mode === 'browser') return <BrowserSidebar projectId={project?.id} />
  if (projects?.length || project) {
    return <section className="workspace-sidebar-pane" aria-label="Explorer">
      <header className="workspace-sidebar-title"><span>Explorer</span></header>
      <div className="all-project-explorer">
        {(projects ?? (project ? [project] : [])).map((item) => <ExplorerSidebar key={item.id} project={item} defaultCollapsed={item.id !== project?.id}
          onOpenFile={(path, mode) => onOpenFile?.(path, mode, item.id)}
          onProjectRenamed={onProjectRenamed}
          onPathChanged={(previous, next, kind) => onPathChanged?.(previous, next, kind, item.id)}
          onPathRemoved={(path, kind) => onPathRemoved?.(path, kind, item.id)} />)}
      </div>
    </section>
  }
  return (
    <section className="workspace-sidebar-pane" aria-label="Explorer">
      <header className="workspace-sidebar-title">Explorer</header>
      <div className="explorer-empty">Open a project to browse its files.</div>
    </section>
  )
}
