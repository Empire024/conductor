import type { AgentActivityPhase, DetachedWindowRecord, LayoutNode, SessionRecord } from '../shared/models'
import type { ProjectActivitySnapshot, ProjectActivityStatus } from '../shared/project-activity'

/** One persisted agent row: the phase the main process last recorded for it, independent of
 *  whether any renderer pane for it was ever mounted. */
export interface AgentActivityRow {
  id: string
  projectId: string
  sessionId: string
  activityPhase: AgentActivityPhase
}

/** A session only reports 'disconnected' when the connection was lost while it was still in
 *  flight (see structured-sessions), so it does mean interrupted work; one that had already
 *  settled keeps the state it settled in and never forces this warning onto its project. */
const STATUS_FOR_PHASE: Partial<Record<AgentActivityPhase, ProjectActivityStatus>> = {
  waiting_input: 'attention',
  failed: 'waiting',
  disconnected: 'waiting',
  working: 'working',
  limited: 'working',
  complete: 'done'
}

/** Needs-attention beats still-working, which beats finished; 'idle' is the absence of all three. */
const PRIORITY: ProjectActivityStatus[] = ['attention', 'waiting', 'working', 'done']

const tabResourceIds = (node: LayoutNode): string[] =>
  node.type === 'group'
    ? node.tabs.flatMap((tab) => tab.resourceId ? [tab.resourceId] : [])
    : node.children.flatMap(tabResourceIds)

/** Agents whose tab was closed keep their row (their conversation is still resumable), so only
 *  resources a workspace layout still shows may speak for a project. Detaching a tab moves it out
 *  of that layout into its own window's, so those count too: a detached agent is on screen and
 *  working, and leaving it out let its project roll up green underneath it. */
export const visibleResourceIds = (
  workspaces: readonly SessionRecord[],
  detached: readonly DetachedWindowRecord[] = []
): Set<string> => {
  const openWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id))
  return new Set([
    ...workspaces.flatMap((workspace) => tabResourceIds(workspace.layout.root)),
    ...detached.flatMap((window) => openWorkspaceIds.has(window.sessionId) ? tabResourceIds(window.layout.root) : [])
  ])
}

/** Rolls persisted agent phases up into one status per project. Projects with no workspaces, no
 *  agents, or only closed agent tabs report 'idle' rather than being omitted. */
export const aggregateProjectActivity = (
  projectIds: readonly string[],
  workspaces: readonly SessionRecord[],
  agents: readonly AgentActivityRow[],
  detached: readonly DetachedWindowRecord[] = []
): ProjectActivitySnapshot => {
  const workspacesByProject = new Map<string, SessionRecord[]>()
  for (const workspace of workspaces) workspacesByProject.set(workspace.projectId, [...(workspacesByProject.get(workspace.projectId) ?? []), workspace])
  const snapshot: ProjectActivitySnapshot = {}
  for (const projectId of projectIds) {
    const projectWorkspaces = workspacesByProject.get(projectId) ?? []
    const openWorkspaceIds = new Set(projectWorkspaces.map((workspace) => workspace.id))
    const visible = visibleResourceIds(projectWorkspaces, detached.filter((window) => window.projectId === projectId))
    const statuses = new Set(agents.flatMap((agent) => {
      if (agent.projectId !== projectId || !openWorkspaceIds.has(agent.sessionId) || !visible.has(agent.id)) return []
      const status = STATUS_FOR_PHASE[agent.activityPhase]
      return status ? [status] : []
    }))
    snapshot[projectId] = PRIORITY.find((status) => statuses.has(status)) ?? 'idle'
  }
  return snapshot
}
