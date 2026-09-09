import type { AgentActivityPhase, SessionRecord } from '../../shared/models'
import type { ActivityStatus } from '../../shared/structured-agent'
import type { ProjectActivitySnapshot, ProjectActivityStatus } from '../../shared/project-activity'
import { listGroups } from './layout/layout-operations'

export type { ProjectActivityStatus }

export const getAttentionSessionIds = (
  sessions: SessionRecord[],
  attentionResourceIds: ReadonlySet<string>
): Set<string> => {
  const ids = new Set<string>()
  for (const session of sessions) {
    const hasVisibleAttention = listGroups(session.layout.root).some((group) =>
      group.tabs.some((tab) => tab.resourceId && attentionResourceIds.has(tab.resourceId))
    )
    if (hasVisibleAttention) ids.add(session.id)
  }
  return ids
}

export type SessionActivityStatus = 'working' | 'waiting' | 'done'

const statusForPhase = (phase: AgentActivityPhase): SessionActivityStatus | null => {
  // A stopped agent is quiet on purpose, so only the two involuntary states ask for a look.
  if (phase === 'waiting_input' || phase === 'failed' || phase === 'disconnected') return 'waiting'
  if (phase === 'working' || phase === 'limited') return 'working'
  if (phase === 'complete') return 'done'
  return null
}

const STATUS_PRIORITY: SessionActivityStatus[] = ['waiting', 'working', 'done']

export const getSessionActivityStatuses = (
  sessions: SessionRecord[],
  activityPhases: ReadonlyMap<string, AgentActivityPhase>
): Map<string, SessionActivityStatus> => {
  const result = new Map<string, SessionActivityStatus>()
  for (const session of sessions) {
    const statuses = new Set(listGroups(session.layout.root).flatMap((group) =>
      group.tabs.flatMap((tab) => {
        const phase = tab.resourceId ? activityPhases.get(tab.resourceId) : undefined
        const status = phase ? statusForPhase(phase) : null
        return status ? [status] : []
      })
    ))
    const winner = STATUS_PRIORITY.find((status) => statuses.has(status))
    if (winner) result.set(session.id, winner)
  }
  return result
}

export const retainVisibleAttentionResources = (
  sessions: SessionRecord[],
  attentionResourceIds: ReadonlySet<string>
): Set<string> => {
  const visibleResources = new Set(sessions.flatMap((session) =>
    listGroups(session.layout.root).flatMap((group) =>
      group.tabs.flatMap((tab) => tab.resourceId ? [tab.resourceId] : [])
    )
  ))
  return new Set([...attentionResourceIds].filter((id) => visibleResources.has(id)))
}

/** A conversation's own turn can report 'completed' while a subagent it launched (a Task-tool
 *  child, surfaced by summarizeSubagents in usage-summary.ts) is still running, awaiting
 *  approval, or only just preparing. */
export const hasActiveSubagent = (subagentStatuses: ReadonlyArray<ActivityStatus | 'unknown'>): boolean =>
  subagentStatuses.some((status) => status === 'running' || status === 'preparing' || status === 'awaiting_approval')

/** The tab checkmark must never claim 'complete' while it still owns active subagent work;
 *  every other phase (including its own 'working') passes through unchanged. */
export const resolveActivityPhase = (phase: AgentActivityPhase, hasActiveSubagentWork: boolean): AgentActivityPhase =>
  phase === 'complete' && hasActiveSubagentWork ? 'working' : phase

export const resolveActivityPhases = (
  phases: ReadonlyMap<string, AgentActivityPhase>,
  activeSubagentIds: ReadonlySet<string>
): Map<string, AgentActivityPhase> => {
  const result = new Map<string, AgentActivityPhase>()
  for (const [id, phase] of phases) result.set(id, resolveActivityPhase(phase, activeSubagentIds.has(id)))
  return result
}

const PROJECT_STATUS_PRIORITY: SessionActivityStatus[] = ['waiting', 'working', 'done']

/** One level above getSessionActivityStatuses: rolls each project's sessions up into a single
 *  status so the Workspaces project row can show working/needs-attention/done/idle, reusing the
 *  same vocabulary, with needs-attention winning over working, which wins over done. */
export const getProjectActivityStatuses = (
  sessions: SessionRecord[],
  attentionSessionIds: ReadonlySet<string>,
  sessionActivity: ReadonlyMap<string, SessionActivityStatus>
): Map<string, ProjectActivityStatus> => {
  const sessionsByProject = new Map<string, SessionRecord[]>()
  for (const session of sessions) sessionsByProject.set(session.projectId, [...(sessionsByProject.get(session.projectId) ?? []), session])
  const result = new Map<string, ProjectActivityStatus>()
  for (const [projectId, projectSessions] of sessionsByProject) {
    if (projectSessions.some((session) => attentionSessionIds.has(session.id))) { result.set(projectId, 'attention'); continue }
    const statuses = new Set(projectSessions.flatMap((session) => { const status = sessionActivity.get(session.id); return status ? [status] : [] }))
    result.set(projectId, PROJECT_STATUS_PRIORITY.find((status) => statuses.has(status)) ?? 'idle')
  }
  return result
}

/** The main process reports every project, including ones whose panes were never mounted; the
 *  mounted project's own roll-up knows things the database cannot (a completed turn still owning
 *  subagent work, attention only for tabs the workspace still shows), so it wins wherever it saw
 *  activity. Where it saw none - a fresh launch, or a project whose panes are closed - the
 *  backend answer stands. */
export const mergeProjectActivity = (
  backend: ProjectActivitySnapshot,
  local: ReadonlyMap<string, ProjectActivityStatus>
): Map<string, ProjectActivityStatus> => {
  const merged = new Map<string, ProjectActivityStatus>(Object.entries(backend))
  for (const [projectId, status] of local) if (status !== 'idle' || !merged.has(projectId)) merged.set(projectId, status)
  return merged
}
