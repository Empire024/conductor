import type { AgentActivityPhase, SessionRecord } from '../../shared/models'
import type { ActivityStatus } from '../../shared/structured-agent'
import type { ActivityRollupStatus, ProjectActivitySnapshot, ProjectActivityStatus } from '../../shared/project-activity'
import { displayActivityStatus, foldActivityStatuses } from '../../shared/project-activity'
import { listGroups } from './layout/layout-operations'

export type { ProjectActivityStatus }
export { displayActivityStatus }

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

/** A workspace row speaks the roll-up vocabulary, not the painted one: it carries 'stalled'
 *  onwards so the project row above it can still tell a lost connection from a failure. Both
 *  rows paint it through displayActivityStatus. */
export type SessionActivityStatus = Exclude<ActivityRollupStatus, 'attention' | 'idle'>

const statusForPhase = (phase: AgentActivityPhase): SessionActivityStatus | null => {
  // A stopped agent is quiet on purpose, so only the involuntary states ask for a look; a
  // conversation that had already settled before losing its connection never reports as
  // disconnected in the first place. A tab that really was cut off warns for itself, but as
  // 'stalled' it never speaks for a workspace or project with work still running in it.
  if (phase === 'waiting_input' || phase === 'failed') return 'waiting'
  if (phase === 'disconnected') return 'stalled'
  if (phase === 'working' || phase === 'limited') return 'working'
  if (phase === 'complete') return 'done'
  return null
}

export const getSessionActivityStatuses = (
  sessions: SessionRecord[],
  activityPhases: ReadonlyMap<string, AgentActivityPhase>
): Map<string, SessionActivityStatus> => {
  const result = new Map<string, SessionActivityStatus>()
  for (const session of sessions) {
    const statuses = listGroups(session.layout.root).flatMap((group) =>
      group.tabs.flatMap((tab) => {
        const phase = tab.resourceId ? activityPhases.get(tab.resourceId) : undefined
        const status = phase ? statusForPhase(phase) : null
        return status ? [status] : []
      })
    )
    // Nothing at tab level reports 'attention' - the bell is driven by attentionResourceIds -
    // and an empty workspace folds to 'idle', which is the absence of a dot rather than a state.
    const winner = foldActivityStatuses(statuses)
    if (winner !== 'idle' && winner !== 'attention') result.set(session.id, winner)
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

/** One level above getSessionActivityStatuses: rolls each project's sessions up into a single
 *  status so the Workspaces project row can show working/needs-attention/done/idle, reusing the
 *  same vocabulary, with needs-attention winning over working, which wins over done. A workspace
 *  that only holds a disconnected tab is the one warning that does not win here: a project the
 *  owner can see working must not read as a warning because of it. */
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
    const statuses = projectSessions.flatMap((session) => { const status = sessionActivity.get(session.id); return status ? [status] : [] })
    result.set(projectId, displayActivityStatus(foldActivityStatuses(statuses)))
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
