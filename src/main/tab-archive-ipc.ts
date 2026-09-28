import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import type { AgentControlLink, AgentControlUiRequest } from '../shared/agent-control'
import type { AgentSpec, LayoutNode, PaneTab } from '../shared/models'
import { TAB_OPENED_BY_PREFIX, type TabLineage } from '../shared/tab-archive'
import { COWORKER_OPENED_PREFIX } from './coworker-autoclose'
import { CoworkerRecovery } from './coworker-recovery'
import type { ConductorDatabase } from './database'
import { uncollectedReportReason, type TabArchiver } from './tab-archive-eligibility'

/** agent-control.ts keeps a finished coworker's dispatch under this prefix (FINISHED_LINK_PREFIX). */
const FINISHED_LINK_PREFIX = 'agentControlFinished:'
const PARENT_LINK_PREFIX = 'agentControlParent:'
const AGENT_ID = /^agent_[A-Za-z0-9_-]{1,150}$/
const MAX_IDS = 500

/**
 * Every tab an agent opens passes the app-control UI bridge as a `tabs.open` request carrying the
 * caller's own conversation id: a coworker (tabs.open, router.dispatch), a handoff successor, a
 * fork. That is recorded here, once per tab, so the tab can say who opened it without asking any
 * model. The owner's own credential ('owner') opens nothing on anyone's behalf and is not recorded.
 */
export function recordTabOpener(database: Pick<ConductorDatabase, 'getSetting' | 'setSetting'>, request: AgentControlUiRequest): void {
  if (request.action !== 'tabs.open' || !AGENT_ID.test(request.agentSessionId)) return
  const tab = request.params.tab as PaneTab | undefined
  if (!tab || tab.kind !== 'agent' || typeof tab.resourceId !== 'string' || tab.resourceId === request.agentSessionId) return
  try {
    const key = TAB_OPENED_BY_PREFIX + tab.resourceId
    if (database.getSetting(key)) return
    database.setSetting(key, JSON.stringify({ agentSessionId: request.agentSessionId, at: new Date().toISOString() }))
  } catch (error) { console.warn('Could not record which agent opened a tab', error) }
}

/** The conversation a UI request puts back on screen (a reopen, a focus of a closed tab), whose
 *  archive latch (StructuredSessions.beginArchive) must go before anything is sent to it. */
export function reopenedConversation(request: AgentControlUiRequest): string | null {
  if (request.action === 'tabs.open') { const tab = request.params.tab as PaneTab | undefined; return tab?.kind === 'agent' && typeof tab.resourceId === 'string' ? tab.resourceId : null }
  if (request.action === 'tabs.focus-origin') return typeof request.params.agentSessionId === 'string' ? request.params.agentSessionId : null
  return null
}

/** Who opened this conversation's tab: the recorded opener, else (for tabs opened before that was
 *  recorded) the controller that dispatched it, from the control links agent-control keeps. */
function openerOf(database: ConductorDatabase, agentSessionId: string): string | null {
  const read = (key: string): string | null => { try { return database.getSetting(key) } catch { return null } }
  const json = <T>(key: string): T | null => { try { const raw = read(key); return raw ? JSON.parse(raw) as T : null } catch { return null } }
  const recorded = json<{ agentSessionId?: unknown }>(TAB_OPENED_BY_PREFIX + agentSessionId)?.agentSessionId
  if (typeof recorded === 'string') return recorded
  const dispatched = read(COWORKER_OPENED_PREFIX + agentSessionId)
  if (dispatched && AGENT_ID.test(dispatched)) return dispatched
  for (const prefix of [FINISHED_LINK_PREFIX, PARENT_LINK_PREFIX]) {
    const link = json<AgentControlLink>(prefix + agentSessionId)
    if (link?.targetAgentSessionId === agentSessionId && typeof link.controllerAgentSessionId === 'string') return link.controllerAgentSessionId
  }
  return null
}

/** Everyone this conversation's reports may be waiting in: its live controller, whoever opened
 *  or dispatched it, and every successor that took one of them over (agents.report forwards). */
