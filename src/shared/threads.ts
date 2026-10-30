/**
 * Threads without a project (t3code adoption, first slice; docs/perf-evidence/t3code-cloud-threads.md).
 *
 * The owner can start a conversation without choosing or creating a project. Such a thread lives in
 * the "General" project: an ordinary local project row whose folder Conductor made under the projects
 * root (src/main/general-threads.ts), so every guard that keys on a project - the working directory,
 * file scope, permissions, restart and resume - applies unchanged. Only the UI treats it as "no
 * project": the empty state offers "New thread" first, and the Threads view lists every open
 * conversation across projects by what needs the owner and by recency, the way t3code's sidebar and
 * Conductor's phone list do.
 *
 * Everything here is pure, so the grouping, the age labels and the handoff text are unit-tested.
 */
import type { AgentProviderId, ProjectRecord, SessionRecord } from './models'
import type { PhoneSessionState, PhoneSessionSummary } from './phone-access'

export const GENERAL_PROJECT_NAME = 'General'
/** Main tells every window that the thread list may have changed (src/main/thread-invalidations.ts); no payload. */
export const THREADS_CHANGED_CHANNEL = 'threads:changed'
export const GENERAL_WORKSPACE_NAME = 'Threads'
/** Where the anchor ({projectId, path}) is kept in the settings table. */
export const GENERAL_ANCHOR_SETTING = 'generalThreadsAnchor'

export interface GeneralAnchor { projectId: string; path: string }

export function readGeneralAnchor(raw: string | null | undefined): GeneralAnchor | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<GeneralAnchor> | null
    return value && typeof value.projectId === 'string' && value.projectId && typeof value.path === 'string' && value.path
      ? { projectId: value.projectId, path: value.path } : null
  } catch { return null }
}

/** One conversation as the Threads view shows it. */
export interface ThreadSummary {
  id: string
  title: string
  projectId: string
  projectName: string
  /** The thread lives in the General project: shown as "General", never as a project the owner chose. */
  general: boolean
  workspaceId: string
  workspaceName: string
  tabId: string | null
  provider: AgentProviderId
  model?: string
  machineName: string
  state: PhoneSessionState
  needs: 'approval' | 'question' | null
  updatedAt: string
  lastText?: string
  lastRole?: 'user' | 'assistant'
  wizard?: true
  /** Set on a coworker another tab opened; the view folds coworkers under their controller. */
  controllerId?: string
  /** Coworkers folded under this row (open, not needing the owner). */
  coworkers?: number
}

export type ThreadBucket = 'needs-you' | 'working' | 'recent' | 'earlier'

export const THREAD_BUCKET_LABEL: Record<ThreadBucket, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  recent: 'Today',
  earlier: 'Earlier'
}

export interface ThreadGroup { bucket: ThreadBucket; label: string; threads: ThreadSummary[] }

export interface ThreadView {
  generalProjectId: string | null
  groups: ThreadGroup[]
  /** Threads listed (coworkers folded into their controller are not counted). */
  total: number
  /** Rows left out by the limit. */
  hidden: number
  observedAt: string
}

export const THREAD_VIEW_LIMIT = 60
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000

const NEEDS_YOU = new Set<PhoneSessionState>(['attention', 'failed', 'disconnected'])
const WORKING = new Set<PhoneSessionState>(['working', 'limited'])

export function threadBucket(thread: Pick<ThreadSummary, 'state' | 'updatedAt'>, now: number, recentMs = RECENT_WINDOW_MS): ThreadBucket {
  if (NEEDS_YOU.has(thread.state)) return 'needs-you'
  if (WORKING.has(thread.state)) return 'working'
  const at = Date.parse(thread.updatedAt)
  return Number.isFinite(at) && now - at <= recentMs ? 'recent' : 'earlier'
}

export function toThreadSummary(session: PhoneSessionSummary, generalProjectId: string | null): ThreadSummary {
  return {
    id: session.id, title: session.title, projectId: session.projectId, projectName: session.projectName,
    general: Boolean(generalProjectId) && session.projectId === generalProjectId,
    workspaceId: session.workspaceId, workspaceName: session.workspaceName, tabId: session.tabId,
    provider: session.provider, ...(session.model ? { model: session.model } : {}), machineName: session.machineName,
    state: session.state, needs: session.needs, updatedAt: session.updatedAt,
    ...(session.lastText ? { lastText: session.lastText } : {}), ...(session.lastRole ? { lastRole: session.lastRole } : {}),
    ...(session.wizard ? { wizard: true as const } : {}), ...(session.controllerId ? { controllerId: session.controllerId } : {})
  }
}

const matches = (thread: ThreadSummary, query: string): boolean => {
  if (!query) return true
  const haystack = `${thread.title}\n${thread.general ? GENERAL_PROJECT_NAME : thread.projectName}\n${thread.workspaceName}\n${thread.lastText ?? ''}`.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word))
}

/**
 * The smart thread list: open conversations only (a closed one is in history, not here), every
 * project together. A coworker that does not need the owner is folded into its controller's row
 * (a swarm of twenty must not bury the conversation the owner is having); one that needs the owner
 * is always listed. Within a bucket a wizard comes first, then the newest.
 */
