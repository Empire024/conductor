import type { DatabaseSync } from 'node:sqlite'
import type { PaneTab } from '../shared/models'
import type { ArchivedTab, ArchivedTabPage } from '../shared/tab-archive'
import { isAnonymousTab } from './local-models/anonymous'

type Row = Record<string, unknown>

/** Kinds that are never worth archiving: an empty "New tab" launcher holds nothing to go back to. */
const SKIPPED_KINDS = new Set(['launcher'])
const MAX_TITLE = 400

/**
 * Every closed tab of every workspace (src/shared/tab-archive.ts). It lives in its own table and
 * every write here is best-effort: the reopen list in `sessions.closed_tabs_json` and the
 * workspace autosave never depend on it, so a bad row can cost an archive entry but never a save.
 */
export class TabArchiveStore {
  private readonly listeners = new Set<(sessionId: string) => void>()
  private readonly reopenListeners = new Set<(resourceIds: string[]) => void>()

  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS archived_tabs (
        session_id TEXT NOT NULL,
        tab_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        resource_id TEXT,
        tab_json TEXT NOT NULL,
        closed_at TEXT NOT NULL,
        PRIMARY KEY (session_id, tab_id)
      );
      CREATE INDEX IF NOT EXISTS archived_tabs_session_idx ON archived_tabs(session_id, closed_at DESC);
      CREATE INDEX IF NOT EXISTS archived_tabs_resource_idx ON archived_tabs(resource_id);
    `)
    this.backfill()
  }

  onChanged(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Conversations whose archived tab is open in its workspace again (Ctrl+Shift+T, a close undo). */
  onReopened(listener: (resourceIds: string[]) => void): () => void {
    this.reopenListeners.add(listener)
    return () => { this.reopenListeners.delete(listener) }
  }

  private changed(sessionId: string): void {
    for (const listener of this.listeners) { try { listener(sessionId) } catch { /* a listener never breaks a save */ } }
  }

  /** Tabs closed before the archive existed are the reopen lists already saved; they go in once. */
  private backfill(): void {
    try {
      const done = this.db.prepare("SELECT value FROM settings WHERE key = 'tabArchiveBackfilled'").get() as Row | undefined
      if (done) return
      for (const row of this.db.prepare('SELECT id, project_id, closed_tabs_json, updated_at FROM sessions').all() as Row[]) {
        let tabs: PaneTab[] = []
        try { const parsed: unknown = JSON.parse(String(row.closed_tabs_json || '[]')); if (Array.isArray(parsed)) tabs = parsed as PaneTab[] } catch { continue }
        const base = Date.parse(String(row.updated_at)) || Date.now()
        this.insert(String(row.id), String(row.project_id), tabs, index => new Date(base - (tabs.length - index)).toISOString())
      }
      this.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('tabArchiveBackfilled', '1', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(new Date().toISOString())
    } catch (error) { console.warn('The tab archive could not take in earlier closed tabs', error) }
  }

  private insert(sessionId: string, projectId: string, tabs: readonly PaneTab[], closedAt: (index: number) => string): number {
    const insert = this.db.prepare(`INSERT INTO archived_tabs (session_id, tab_id, project_id, kind, title, resource_id, tab_json, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, tab_id) DO UPDATE SET title = excluded.title, tab_json = excluded.tab_json
      WHERE archived_tabs.tab_json <> excluded.tab_json`)
    let changes = 0
    tabs.forEach((tab, index) => {
      // An anonymous conversation is gone for good once its tab closes; nothing of it is kept.
      if (!validTab(tab) || SKIPPED_KINDS.has(tab.kind) || isAnonymousTab(tab)) return
      try {
        changes += Number(insert.run(sessionId, tab.id, projectId, tab.kind, String(tab.title || 'Untitled tab').slice(0, MAX_TITLE), typeof tab.resourceId === 'string' ? tab.resourceId : null, JSON.stringify(tab), closedAt(index)).changes)
      } catch (error) { console.warn('A closed tab could not be archived', tab.id, error) }
    })
    return changes
  }

  /**
   * Archives these closed tabs of a workspace and takes out any that are open in its layout again
   * (reopened through Ctrl+Shift+T, the close undo or the archive itself). Never throws.
   */
  record(sessionId: string, tabs: readonly PaneTab[], openTabIds?: readonly string[]): void {
    try {
      const session = this.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId) as Row | undefined
      if (!session) return
      const stamp = new Date().toISOString()
      let changes = tabs.length ? this.insert(sessionId, String(session.project_id), tabs, () => stamp) : 0
      if (openTabIds?.length) {
        const reopened = (this.db.prepare('SELECT resource_id FROM archived_tabs WHERE session_id = ? AND resource_id IS NOT NULL AND tab_id IN (SELECT value FROM json_each(?))').all(sessionId, JSON.stringify(openTabIds)) as Row[]).map(row => String(row.resource_id))
        changes += Number(this.db.prepare('DELETE FROM archived_tabs WHERE session_id = ? AND tab_id IN (SELECT value FROM json_each(?))').run(sessionId, JSON.stringify(openTabIds)).changes)
        if (reopened.length) for (const listener of this.reopenListeners) { try { listener(reopened) } catch { /* never breaks a save */ } }
      }
      if (changes) this.changed(sessionId)
    } catch (error) { console.warn('The tab archive could not be updated', error) }
  }

  list(sessionId: string, query = '', limit = 200): ArchivedTabPage {
    const filter = likeFilter(query)
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM archived_tabs WHERE session_id = ?${filter.sql}`).get(sessionId, ...filter.args) as Row).count)
    const rows = this.db.prepare(`SELECT * FROM archived_tabs WHERE session_id = ?${filter.sql} ORDER BY closed_at DESC LIMIT ?`).all(sessionId, ...filter.args, clampLimit(limit, 1000)) as Row[]
    return { tabs: rows.flatMap(mapRow), total }
  }

  count(sessionId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM archived_tabs WHERE session_id = ?').get(sessionId) as Row).count)
  }

  /** Matches across every workspace that is still open (not closed), newest first. */
  search(query: string, limit = 20): ArchivedTab[] {
    const filter = likeFilter(query, 'a.')
    if (!filter.sql) return []
    const rows = this.db.prepare(`SELECT a.*, s.name AS workspace_name FROM archived_tabs a JOIN sessions s ON s.id = a.session_id
      WHERE s.closed_at IS NULL${filter.sql} ORDER BY a.closed_at DESC LIMIT ?`).all(...filter.args, clampLimit(limit, 100)) as Row[]
    return rows.flatMap(mapRow)
  }

  get(sessionId: string, tabIds: readonly string[]): ArchivedTab[] {
    if (!tabIds.length) return []
    const rows = this.db.prepare('SELECT * FROM archived_tabs WHERE session_id = ? AND tab_id IN (SELECT value FROM json_each(?)) ORDER BY closed_at ASC').all(sessionId, JSON.stringify(tabIds)) as Row[]
    return rows.flatMap(mapRow)
  }

  /** `forgetReopen` (delete forever) also takes them off the workspace's saved reopen list, so the
   *  next autosave cannot bring them back; a renderer holding that list drops them itself. */
  remove(sessionId: string, tabIds: readonly string[], options: { forgetReopen?: boolean } = {}): number {
    if (!tabIds.length) return 0
    const removed = Number(this.db.prepare('DELETE FROM archived_tabs WHERE session_id = ? AND tab_id IN (SELECT value FROM json_each(?))').run(sessionId, JSON.stringify(tabIds)).changes)
    if (options.forgetReopen) {
      try {
        const row = this.db.prepare('SELECT closed_tabs_json FROM sessions WHERE id = ?').get(sessionId) as Row | undefined
        const closed = row ? JSON.parse(String(row.closed_tabs_json || '[]')) as unknown : []
        if (Array.isArray(closed)) {
          const drop = new Set(tabIds), kept = closed.filter(tab => !drop.has((tab as PaneTab)?.id))
          if (kept.length !== closed.length) this.db.prepare('UPDATE sessions SET closed_tabs_json = ? WHERE id = ?').run(JSON.stringify(kept), sessionId)
        }
      } catch (error) { console.warn('The reopen list could not be trimmed', error) }
    }
    if (removed) this.changed(sessionId)
    return removed
  }

  /** The newest archived tab of this conversation (an agentSessionId, a terminal id), wherever it was closed. */
  findByResource(resourceId: string): ArchivedTab | null {
    const row = this.db.prepare('SELECT a.*, s.name AS workspace_name FROM archived_tabs a JOIN sessions s ON s.id = a.session_id WHERE a.resource_id = ? AND s.closed_at IS NULL ORDER BY a.closed_at DESC LIMIT 1').get(resourceId) as Row | undefined
    return row ? mapRow(row)[0] ?? null : null
  }
}

