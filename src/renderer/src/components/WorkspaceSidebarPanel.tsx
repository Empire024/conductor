import type { ReactNode } from 'react'
import type { ProjectRecord } from '../../../shared/models'
import { BrowserSidebar } from './BrowserSidebar'
import { ExplorerSidebar } from './ExplorerSidebar'
import type { ExplorerOpenMode, WorkspaceSidebarMode } from './workspace-sidebar-types'

interface WorkspaceSidebarPanelProps {
  mode: WorkspaceSidebarMode
  project: ProjectRecord | null
  workspace: ReactNode
  onOpenFile?(relativePath: string, mode: ExplorerOpenMode): void
  onProjectRenamed?(project: ProjectRecord): void
}

/**
 * Switches the contents beside the activity rail. The workspace content is passed
 * through so the existing project/session navigation remains owned by Sidebar.
 */
export function WorkspaceSidebarPanel({
  mode,
  project,
  workspace,
  onOpenFile,
  onProjectRenamed
}: WorkspaceSidebarPanelProps): React.JSX.Element {
  if (mode === 'workspace') return <>{workspace}</>
  if (mode === 'browser') return <BrowserSidebar projectId={project?.id} />
  if (project) {
    return (
      <ExplorerSidebar
        project={project}
        onOpenFile={onOpenFile}
        onProjectRenamed={onProjectRenamed}
      />
    )
  }
  return (
    <section className="workspace-sidebar-pane" aria-label="Explorer">
      <header className="workspace-sidebar-title">Explorer</header>
      <div className="explorer-empty">Open a project to browse its files.</div>
    </section>
  )
}
