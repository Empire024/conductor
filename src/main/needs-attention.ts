import type { AgentActivityPhase, DetachedWindowRecord, LayoutNode, PaneTab, SessionRecord } from '../shared/models'
import { ATTENTION_LIMIT, sortAttention, type AttentionEntry, type AttentionReason, type AttentionSnapshot } from '../shared/needs-attention'
import type { SessionProjection } from '../shared/structured-agent'
import { PROVIDER_USAGE_LIMIT } from '../shared/structured-agent'
import { handedOffIn, tabSeenAt } from '../shared/workspace-clarity'
import { CoworkerRecovery } from './coworker-recovery'
import { settledAt } from './workspace-clarity'

/**
 * The main-process half of "Needs attention" (src/shared/needs-attention.ts). It reads what the
 * project roll-up already reads on every status change - the agent_sessions phases and the open
 * layouts - and loads a conversation's state only for the few tabs whose phase flags them, so the
 * multi-gigabyte journal is never scanned. The list is recomputed on a short debounce after a
 * status or permission change and published only when it changed, so the renderer re-renders only
 * then and typing never waits on it.
 */

export interface AttentionAgentRow { id: string; projectId: string; sessionId: string; activityPhase: AgentActivityPhase }

export interface NeedsAttentionSources {
  projects(): Array<{ id: string; name: string }>
  workspaces(projectId: string): SessionRecord[]
  detached(): DetachedWindowRecord[]
  agents(): AttentionAgentRow[]
  snapshot(id: string): SessionProjection | null
  /** Pending request_permission cards (PermissionGrants.state().requests). */
  permissionRequests?(): Array<{ agentSessionId: string; status: string; reason?: string; command?: string; path?: string; url?: string; createdAt?: string }>
  /** Taken over by another conversation (agents.supersede): its failure is not the owner's to chase. */
  superseded?(projectId: string, id: string): boolean
}

const FLAGGED: ReadonlySet<AgentActivityPhase> = new Set(['waiting_input', 'failed', 'disconnected', 'limited'])

const groupsOf = (node: LayoutNode): Array<{ tabs: PaneTab[] }> => node.type === 'split' ? [...groupsOf(node.children[0]), ...groupsOf(node.children[1])] : [node]

function lastError(state: SessionProjection): { message: string; code?: string } | undefined {
  for (let index = state.items.length - 1; index >= 0; index--) {
    const data = state.items[index]!.data
    if (data.type === 'error') return { message: data.message, ...('code' in data && typeof data.code === 'string' ? { code: data.code } : {}) }
  }
  return undefined
}

export function computeNeedsAttention(sources: NeedsAttentionSources, now = new Date()): AttentionSnapshot {
  // Every agent tab a workspace (or its detached window) still shows, with where it is.
  const shown = new Map<string, { projectId: string; projectName: string; workspace: SessionRecord; tab: PaneTab }>()
  const detached = sources.detached()
  for (const project of sources.projects()) for (const workspace of sources.workspaces(project.id)) {
    const roots = [workspace.layout.root, ...detached.filter(window => window.sessionId === workspace.id).map(window => window.layout.root)]
    for (const root of roots) for (const group of groupsOf(root)) for (const tab of group.tabs) {
      if (tab.kind === 'agent' && tab.resourceId && !shown.has(tab.resourceId)) shown.set(tab.resourceId, { projectId: project.id, projectName: project.name, workspace, tab })
    }
  }
  const entries: AttentionEntry[] = []
  const add = (id: string, reason: AttentionReason, detail?: string, since?: string): void => {
    const place = shown.get(id)
    if (!place) return
    entries.push({ projectId: place.projectId, projectName: place.projectName, workspaceId: place.workspace.id, workspaceName: place.workspace.name, tabId: place.tab.id, agentSessionId: id, title: place.tab.title, reason, ...(detail ? { detail: detail.slice(0, 240) } : {}), ...(since ? { since } : {}) })
  }
  const listed = new Set<string>()
  for (const request of sources.permissionRequests?.() ?? []) {
    if (request.status !== 'pending' || listed.has(request.agentSessionId) || !shown.has(request.agentSessionId)) continue
    listed.add(request.agentSessionId)
    add(request.agentSessionId, 'permission', [request.command ?? request.path ?? request.url, request.reason].filter(Boolean).join(' — '), request.createdAt)
  }
  for (const row of sources.agents()) {
    if (!FLAGGED.has(row.activityPhase) || listed.has(row.id)) continue
    const place = shown.get(row.id)
    if (!place || place.projectId !== row.projectId) continue
    const state = sources.snapshot(row.id)
    if (!state) continue
    const settled = settledAt(state)
    if (row.activityPhase === 'waiting_input') {
      const reason: AttentionReason = state.phase === 'waiting_approval' ? 'approval' : 'question'
      listed.add(row.id); add(row.id, reason, undefined, state.items.at(-1)?.timestamp)
      continue
    }
    if (row.activityPhase === 'limited') {
      const continues = place.tab.state?.continueOnLimit === undefined ? place.workspace.continueOnLimit : Boolean(place.tab.state.continueOnLimit)
      if (continues) continue
      listed.add(row.id); add(row.id, 'limit', state.limitResumeAt ? `The usage window reopens at ${new Date(state.limitResumeAt).toLocaleString()}; limit continuation is off.` : 'Stopped on a usage limit; limit continuation is off.', settled)
      continue
    }
    // A failure or a lost connection: the owner's to look at until they have, unless another
    // conversation took the work over.
    if (handedOffIn(state.items) || sources.superseded?.(row.projectId, row.id)) continue
    const seen = tabSeenAt(place.tab), at = settled ? Date.parse(settled) : undefined
    if (seen !== undefined && at !== undefined && seen >= at) continue
    const error = lastError(state)
    const reason: AttentionReason = row.activityPhase === 'disconnected' ? 'interrupted' : error?.code === PROVIDER_USAGE_LIMIT ? 'limit' : 'failed'
    listed.add(row.id); add(row.id, reason, error?.message ?? (reason === 'interrupted' ? 'Its connection was lost while its turn was running.' : undefined), settled)
  }
  const sorted = sortAttention(entries)
  return { entries: sorted.slice(0, ATTENTION_LIMIT), total: sorted.length, observedAt: now.toISOString() }
}