export function uncollectedReport(database: ConductorDatabase, agentSessionId: string, controller: string | null = null): string | null {
  const recovery = new CoworkerRecovery(database)
  const candidates = new Set<string>()
  for (const start of [controller, openerOf(database, agentSessionId)]) {
    for (let id = start, hops = 0; id && hops < 8 && !candidates.has(id); hops++) {
      candidates.add(id)
      const projectId = database.structured.spec<AgentSpec>(id)?.projectId
      let next: string | undefined
      try { next = projectId ? recovery.status(projectId, id).superseded?.by : undefined } catch { next = undefined }
      id = next ?? null
    }
  }
  candidates.delete(agentSessionId)
  return uncollectedReportReason(agentSessionId, [...candidates].map(id => {
    const state = database.structured.snapshot(id)
    // The name the owner sees on its tab, else the one it was opened with.
    return { title: openTitle(database, id) ?? (database.structured.spec<AgentSpec>(id)?.title || state?.title || id), state }
  }))
}

const tabsOf = (node: LayoutNode): PaneTab[] => node.type === 'split' ? [...tabsOf(node.children[0]), ...tabsOf(node.children[1])] : node.tabs

function openTitle(database: ConductorDatabase, agentSessionId: string): string | null {
  for (const project of database.listProjects()) for (const session of database.listSessions(project.id)) {
    const tab = tabsOf(session.layout.root).find(candidate => candidate.kind === 'agent' && candidate.resourceId === agentSessionId)
    if (tab) return tab.title
  }
  for (const window of database.listDeskDetachedWindows()) {
    const tab = tabsOf(window.layout.root).find(candidate => candidate.kind === 'agent' && candidate.resourceId === agentSessionId)
    if (tab) return tab.title
  }
  return null
}

/** The "continued from" / "opened by" line of an agent tab; null for a tab nobody opened for it. */
export function tabLineage(database: ConductorDatabase, agentSessionId: string): TabLineage | null {
  const opener = openerOf(database, agentSessionId)
  if (!opener || opener === agentSessionId) return null
  const spec = database.structured.spec<AgentSpec>(opener)
  let relation: TabLineage['relation'] = 'opened'
  try { if (spec && new CoworkerRecovery(database).status(spec.projectId, opener).superseded?.by === agentSessionId) relation = 'continued' } catch { /* a missing record reads as opened */ }
  const open = openTitle(database, opener)
  const archived = open === null ? database.tabArchive.findByResource(opener) : null
  const title = open ?? archived?.tab.title ?? database.structured.snapshot(opener)?.title ?? spec?.title ?? 'another tab'
  return { relation, agentSessionId: opener, title, ...(archived ? { archived: { projectId: archived.projectId, sessionId: archived.sessionId, tabId: archived.tab.id } } : {}) }
}

const idList = (value: unknown, what: string): string[] => {
  if (!Array.isArray(value) || value.length > MAX_IDS || value.some(id => typeof id !== 'string' || !id || id.length > 160)) throw new Error(`Invalid ${what}`)
  return value as string[]
}
const text = (value: unknown, what: string, max: number): string => {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`Invalid ${what}`)
  return value
}

/** Just what a tab needs to come back; anything else a renderer sends is not stored. */
function closedTab(value: unknown): PaneTab | null {
  if (!value || typeof value !== 'object') return null
  const tab = value as PaneTab
  if (typeof tab.id !== 'string' || !tab.id || tab.id.length > 160 || typeof tab.kind !== 'string' || typeof tab.title !== 'string') return null
  const size = JSON.stringify(tab).length
  return size <= 64_000 ? tab : null
}

