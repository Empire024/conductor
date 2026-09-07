import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent, DiffArtifact, SessionProjection, StructuredProvider } from '../shared/structured-agent'
import { emptyProjection, projectAgentEvent } from '../shared/structured-agent-reducer'
import { liveCostLimits } from './live-test-policy'

export function sanitizeDiagnostic(value: unknown): unknown {
  if (typeof value === 'string') return value
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-(?:ant-)?[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
  if (Array.isArray(value)) return value.map(sanitizeDiagnostic)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(authorization|api_?key|access_?token|refresh_?token|password|secret|env|environment)$/i.test(key) ? '[REDACTED]' : sanitizeDiagnostic(item)]))
  return value
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
      CREATE TABLE IF NOT EXISTS structured_events (
        session_id TEXT NOT NULL REFERENCES structured_sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(session_id, sequence)
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
    `)
    // Historical projection is independent of reconnect. Never retry uncertain execution.
    const rows = db.prepare('SELECT id, projection_json FROM structured_sessions').all() as Array<{ id: string; projection_json: string }>
    for (const row of rows) {
      const state = JSON.parse(row.projection_json) as SessionProjection
      const events = this.events(row.id, state.sequence)
      let restored = events.reduce(projectAgentEvent, state)
      if (['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'].includes(restored.phase)) restored = { ...restored, phase: 'disconnected' }
      restored.items = restored.items.map(item => item.data.type === 'interaction' && item.data.interaction.status === 'pending' ? { ...item, data: { ...item.data, interaction: { ...item.data.interaction, status: 'expired' } } } : item)
      restored.items = restored.items.map(item => item.data.type === 'tool' && ['running', 'preparing', 'awaiting_approval'].includes(item.data.status) ? { ...item, data: { ...item.data, status: 'interrupted' } } : item)
      this.projections.set(row.id, restored)
    }
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
  rebindProject(projectId: string, cwd: string): void {
    for (const row of this.db.prepare('SELECT id,spec_json FROM structured_sessions WHERE project_id=?').all(projectId) as Array<{ id: string; spec_json: string }>) {
      const spec = JSON.parse(row.spec_json) as Record<string, unknown>
      this.db.prepare('UPDATE structured_sessions SET spec_json=? WHERE id=?').run(JSON.stringify({ ...spec, cwd }), row.id)
    }
  }
  snapshot(id: string): SessionProjection | null { return this.projections.get(id) ?? null }
  append(event: AgentEvent): AgentEvent {
    const state = this.snapshot(event.sessionId)
    if (!state || event.sequence !== state.sequence + 1) throw new Error('Non-contiguous provider event sequence')
    const safe = sanitizeDiagnostic(event) as AgentEvent
    this.db.prepare('INSERT INTO structured_events(session_id,sequence,event_json) VALUES(?,?,?)').run(event.sessionId, event.sequence, JSON.stringify(safe))
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
  history(projectId: string, query = ''): Array<{ id: string; title: string; provider: StructuredProvider; archived: boolean; phase: SessionProjection['phase'] }> {
    const ids = this.db.prepare('SELECT id, provider FROM structured_sessions WHERE project_id=? ORDER BY rowid DESC').all(projectId) as Array<{ id: string; provider: StructuredProvider }>
    const needle = query.toLocaleLowerCase()
    return ids.flatMap(row => { const state = this.snapshot(row.id); return state && (!needle || JSON.stringify(state.items).toLocaleLowerCase().includes(needle) || state.title.toLocaleLowerCase().includes(needle)) ? [{ id: row.id, title: state.title || 'New conversation', provider: row.provider, archived: state.archived, phase: state.phase }] : [] }).slice(0, 200)
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
      if (prompt && (own?.submissions ?? 0) !== (prompt === 'A' ? 0 : 1)) throw new Error('Live acceptance prompts may run only once, in A then B order')
      if ((own?.submissions ?? 0) >= providerLimit || rows.reduce((sum, row) => sum + row.submissions, 0) >= totalLimit) throw new Error('Live suite submission allowance exhausted')
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