/** Recomputes after a burst of changes and publishes only a changed list. */
export class NeedsAttention {
  private timer?: ReturnType<typeof setTimeout>
  private last?: AttentionSnapshot
  private lastKey = ''

  constructor(private readonly sources: NeedsAttentionSources, private readonly publish: (snapshot: AttentionSnapshot) => void, private readonly delayMs = 250) {}

  snapshot(): AttentionSnapshot {
    if (!this.last) this.refresh(false)
    return this.last!
  }

  /** A status or permission change somewhere: recompute shortly, once per burst. */
  changed(): void {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; this.refresh(true) }, this.delayMs)
    this.timer.unref?.()
  }

  private refresh(announce: boolean): void {
    let next: AttentionSnapshot
    try { next = computeNeedsAttention(this.sources) } catch (error) { console.warn('Needs attention unavailable', error); return }
    const key = JSON.stringify(next.entries) + next.total
    this.last = next
    if (key === this.lastKey) return
    this.lastKey = key
    if (announce) this.publish(next)
  }

  dispose(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined }
}

const REFRESH_MS = 15_000

/** The app's instance: the database's own rows, the pending permission cards, and a refresh on
 *  every agent status change plus a slow tick for layout and permission changes (index.ts). */
export function createNeedsAttention(deps: {
  database: {
    listProjects(): Array<{ id: string; name: string }>
    listSessions(projectId: string): SessionRecord[]
    listDetachedWindows(): DetachedWindowRecord[]
    listAgentActivity(): AttentionAgentRow[]
    structured: { snapshot(id: string): SessionProjection | null }
    getSetting(key: string): string | null
    setSetting(key: string, value: string): void
  }
  permissionRequests(): NonNullable<ReturnType<NonNullable<NeedsAttentionSources['permissionRequests']>>>
  publish(snapshot: AttentionSnapshot): void
}): { attention: NeedsAttention; dispose(): void } {
  const { database } = deps
  const recovery = new CoworkerRecovery(database)
  const attention = new NeedsAttention({
    projects: () => database.listProjects(), workspaces: id => database.listSessions(id), detached: () => database.listDetachedWindows(),
    agents: () => database.listAgentActivity(), snapshot: id => database.structured.snapshot(id),
    permissionRequests: () => deps.permissionRequests(),
    superseded: (projectId, id) => Boolean(recovery.status(projectId, id).superseded)
  }, deps.publish)
  const tick = setInterval(() => attention.changed(), REFRESH_MS)
  tick.unref?.()
  return { attention, dispose: () => { clearInterval(tick); attention.dispose() } }
}
