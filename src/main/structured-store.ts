import { recoverClaudeMessageDuplicates } from '../shared/claude-message-recovery'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent, AgentEventData, ConversationHistoryEntry, ConversationSearchGroup, ConversationSearchResult, DiffArtifact, SessionProjection, SessionSettings, StructuredProvider, TimelineItem } from '../shared/structured-agent'
import type { WeeklyUsageConversation, WeeklyUsageEvent } from '../shared/weekly-model-usage'
import { emptyProjection, projectAgentEvent } from '../shared/structured-agent-reducer'
import { liveCostLimits, liveReplacementAuthorization } from './live-test-policy'

export function sanitizeDiagnostic(value: unknown): unknown {
  if (typeof value === 'string') return value
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-(?:ant-)?[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
  if (Array.isArray(value)) return value.map(sanitizeDiagnostic)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(authorization|api_?key|access_?token|refresh_?token|password|secret|env|environment)$/i.test(key) ? '[REDACTED]' : sanitizeDiagnostic(item)]))
  return value
}

/** Find only searches what the owner actually read: a message. Tool payloads, diffs, ids and
 *  provider internals are in the projection too, and matching them turns a find into noise. */
export function searchableMessage(item: TimelineItem): { role: 'user' | 'assistant' | 'status'; text: string } | null {
  return item.data.type === 'text' && item.data.text ? { role: item.data.role, text: item.data.text } : null
}
const SNIPPET_RADIUS = 70
/** Whitespace is flattened one character at a time (never collapsed) so the reported offset still
 *  addresses the match inside the snippet the renderer marks. */
export function messageSnippet(text: string, index: number, length: number, radius = SNIPPET_RADIUS): { snippet: string; matchStart: number } {
  const start = Math.max(0, index - radius), end = Math.min(text.length, index + length + radius)
  const lead = start > 0 ? '…' : ''
  return { snippet: lead + text.slice(start, end).replace(/\s/g, ' ') + (end < text.length ? '…' : ''), matchStart: index - start + lead.length }
}
const MAX_SEARCH_GROUPS = 20, MAX_SEARCH_HITS = 5, MIN_SEARCH_QUERY = 2

/** The envelope fields weekly accounting reads, projected out of the event blob by SQLite so the
 *  transcript body each blob carries never crosses into the main process. */
const SESSION_MODEL = `COALESCE(json_extract(event_json,'$.data.capabilities.effectiveSettings.model'),json_extract(event_json,'$.data.settings.model'))`
const ACCOUNTING_COLUMNS = `event_kind,sequence,event_at AS timestamp,
  json_extract(event_json,'$.id') AS id, json_extract(event_json,'$.runtimeId') AS runtimeId,
  json_extract(event_json,'$.provider') AS provider, json_extract(event_json,'$.nativeSessionId') AS nativeSessionId,
  json_extract(event_json,'$.turnId') AS turnId, json_extract(event_json,'$.itemId') AS itemId,
  json_extract(event_json,'$.parentId') AS parentId,
  json_extract(event_json,'$.data.scope') AS scope, json_extract(event_json,'$.data.source') AS source,
  json_extract(event_json,'$.data.phase') AS phase, ${SESSION_MODEL} AS model,
  json_extract(event_json,'$.data.inputTokens') AS inputTokens, json_extract(event_json,'$.data.outputTokens') AS outputTokens,
  json_extract(event_json,'$.data.cachedTokens') AS cachedTokens, json_extract(event_json,'$.data.cacheCreationTokens') AS cacheCreationTokens,
  json_extract(event_json,'$.data.reasoningTokens') AS reasoningTokens, json_extract(event_json,'$.data.totalTokens') AS totalTokens`
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cachedTokens', 'cacheCreationTokens', 'reasoningTokens', 'totalTokens'] as const
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
function usageEvent(row: Record<string, unknown>, data: AgentEventData): WeeklyUsageEvent {
  const event: WeeklyUsageEvent = { id: text(row.id) ?? '', sequence: Number(row.sequence), timestamp: text(row.timestamp) ?? '', runtimeId: text(row.runtimeId) ?? '', data }
  const provider = text(row.provider), nativeSessionId = text(row.nativeSessionId), turnId = text(row.turnId), itemId = text(row.itemId), parentId = text(row.parentId)
  if (provider) event.provider = provider as StructuredProvider
  if (nativeSessionId) event.nativeSessionId = nativeSessionId
  if (turnId) event.turnId = turnId
  if (itemId) event.itemId = itemId
  if (parentId) event.parentId = parentId
  return event
}