export function buildThreadView(sessions: readonly PhoneSessionSummary[], options: { generalProjectId: string | null; now: number; query?: string; limit?: number; recentMs?: number }): ThreadView {
  const { generalProjectId, now } = options
  const query = (options.query ?? '').trim()
  const limit = Math.max(1, Math.min(options.limit ?? THREAD_VIEW_LIMIT, 500))
  const open = sessions.filter(session => session.tabId && !session.archived).map(session => toThreadSummary(session, generalProjectId))
  const ids = new Set(open.map(thread => thread.id))
  const folded = new Map<string, number>()
  const listed: ThreadSummary[] = []
  for (const thread of open) {
    const controlled = thread.controllerId && ids.has(thread.controllerId) && thread.controllerId !== thread.id
    if (controlled && !NEEDS_YOU.has(thread.state)) { folded.set(thread.controllerId!, (folded.get(thread.controllerId!) ?? 0) + 1); continue }
    listed.push(thread)
  }
  const shown = listed.map(thread => folded.get(thread.id) ? { ...thread, coworkers: folded.get(thread.id) } : thread).filter(thread => matches(thread, query))
  const order: ThreadBucket[] = ['needs-you', 'working', 'recent', 'earlier']
  const byBucket = new Map<ThreadBucket, ThreadSummary[]>(order.map(bucket => [bucket, []]))
  for (const thread of shown) byBucket.get(threadBucket(thread, now, options.recentMs))!.push(thread)
  let budget = limit
  const groups: ThreadGroup[] = []
  for (const bucket of order) {
    const threads = byBucket.get(bucket)!.sort((a, b) => Number(Boolean(b.wizard)) - Number(Boolean(a.wizard)) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.title.localeCompare(b.title))
    if (!threads.length || budget <= 0) continue
    const kept = threads.slice(0, budget)
    budget -= kept.length
    groups.push({ bucket, label: THREAD_BUCKET_LABEL[bucket], threads: kept })
  }
  const total = shown.length
  return { generalProjectId, groups, total, hidden: total - groups.reduce((sum, group) => sum + group.threads.length, 0), observedAt: new Date(now).toISOString() }
}

/** A compact age, as t3code's sidebar shows it: "now", "5m", "3h", "2d", "4w", then a date. */
export function threadAge(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  if (days < 35) return `${Math.floor(days / 7)}w`
  return new Date(at).toISOString().slice(0, 10)
}

/** The row's one-word state, or null for a thread that is simply idle or done. */
export function threadStateLabel(thread: Pick<ThreadSummary, 'state' | 'needs'>): string | null {
  if (thread.state === 'attention') return thread.needs === 'approval' ? 'Approval' : thread.needs === 'question' ? 'Question' : 'Needs you'
  return ({ working: 'Working', limited: 'Limit', failed: 'Failed', disconnected: 'Disconnected' } as Partial<Record<PhoneSessionState, string>>)[thread.state] ?? null
}

/**
 * Moving a running conversation into a project is not offered: a native CLI conversation resumes
 * from its working directory (claude --resume finds the transcript under the folder it was started
 * in), so changing the folder of a started thread would lose the conversation on the next restart.
 * "Continue in project" instead opens a new thread in the chosen project with this text as its
 * unsent first message; the General thread stays where it is, intact.
 */
export const HANDOFF_MESSAGE_LIMIT = 6
export const HANDOFF_CHARS_PER_MESSAGE = 600
export const HANDOFF_MAX_CHARS = 6000

export function draftThreadHandoff(input: { title: string; folder: string; projectName: string; messages: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }> }): string {
  const recent = input.messages.filter(message => message.text.trim()).slice(-HANDOFF_MESSAGE_LIMIT)
  const clip = (text: string): string => {
    const flat = text.trim().replace(/\n{3,}/g, '\n\n')
    return flat.length > HANDOFF_CHARS_PER_MESSAGE ? flat.slice(0, HANDOFF_CHARS_PER_MESSAGE - 1).trimEnd() + '…' : flat
  }
  const lines = [
    `Continuing the thread "${input.title}" that I started without a project (its files, if any, are in ${input.folder}).`,
    `This conversation now belongs to the project ${input.projectName}; work in this project's folder.`
  ]
  if (recent.length) {
    lines.push('', 'Where it left off:')
    for (const message of recent) lines.push(`${message.role === 'user' ? 'Me' : 'Agent'}: ${clip(message.text)}`)
  }
  lines.push('', 'Next: ')
  const text = lines.join('\n')
  return text.length > HANDOFF_MAX_CHARS ? text.slice(text.length - HANDOFF_MAX_CHARS) : text
}

export interface GeneralThreadTarget { project: ProjectRecord; workspace: SessionRecord }

export interface ThreadsBridge {
  /** The General project and the workspace a new thread opens in, created on first use. */
  newGeneral(): Promise<GeneralThreadTarget>
  generalProjectId(): Promise<string | null>
  list(query?: string): Promise<ThreadView>
  /** The unsent first message for "Continue in project"; null when the conversation is unknown. */
  handoff(agentSessionId: string, targetProjectId: string): Promise<{ text: string; provider: AgentProviderId; model?: string } | null>
  /** "Turn into a project": the General project keeps its folder and threads under the owner's name for it. */
  promote(name: string): Promise<ProjectRecord>
  /** The thread list may have changed (carries no payload); the listener re-reads `list`. Returns the unsubscribe. */
  onChanged(listener: () => void): () => void
}