const validTab = (tab: unknown): tab is PaneTab => Boolean(tab) && typeof tab === 'object' && typeof (tab as PaneTab).id === 'string' && (tab as PaneTab).id.length > 0 && (tab as PaneTab).id.length <= 160 && typeof (tab as PaneTab).kind === 'string'

const clampLimit = (limit: number, max: number): number => Math.max(1, Math.min(max, Math.floor(Number.isFinite(limit) ? limit : max)))

/** Every title word (in any order), or the whole query as a fragment of an agent or tab id, as SQL
 *  LIKE terms. Words never match ids one by one: "Shell 5" must not find every id with a 5 in it. */
function likeFilter(query: string, prefix = ''): { sql: string; args: string[] } {
  const whole = query.trim().toLowerCase()
  const words = whole.split(/\s+/).filter(Boolean).slice(0, 8)
  if (!words.length) return { sql: '', args: [] }
  const escape = (word: string): string => '%' + word.replace(/[\\%_]/g, match => '\\' + match) + '%'
  const title = words.map(() => `lower(${prefix}title) LIKE ? ESCAPE '\\'`).join(' AND ')
  return {
    sql: ` AND ((${title}) OR lower(COALESCE(${prefix}resource_id, '')) LIKE ? ESCAPE '\\' OR lower(${prefix}tab_id) LIKE ? ESCAPE '\\')`,
    args: [...words.map(escape), escape(whole), escape(whole)]
  }
}

function mapRow(row: Row): ArchivedTab[] {
  try {
    const tab = JSON.parse(String(row.tab_json)) as PaneTab
    if (!validTab(tab)) return []
    return [{ tab, projectId: String(row.project_id), sessionId: String(row.session_id), closedAt: String(row.closed_at), ...(typeof row.workspace_name === 'string' ? { workspaceName: row.workspace_name } : {}) }]
  } catch { return [] }
}