export class StructuredAgentStore {
  private artifactBytes = 0
  private projections = new Map<string, SessionProjection>()
  readonly artifactDirectory: string
  constructor(private db: DatabaseSync, dataDirectory: string) {
    this.artifactDirectory = join(dataDirectory, 'agent-artifacts')
    mkdirSync(this.artifactDirectory, { recursive: true, mode: 0o700 })
    this.artifactBytes = readdirSync(this.artifactDirectory).filter(name => /^[a-f0-9-]+\.(json|txt)$/.test(name)).reduce((sum, name) => sum + statSync(join(this.artifactDirectory, name)).size, 0)
    db.exec(`
      CREATE TABLE IF NOT EXISTS structured_sessions (
        id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL, provider TEXT NOT NULL, spec_json TEXT NOT NULL,
        projection_json TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS structured_sessions_project ON structured_sessions(project_id);
      CREATE TABLE IF NOT EXISTS structured_events (
        session_id TEXT NOT NULL REFERENCES structured_sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS structured_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS structured_runtimes (
        session_id TEXT NOT NULL REFERENCES structured_sessions(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL, started_at TEXT NOT NULL, first_sequence INTEGER NOT NULL,
        PRIMARY KEY(session_id, runtime_id)
      );
      CREATE TABLE IF NOT EXISTS structured_artifacts (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES structured_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, filename TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS live_suite_budget (
        suite_id TEXT NOT NULL, provider TEXT NOT NULL, submissions INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0, PRIMARY KEY(suite_id, provider)
      );
      CREATE TABLE IF NOT EXISTS live_suite_limits (
        suite_id TEXT NOT NULL, provider TEXT NOT NULL, provider_usd REAL NOT NULL,
        suite_usd REAL NOT NULL, PRIMARY KEY(suite_id, provider)
      );
      CREATE TABLE IF NOT EXISTS live_suite_amendments (
        suite_id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider='codex'),
        kind TEXT NOT NULL CHECK(kind='one-replacement-A'),
        prior_submissions INTEGER NOT NULL CHECK(prior_submissions=1),
        authorized_at TEXT NOT NULL
      );
    `)
    this.ensureAccountingSchema()
    // Historical projection is independent of reconnect. Never retry uncertain execution.
    const rows = db.prepare('SELECT id, provider, projection_json FROM structured_sessions').all() as Array<{ id: string; provider: string; projection_json: string }>
    for (const row of rows) {
      const state = JSON.parse(row.projection_json) as SessionProjection
      const events = this.events(row.id, state.sequence)
      let restored = events.reduce(projectAgentEvent, state)
      if (['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'].includes(restored.phase)) restored = { ...restored, phase: 'disconnected' }
      restored.pendingSteering = restored.pendingSteering?.map(input => ['sending', 'accepted'].includes(input.status) ? { ...input, status: 'uncertain' as const } : input)
      restored.items = restored.items.map(item => item.data.type === 'interaction' && item.data.interaction.status === 'pending' ? { ...item, data: { ...item.data, interaction: { ...item.data.interaction, status: 'expired' } } } : item)
      restored.items = restored.items.map(item => item.data.type === 'tool' && ['running', 'preparing', 'awaiting_approval'].includes(item.data.status) ? { ...item, data: { ...item.data, status: 'interrupted' } } : item)
      if (row.provider === 'claude') restored.items = recoverClaudeMessageDuplicates(restored.items)
      this.projections.set(row.id, restored)
    }
  }
  /**
   * Accounting reads must never scan the transcript. `structured_events` stores one opaque JSON
   * blob per event, so without these the only way to find the few usage rows in a journal of
   * millions was a full-table `json_extract` scan - seconds of blocked main process per read, and
   * a whole transcript's worth of strings parsed to total seven days of tokens. The generated
   * columns are virtual (no table rewrite, no stored duplication) and the indexes are partial, so
   * they cover only the usage and session rows accounting actually reads.
   */
  private ensureAccountingSchema(): void {
    // One commit: on a fresh journal this is five schema writes, and every launch and every test
    // fixture would otherwise pay a separate fsync for each of them.
    this.db.exec('BEGIN')
    try { this.applyAccountingSchema(); this.db.exec('COMMIT') } catch (reason) { this.db.exec('ROLLBACK'); throw reason }
  }
  private applyAccountingSchema(): void {
    // Generated columns are hidden, so only `table_xinfo` reports one that already exists.
    const columns = this.db.prepare('PRAGMA table_xinfo(structured_events)').all() as Array<{ name: string }>
    const missing = (name: string): boolean => !columns.some(column => column.name === name)
    if (missing('event_kind')) this.db.exec(`ALTER TABLE structured_events ADD COLUMN event_kind TEXT GENERATED ALWAYS AS (json_extract(event_json,'$.data.type')) VIRTUAL`)
    if (missing('event_at')) this.db.exec(`ALTER TABLE structured_events ADD COLUMN event_at TEXT GENERATED ALWAYS AS (json_extract(event_json,'$.timestamp')) VIRTUAL`)
    // Building an index over this table is one scan of every event body no matter how narrow the
    // result, so accounting gets exactly one: conversation first, because every read is scoped to
    // a conversation, and both kinds together, because splitting them by kind in JavaScript is
    // free and a second index is another full scan of a multi-gigabyte journal.
    this.db.exec(`CREATE INDEX IF NOT EXISTS structured_events_accounting ON structured_events(session_id,event_at) WHERE event_kind IN ('usage','session')`)
    // Runtime starts decide whether a cumulative counter predates the reporting window. `append`
    // records them exactly from here on; this backfill only has to cover runtimes that already
    // existed, and it reads them through the index just built rather than scanning again. A
    // runtime's first accounting row can trail its true first event by seconds, which matters only
    // if a window boundary lands in that gap - and those runtimes leave the window within a week.
    if (this.db.prepare("SELECT value FROM structured_meta WHERE key='runtimes_backfilled'").get()) return
    this.db.exec(`
      INSERT OR IGNORE INTO structured_runtimes(session_id,runtime_id,started_at,first_sequence)
      SELECT session_id, json_extract(event_json,'$.runtimeId'), MIN(event_at), MIN(sequence)
      FROM structured_events
      WHERE event_kind IN ('usage','session') AND json_extract(event_json,'$.runtimeId') IS NOT NULL AND event_at IS NOT NULL
      GROUP BY session_id, json_extract(event_json,'$.runtimeId')
    `)
    this.db.prepare("INSERT INTO structured_meta(key,value) VALUES('runtimes_backfilled',?)").run(new Date().toISOString())
  }
  register(id: string, projectId: string, provider: StructuredProvider, spec: unknown): SessionProjection {
    const existing = this.snapshot(id)
    if (existing) return existing
    const state = emptyProjection(id)
    this.db.prepare('INSERT INTO structured_sessions(id, project_id, provider, spec_json, projection_json) VALUES(?,?,?,?,?)').run(id, projectId, provider, JSON.stringify(spec), JSON.stringify(state))
    this.projections.set(id, state)
    return state
  }
  spec<T>(id: string): T | null {
    const row = this.db.prepare('SELECT spec_json FROM structured_sessions WHERE id=?').get(id) as { spec_json: string } | undefined
    return row ? JSON.parse(row.spec_json) as T : null
  }
  /** Project-scoped specs, without touching the potentially multi-GB event journal. */
  projectSpecs<T>(projectId: string): T[] {
    const rows = this.db.prepare('SELECT spec_json FROM structured_sessions WHERE project_id=?').all(projectId) as Array<{ spec_json: string }>
    return rows.map(row => JSON.parse(row.spec_json) as T)
  }
  rebindWorkspace(id: string, sessionId: string): void {
    const spec = this.spec<Record<string, unknown>>(id)
    if (!spec) throw new Error('Session not found')
    this.db.prepare('UPDATE structured_sessions SET spec_json=? WHERE id=?').run(JSON.stringify({ ...spec, sessionId }), id)
  }
  /** The limit-continuation choice is a live workspace preference, not part of the conversation's
   *  identity the way provider and cwd are: the owner flips it long after registration, and the
   *  registered spec has to follow or the conversation waits on a flag nobody can change. */
  setContinueOnLimit(id: string, continueOnLimit: boolean): void {
    const spec = this.spec<Record<string, unknown>>(id)
    if (!spec) return
    this.db.prepare('UPDATE structured_sessions SET spec_json=? WHERE id=?').run(JSON.stringify({ ...spec, continueOnLimit }), id)
  }
  rebindProject(projectId: string, cwd: string): void {
    for (const row of this.db.prepare('SELECT id,spec_json FROM structured_sessions WHERE project_id=?').all(projectId) as Array<{ id: string; spec_json: string }>) {
      const spec = JSON.parse(row.spec_json) as Record<string, unknown>
      this.db.prepare('UPDATE structured_sessions SET spec_json=? WHERE id=?').run(JSON.stringify({ ...spec, cwd }), row.id)
    }
  }
  snapshot(id: string): SessionProjection | null { return this.projections.get(id) ?? null }
  /** Called only after the archive transaction committed its validated, fresh identities. */
  loadImported(ids: string[]): void {
    for (const id of ids) {
      const row = this.db.prepare('SELECT projection_json FROM structured_sessions WHERE id=?').get(id) as { projection_json: string } | undefined
      if (row) this.projections.set(id, JSON.parse(row.projection_json) as SessionProjection)
    }
  }
  append(event: AgentEvent): AgentEvent {
    const state = this.snapshot(event.sessionId)
    if (!state || event.sequence !== state.sequence + 1) throw new Error('Non-contiguous provider event sequence')
    const safe = sanitizeDiagnostic(event) as AgentEvent
    this.db.prepare('INSERT INTO structured_events(session_id,sequence,event_json) VALUES(?,?,?)').run(event.sessionId, event.sequence, JSON.stringify(safe))
    // Sequence is assigned monotonically, so the first row wins and remains the runtime's start
    // even after `checkpoint` compacts the events it was read from.
    if (safe.runtimeId && safe.timestamp) this.db.prepare('INSERT OR IGNORE INTO structured_runtimes(session_id,runtime_id,started_at,first_sequence) VALUES(?,?,?,?)').run(safe.sessionId, safe.runtimeId, safe.timestamp, safe.sequence)
    this.projections.set(event.sessionId, projectAgentEvent(state, safe))
    return safe
  }
  checkpoint(id: string): void {
    const state = this.snapshot(id)
    if (!state) return
    this.db.prepare('UPDATE structured_sessions SET projection_json=?, title=?, archived=? WHERE id=?').run(JSON.stringify(state), state.title, state.archived ? 1 : 0, id)
    // Snapshot anchors older history before compacting the bounded event journal.
    if (state.sequence > 20_000) this.db.prepare('DELETE FROM structured_events WHERE session_id=? AND sequence<?').run(id, state.sequence - 20_000)
  }
  update(id: string, values: Partial<Pick<SessionProjection, 'title' | 'archived' | 'settings'>>): void {
    const state = this.snapshot(id)
    if (!state) throw new Error('Session not found')
    this.projections.set(id, { ...state, ...values })
    this.checkpoint(id)
  }
  cloneHistory(sourceId: string, targetId: string): void {
    const source = this.snapshot(sourceId), target = this.snapshot(targetId)
    if (!source || !target) throw new Error('Fork session not registered')
    const items = source.items.map(item => {
      if (item.data.type === 'interaction') return { ...item, data: { ...item.data, interaction: { ...item.data.interaction, status: 'expired' as const } } }
      if (item.data.type === 'changes') return { ...item, data: { ...item.data, changes: item.data.changes.map(change => change.artifactId ? { ...change, artifactId: this.putArtifact(targetId, { ...this.artifact(sourceId, change.artifactId), sessionId: targetId }).id } : change) } }
      if (item.data.type === 'tool' && item.data.outputArtifactId) return { ...item, data: { ...item.data, outputArtifactId: this.putOutput(targetId, this.output(sourceId, item.data.outputArtifactId)) } }
      return item
    })
    this.projections.set(targetId, { ...target, sequence: source.sequence, items, title: `${source.title} (fork)`, settings: source.settings, truncated: source.truncated, capabilities: source.capabilities })
    this.checkpoint(targetId)
  }
  events(id: string, after = 0): AgentEvent[] {
    return (this.db.prepare('SELECT event_json FROM structured_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT 20001').all(id, after) as Array<{ event_json: string }>).map(row => JSON.parse(row.event_json) as AgentEvent)
  }
  /**
   * A narrow durable journal for shared weekly accounting. It bypasses history()'s UI cap and
   * events()'s page cap, and reads only the envelope and token fields accounting needs - never
   * `event_json` itself, because the usage rows of a long-lived journal carry hundreds of
   * megabytes of transcript alongside the few numbers a seven-day total is made of.
   *
   * `since` opens the reporting window and `from` the baseline lookback before it. Only the two
   * kinds of pre-window row the summary can still act on are read: a cumulative session counter,
   * which is the baseline its first in-window report is measured against, and the model a
   * conversation was last set to. Counters whose baseline falls outside `from` are reported as
   * excluded rather than counted whole - `runtimeStarts` stays exact, so a runtime that predates
   * the window can never be mistaken for one that began inside it.
   */
  usageJournal(from = '', since = from): WeeklyUsageConversation[] {
    return this.usageSessions().flatMap(id => this.usageConversation(id, from, since) ?? [])
  }
  /** Conversation ids in journal order, so a caller can read the window one conversation at a
   *  time and yield the main process between them instead of blocking it for the whole scan. */
  usageSessions(): string[] {
    return (this.db.prepare('SELECT id FROM structured_sessions ORDER BY rowid').all() as Array<{ id: string }>).map(row => row.id)
  }
  /** One conversation's slice of {@link usageJournal}. Every read is a range scan of the partial
   *  accounting indexes over this conversation alone, so no single call is a long block. */
  usageConversation(sessionId: string, from: string, since: string): WeeklyUsageConversation | null {
    const session = this.db.prepare('SELECT provider,spec_json FROM structured_sessions WHERE id=?').get(sessionId) as { provider: StructuredProvider; spec_json: string } | undefined
    if (!session) return null
    // Inside the window both kinds are read in full. Before it, only the two rows the summary can
    // still act on: a cumulative session counter, which is the baseline its first in-window report
    // is measured against, and the model the conversation was last set to.
    const rows = this.db.prepare(`
      SELECT ${ACCOUNTING_COLUMNS} FROM structured_events
      WHERE session_id=? AND event_kind IN ('usage','session') AND event_at>=?
        AND (event_at>=?
          OR (event_kind='usage' AND json_extract(event_json,'$.data.scope')='session')
          OR (event_kind='session' AND ${SESSION_MODEL} IS NOT NULL))
      ORDER BY sequence
    `).all(sessionId, from, since) as Array<Record<string, unknown>>
    if (!rows.length) return null
    const events: WeeklyUsageEvent[] = []
    let carried: WeeklyUsageEvent | null = null
    for (const row of rows) {
      if (row.event_kind === 'usage') {
        const data: AgentEventData = { type: 'usage', source: row.source === 'estimate' ? 'estimate' : 'provider' }
        if (row.scope === 'session' || row.scope === 'turn' || row.scope === 'message') data.scope = row.scope
        for (const field of TOKEN_FIELDS) {
          const value = row[field]
          if (typeof value === 'number' && Number.isFinite(value)) data[field] = value
        }
        events.push(usageEvent(row, data))
        continue
      }
      // Only the resolved model is read back from a session event, so the rest of its payload -
      // capabilities, titles, provider messages - never leaves SQLite.
      const named = text(row.model)
      const event = usageEvent(row, { type: 'session', phase: (text(row.phase) ?? 'idle') as SessionProjection['phase'], ...(named ? { settings: { model: named } as SessionSettings } : {}) })
      // Pre-window session events are read only to carry a model forward, and the last one wins.
      if (text(row.timestamp)! < since) carried = event
      else events.push(event)
    }
    if (carried) events.push(carried)
    if (!events.length) return null
    events.sort((a, b) => a.sequence - b.sequence)
    const runtimeStarts = Object.fromEntries((this.db.prepare('SELECT runtime_id,started_at FROM structured_runtimes WHERE session_id=?').all(sessionId) as Array<{ runtime_id: string; started_at: string }>).map(row => [row.runtime_id, row.started_at]))
    const first = this.db.prepare('SELECT sequence FROM structured_events WHERE session_id=? ORDER BY sequence LIMIT 1').get(sessionId) as { sequence: number } | undefined
    let model: string | undefined
    try { const spec = JSON.parse(session.spec_json) as { model?: unknown }; if (typeof spec.model === 'string') model = spec.model } catch { /* malformed legacy spec: session events may still name it */ }
    return { sessionId, provider: session.provider, ...(model ? { model } : {}), events, runtimeStarts, truncated: (first?.sequence ?? 1) > 1 }
  }
  /**
   * The newest reported allowance windows for one provider. Auto Fixer keeps only the latest
   * observation per window key, so it never needed the whole journal: a window that has not been
   * reported inside `from` is either already reset or too stale to authorize anything.
   */
  recentUsageLimits(provider: StructuredProvider, from: string, perConversation = 20): Array<{ observedAt: string; limits: unknown }> {
    const sessions = this.db.prepare('SELECT id FROM structured_sessions WHERE provider=?').all(provider) as Array<{ id: string }>
    const newest = this.db.prepare(`
      SELECT event_at AS observedAt, json_extract(event_json,'$.data.limits') AS limits
      FROM structured_events
      WHERE session_id=? AND event_kind IN ('usage','session') AND event_at>=? AND event_kind='usage'
        AND json_extract(event_json,'$.parentId') IS NULL
        AND json_extract(event_json,'$.data.limits') IS NOT NULL
      ORDER BY event_at DESC LIMIT ?
    `)
    const rows = sessions.flatMap(session => newest.all(session.id, from, perConversation) as Array<{ observedAt: string; limits: string }>)
    return rows.sort((a, b) => b.observedAt.localeCompare(a.observedAt)).flatMap(row => {
      try { return [{ observedAt: row.observedAt, limits: JSON.parse(row.limits) as unknown }] } catch { return [] }
    })
  }
  history(projectId: string, query = ''): ConversationHistoryEntry[] {
    const ids = this.db.prepare(`
      SELECT sessions.id,sessions.provider,
        (SELECT event_json FROM structured_events WHERE session_id=sessions.id ORDER BY sequence DESC LIMIT 1) AS latest_event
      FROM structured_sessions AS sessions WHERE project_id=? ORDER BY sessions.rowid DESC
    `).all(projectId) as Array<{ id: string; provider: StructuredProvider; latest_event: string | null }>
    const needle = query.toLocaleLowerCase()
    // An untouched session (no items ever sent/received, never titled) is a bookkeeping row, not history.
    const entries: Array<ConversationHistoryEntry & { _rowIndex: number }> = ids.flatMap((row, rowIndex) => {
      const state = this.snapshot(row.id)
      if (!state || (!state.items.length && !state.title) || (needle && !JSON.stringify(state.items).toLocaleLowerCase().includes(needle) && !state.title.toLocaleLowerCase().includes(needle))) return []
      let latest: AgentEvent | undefined
      try { if (row.latest_event) latest = JSON.parse(row.latest_event) as AgentEvent } catch { /* malformed legacy event has no activity metadata */ }
      const message = [...state.items].reverse().find(item => item.data.type === 'text' && item.data.text.trim())
      const messageData = message?.data.type === 'text' ? message.data : undefined
      const text = messageData?.text.replace(/\s+/g, ' ').trim().slice(0, 180)
      return [{
        id: row.id, title: state.title || 'New conversation', provider: row.provider, archived: state.archived, phase: state.phase,
        ...(latest ? { updatedAt: latest.timestamp, updatedSequence: latest.sequence } : {}),
        ...(state.settings.model ? { model: state.settings.model } : {}),
        ...(text && messageData ? { snippet: text, lastRole: messageData.role } : {}),
        _rowIndex: rowIndex
      }]
    })
    return entries.sort((a, b) => {
      const time = (b.updatedAt ? Date.parse(b.updatedAt) : 0) - (a.updatedAt ? Date.parse(a.updatedAt) : 0)
      return time || (b.updatedSequence ?? 0) - (a.updatedSequence ?? 0) || a._rowIndex - b._rowIndex
    }).slice(0, 200).map(({ _rowIndex: _ignored, ...entry }) => entry)
  }
  /** Message find across a whole workspace. Projections are already resident, so this is a bounded
   *  in-memory scan; only snippets cross the IPC boundary, never another conversation's items. */
  searchMessages(projectId: string, query: string, excludeId = ''): ConversationSearchResult {
    const needle = query.trim().toLocaleLowerCase()
    if (needle.length < MIN_SEARCH_QUERY) return { groups: [], truncated: false }
    const rows = this.db.prepare('SELECT id, provider FROM structured_sessions WHERE project_id=? ORDER BY rowid DESC').all(projectId) as Array<{ id: string; provider: StructuredProvider }>
    const groups: ConversationSearchGroup[] = []
    let truncated = false
    for (const row of rows) {
      if (row.id === excludeId) continue
      const state = this.snapshot(row.id)
      if (!state) continue
      const group: ConversationSearchGroup = { sessionId: row.id, title: state.title || 'New conversation', provider: row.provider, archived: state.archived, messages: 0, hits: [] }
      for (const item of state.items) {
        const message = searchableMessage(item)
        if (!message) continue
        const haystack = message.text.toLocaleLowerCase()
        const index = haystack.indexOf(needle)
        if (index === -1) continue
        group.messages++
        if (group.hits.length >= MAX_SEARCH_HITS) continue
        let matches = 0
        for (let cursor = index; cursor !== -1; cursor = haystack.indexOf(needle, cursor + needle.length)) matches++
        group.hits.push({ itemId: item.id, sequence: item.sequence, role: message.role, ...messageSnippet(message.text, index, needle.length), matchLength: needle.length, matches })
      }
      if (!group.messages) continue
      if (groups.length >= MAX_SEARCH_GROUPS) { truncated = true; break }
      groups.push(group)
    }
    return { groups, truncated }
  }
  putArtifact(sessionId: string, value: Omit<DiffArtifact, 'id'>): DiffArtifact {
    const id = randomUUID()
    const artifact = { ...value, id }
    const filename = `${id}.json`
    // Immutable original bytes are private artifacts, never sanitized diagnostic strings.
    this.writeArtifact(filename, JSON.stringify(artifact))
    this.db.prepare('INSERT INTO structured_artifacts(id,session_id,kind,filename) VALUES(?,?,?,?)').run(id, sessionId, 'diff', filename)
    return artifact
  }
  putOutput(sessionId: string, output: string): string {
    const id = randomUUID(), filename = `${id}.txt`
    this.writeArtifact(filename, String(sanitizeDiagnostic(output)).slice(-8 * 1024 * 1024))
    this.db.prepare('INSERT INTO structured_artifacts(id,session_id,kind,filename) VALUES(?,?,?,?)').run(id, sessionId, 'output', filename)
    return id
  }
  artifact(sessionId: string, id: string): DiffArtifact { return JSON.parse(this.readArtifact(sessionId, id, 'diff')) as DiffArtifact }
  private writeArtifact(filename: string, data: string): void {
    const bytes = Buffer.byteLength(data)
    if (this.artifactBytes + bytes > 512 * 1024 * 1024) throw new Error('Private agent artifact storage reached its 512 MiB allowance; existing history was preserved')
    writeFileSync(join(this.artifactDirectory, filename), data, { flag: 'wx', mode: 0o600 })
    this.artifactBytes += bytes
  }
  output(sessionId: string, id: string): string { return this.readArtifact(sessionId, id, 'output') }
  private readArtifact(sessionId: string, id: string, kind: string): string {
    const row = this.db.prepare('SELECT filename FROM structured_artifacts WHERE id=? AND session_id=? AND kind=?').get(id, sessionId, kind) as { filename: string } | undefined
    if (!row || !/^[a-f0-9-]+\.(json|txt)$/.test(row.filename)) throw new Error('Artifact not found in this session')
    return readFileSync(join(this.artifactDirectory, row.filename), 'utf8')
  }
  reserveLive(suiteId: string, provider: StructuredProvider, providerLimit: number, totalLimit: number, prompt?: 'A' | 'B'): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const limits = liveCostLimits(provider)
      this.db.prepare('INSERT INTO live_suite_limits(suite_id,provider,provider_usd,suite_usd) VALUES(?,?,?,?) ON CONFLICT(suite_id,provider) DO UPDATE SET provider_usd=MIN(provider_usd,excluded.provider_usd),suite_usd=MIN(suite_usd,excluded.suite_usd)').run(suiteId, provider, limits.provider, limits.suite)
      const rows = this.db.prepare('SELECT provider,submissions,cost_usd FROM live_suite_budget WHERE suite_id=?').all(suiteId) as Array<{ provider: string; submissions: number; cost_usd: number }>
      const own = rows.find(row => row.provider === provider)
      const count = own?.submissions ?? 0
      let amendment = provider === 'codex' && Boolean(this.db.prepare('SELECT suite_id FROM live_suite_amendments WHERE suite_id=?').get(suiteId))
      if (liveReplacementAuthorization(suiteId, provider) && !amendment) {
        if (count !== 1 || prompt !== 'A') throw new Error('A replacement can only amend one already-reserved A; it cannot expand a fresh or completed suite')
        this.db.prepare('INSERT INTO live_suite_amendments(suite_id,provider,kind,prior_submissions,authorized_at) VALUES(?,?,?,?,?)').run(suiteId, provider, 'one-replacement-A', 1, new Date().toISOString())
        amendment = true
      }
      const expectedCount = amendment ? (prompt === 'A' ? 1 : 2) : (prompt === 'A' ? 0 : 1)
      if (prompt && count !== expectedCount) throw new Error('Live acceptance prompts may run only once, in A then B order; an authorized replacement A is also single-use')
      // Callers cannot enlarge defaults. The only expansion is the single durable owner amendment above.
      const effectiveProviderLimit = Math.min(providerLimit, 2) + (amendment ? 1 : 0)
      if (count >= effectiveProviderLimit || rows.reduce((sum, row) => sum + row.submissions, 0) >= Math.min(totalLimit, 4)) throw new Error('Live suite submission allowance exhausted')
      if (this.liveCostExceeded(suiteId, provider)) throw new Error('Live suite observed cost threshold reached')
      this.db.prepare('INSERT INTO live_suite_budget(suite_id,provider,submissions) VALUES(?,?,1) ON CONFLICT(suite_id,provider) DO UPDATE SET submissions=submissions+1').run(suiteId, provider)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  addLiveCost(suiteId: string, provider: StructuredProvider, cost: number): void {
    if (Number.isFinite(cost) && cost > 0) this.db.prepare('UPDATE live_suite_budget SET cost_usd=cost_usd+? WHERE suite_id=? AND provider=?').run(cost, suiteId, provider)
  }
  liveCostExceeded(suiteId: string, provider: StructuredProvider): boolean {
    const budgets = this.db.prepare('SELECT provider,cost_usd FROM live_suite_budget WHERE suite_id=?').all(suiteId) as Array<{ provider: string; cost_usd: number }>
    const limits = this.db.prepare('SELECT provider,provider_usd,suite_usd FROM live_suite_limits WHERE suite_id=?').all(suiteId) as Array<{ provider: string; provider_usd: number; suite_usd: number }>
    return (budgets.find(row => row.provider === provider)?.cost_usd ?? 0) >= (limits.find(row => row.provider === provider)?.provider_usd ?? .25) || budgets.reduce((sum, row) => sum + row.cost_usd, 0) >= Math.min(.50, ...limits.map(row => row.suite_usd))
  }
  flush(): void { for (const id of this.projections.keys()) this.checkpoint(id) }
}