export function registerTabArchiveIpc(deps: {
  database: ConductorDatabase
  trusted(event: Electron.IpcMainInvokeEvent): void
  /** The app-control UI bridge, which puts a tab into whichever window shows its workspace. */
  ui(): ((request: AgentControlUiRequest) => Promise<unknown>) | undefined
  publish(channel: string, payload: unknown): void
  /** The atomic archive (tab-archive-eligibility.ts); assigned once app control is up. */
  archiver(): TabArchiver | undefined
  /** Releases the archive latch of conversations whose tab came back (StructuredSessions.endArchive). */
  reopened(agentSessionIds: string[]): void
}): () => void {
  const { database, trusted } = deps
  const store = database.tabArchive
  const stop = store.onChanged(sessionId => deps.publish('tab-archive:changed', { sessionId }))
  const stopReopened = store.onReopened(ids => deps.reopened(ids))
  ipcMain.handle('tab-archive:list', (event, sessionId: unknown, query: unknown, limit: unknown) => {
    trusted(event)
    return store.list(text(sessionId, 'workspace', 160), typeof query === 'string' ? query.slice(0, 200) : '', typeof limit === 'number' ? limit : 200)
  })
  ipcMain.handle('tab-archive:search', (event, query: unknown, limit: unknown) => {
    trusted(event)
    return typeof query === 'string' && query.trim().length >= 2 ? store.search(query.slice(0, 200), typeof limit === 'number' ? limit : 20) : []
  })
  ipcMain.handle('tab-archive:reopen', async (event, sessionId: unknown, tabIds: unknown) => {
    trusted(event)
    const id = text(sessionId, 'workspace', 160), ids = idList(tabIds, 'tab list')
    const session = database.getSession(id)
    if (!session || !database.listSessions(session.projectId).some(candidate => candidate.id === id)) throw new Error('That workspace is closed; restore it first, then reopen its tabs')
    const ui = deps.ui()
    if (!ui) throw new Error('Conductor is still starting; try again in a moment')
    // A tab that is open again (an undo in a detached window) only leaves the archive; opening it
    // a second time would put one tab id in two places.
    const open = new Set([session.layout.root, ...database.listDeskDetachedWindows().filter(window => window.sessionId === id).map(window => window.layout.root)].flatMap(root => tabsOf(root).map(tab => tab.id)))
    const all = store.get(id, ids), already = all.filter(entry => open.has(entry.tab.id))
    if (already.length) store.remove(id, already.map(entry => entry.tab.id))
    const entries = all.filter(entry => !open.has(entry.tab.id))
    let reopened = 0
    deps.reopened(entries.flatMap(entry => entry.tab.kind === 'agent' && entry.tab.resourceId ? [entry.tab.resourceId] : []))
    for (const [index, entry] of entries.entries()) {
      await ui({ projectId: session.projectId, sessionId: id, agentSessionId: 'owner', id: randomUUID(), action: 'tabs.open', params: { tab: entry.tab, focus: index === entries.length - 1 } })
      store.remove(id, [entry.tab.id])
      reopened++
    }
    return { reopened }
  })
  ipcMain.handle('tab-archive:remove', (event, sessionId: unknown, tabIds: unknown) => {
    trusted(event)
    return { removed: store.remove(text(sessionId, 'workspace', 160), idList(tabIds, 'tab list'), { forgetReopen: true }) }
  })
  ipcMain.handle('tab-archive:record', (event, sessionId: unknown, tabs: unknown) => {
    trusted(event)
    if (!Array.isArray(tabs) || tabs.length > MAX_IDS) throw new Error('Invalid tab list')
    store.record(text(sessionId, 'workspace', 160), tabs.flatMap(tab => { const valid = closedTab(tab); return valid ? [valid] : [] }))
  })
  ipcMain.handle('tab-archive:archive', (event, projectId: unknown, sessionId: unknown, tabIds: unknown) => {
    trusted(event)
    const archiver = deps.archiver()
    if (!archiver) throw new Error('Conductor is still starting; try again in a moment')
    return archiver.archive(text(projectId, 'project', 160), text(sessionId, 'workspace', 160), idList(tabIds, 'tab list'))
  })
  ipcMain.handle('tab-archive:lineage', (event, agentSessionId: unknown) => {
    trusted(event)
    return tabLineage(database, text(agentSessionId, 'conversation', 160))
  })
  return () => {
    stop(); stopReopened()
    for (const channel of ['list', 'search', 'reopen', 'remove', 'record', 'archive', 'lineage']) ipcMain.removeHandler('tab-archive:' + channel)
  }
}
