import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECKPOINT_INTERVAL_MS, JOURNAL_PAGE_DEFAULT, JOURNAL_PAGE_MAX, REDACTION_TARGETS, StructuredAgentStore, journalPageSize, maskSecrets, redactSecretsChunk, registerSecretCheck, sanitizeDiagnostic } from './structured-store'
import { anonymousConversations } from './local-models/anonymous'
import type { AgentEvent, AgentEventData } from '../shared/structured-agent'
import { emptyProjection } from '../shared/structured-agent-reducer'

const roots: string[] = [], databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) { try { db.close() } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); vi.unstubAllEnvs() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'conductor-store-fixture-')); roots.push(root)
  const path = join(root, 'events.sqlite')
  const db = new DatabaseSync(path); databases.push(db)
  db.exec('CREATE TABLE agent_sessions(id TEXT PRIMARY KEY); INSERT INTO agent_sessions(id) VALUES(\'one\'),(\'two\')')
  const store = new StructuredAgentStore(db, root)
  store.register('one', 'project', 'claude', { cwd: 'synthetic' }); store.register('two', 'project', 'codex', {})
  return { root, path, db, store }
}
const event = (sequence: number, data: AgentEventData, overrides: Partial<AgentEvent> = {}): AgentEvent => ({ schemaVersion: 1, id: `event-${sequence}`, sequence, sessionId: 'one', runtimeId: 'runtime', provider: 'claude', projectId: 'project', workspaceId: 'workspace', cwd: 'fixture', timestamp: '2026-09-07T00:00:00.000Z', data, ...overrides })

describe('structured SQLite journal and immutable artifacts', () => {
  it('restores an unanswered async Codex card while expiring a blocking approval', () => {
    const f = fixture()
    const question = { id: 'codex-async:thread:item', kind: 'question' as const, title: 'Codex asked you',
      input: { protocol: 'codex-async-question', threadId: 'thread', itemId: 'item' }, choices: [], status: 'pending' as const,
      questions: [{ id: 'item:0', question: 'Choose', options: [{ label: 'A' }] }] }
    f.store.append(event(1, { type: 'session', phase: 'running', nativeSessionId: 'thread' }, { sessionId: 'two', provider: 'codex' }))
    f.store.append(event(2, { type: 'interaction', interaction: question }, { sessionId: 'two', provider: 'codex', requestId: question.id }))
    f.store.checkpoint('two')
    f.db.close()
    const reopened = new DatabaseSync(f.path); databases.push(reopened)
    const restored = new StructuredAgentStore(reopened, f.root).snapshot('two')!
    expect(restored.phase).toBe('disconnected')
    expect(restored.items.find(item => item.data.type === 'interaction')?.data).toMatchObject({ interaction: { status: 'pending' } })
  })
  // A streaming turn used to rewrite its whole projection snapshot (1-7 MB for the owner's long
  // tabs) after every burst, on main, while the owner typed (typing-lag-long-conversation).
  it('snapshots a streaming conversation at most once a second, at once when its phase moves, and loses nothing', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    try {
      const f = fixture()
      const stored = (): number => JSON.parse((f.db.prepare('SELECT projection_json FROM structured_sessions WHERE id=?').get('one') as { projection_json: string }).projection_json).sequence
      f.store.append(event(1, { type: 'session', phase: 'running' }))
      f.store.checkpointSoon('one')
      expect(stored()).toBe(1)
      for (let sequence = 2; sequence <= 20; sequence++) { f.store.append(event(sequence, { type: 'text', role: 'assistant', text: 'streamed ' + sequence, mode: 'snapshot' })); f.store.checkpointSoon('one') }
      expect(stored()).toBe(1)
      // Whatever the snapshot lacks is in the journal: a restore right now still has every event.
      const reader = new DatabaseSync(f.path); databases.push(reader)
      expect(new StructuredAgentStore(reader, f.root).snapshot('one')?.sequence).toBe(20)
      vi.advanceTimersByTime(CHECKPOINT_INTERVAL_MS)
      expect(stored()).toBe(20)
      f.store.append(event(21, { type: 'text', role: 'assistant', text: 'more', mode: 'snapshot' })); f.store.checkpointSoon('one')
      expect(stored()).toBe(20)
      f.store.append(event(22, { type: 'session', phase: 'completed' })); f.store.checkpointSoon('one')
      expect(stored()).toBe(22)
      f.store.append(event(23, { type: 'text', role: 'assistant', text: 'late', mode: 'snapshot' })); f.store.checkpointSoon('one')
      f.store.flush()
      expect(stored()).toBe(23)
    } finally { vi.useRealTimers() }
  })
  it('hydrates imported projections only after their database rows exist', () => {
    const { db, store } = fixture()
    const projection = { ...emptyProjection('imported'), title: 'Imported history', phase: 'disconnected' as const, nativeSessionId: 'native-imported' }
    db.prepare("INSERT INTO agent_sessions(id) VALUES('imported')").run()
    db.prepare('INSERT INTO structured_sessions(id,project_id,provider,spec_json,projection_json,title,archived) VALUES(?,?,?,?,?,?,0)')
      .run('imported', 'project', 'codex', JSON.stringify({ id: 'imported' }), JSON.stringify(projection), projection.title)
    // A row written beside the store is read on demand; loadImported makes it resident up front.
    expect(store.residentStats().count).toBe(2)
    store.loadImported(['missing', 'imported'])
    expect(store.residentStats().count).toBe(3)
    expect(store.snapshot('imported')).toEqual(projection)
  })
  it('restores uncheckpointed events without resending work and marks lost runtime state disconnected', () => {
    const f = fixture()
    f.store.append(event(1, { type: 'text', role: 'user', text: 'Synthetic first prompt', mode: 'snapshot' }))
    f.store.checkpoint('one')
    f.store.append(event(2, { type: 'session', phase: 'running', nativeSessionId: 'native' }))
    f.store.append(event(3, { type: 'tool', name: 'Bash', status: 'running' }, { itemId: 'tool' }))
    f.store.append(event(4, { type: 'interaction', interaction: { id: 'approval', kind: 'approval', title: 'Allow?', input: {}, choices: [], status: 'pending' } }, { requestId: 'approval' }))
    f.db.close()
    const reopened = new DatabaseSync(f.path); databases.push(reopened)
    const restored = new StructuredAgentStore(reopened, f.root)
    expect(restored.snapshot('one')).toMatchObject({ phase: 'disconnected', nativeSessionId: 'native', sequence: 4, title: 'Synthetic first prompt' })
    expect(restored.snapshot('one')?.items.find((item) => item.data.type === 'interaction')?.data).toMatchObject({ interaction: { status: 'expired' } })
    expect(restored.snapshot('one')?.items.find((item) => item.data.type === 'tool')?.data).toMatchObject({ status: 'interrupted' })
    expect(restored.events('one')).toHaveLength(4)
  })
  it('rejects non-contiguous events and isolates each session journal', () => {
    const { store } = fixture()
    expect(() => store.append(event(2, { type: 'notice', message: 'gap' }))).toThrow('Non-contiguous')
    store.append(event(1, { type: 'notice', message: 'one' }))
    expect(() => store.append(event(1, { type: 'notice', message: 'duplicate' }))).toThrow('Non-contiguous')
    store.append(event(1, { type: 'notice', message: 'two' }, { sessionId: 'two', provider: 'codex' }))
    expect(store.events('one').map((entry) => entry.data)).toEqual([{ type: 'notice', message: 'one' }])
    expect(store.events('two').map((entry) => entry.data)).toEqual([{ type: 'notice', message: 'two' }])
  })
  it('reads the dedicated usage journal without the history or event page caps and omits transcript text', () => {
    const { store } = fixture()
    store.append(event(1, { type: 'text', role: 'user', text: 'do not scan me', mode: 'snapshot' }))
    store.append(event(2, { type: 'session', phase: 'running', settings: { permission: 'default', plan: false, model: 'claude-sonnet' } }))
    store.append(event(3, { type: 'usage', scope: 'turn', source: 'provider', inputTokens: 10, outputTokens: 2 }, { turnId: 'turn' }))
    expect(store.usageJournal()).toEqual([expect.objectContaining({
      sessionId: 'one', provider: 'claude',
      truncated: false,
      runtimeStarts: { runtime: '2026-09-07T00:00:00.000Z' },
      events: [expect.objectContaining({ sequence: 2, data: expect.objectContaining({ type: 'session' }) }), expect.objectContaining({ sequence: 3, data: expect.objectContaining({ type: 'usage' }) })]
    })])
  })
  it('marks usage coverage truncated from the true earliest durable event rather than the first filtered event', () => {
    const { store, db } = fixture()
    store.append(event(1, { type: 'text', role: 'user', text: 'first', mode: 'snapshot' }))
    store.append(event(2, { type: 'usage', scope: 'session', source: 'provider', totalTokens: 50 }))
    expect(store.usageJournal()[0]?.truncated).toBe(false)
    db.prepare('DELETE FROM structured_events WHERE session_id=? AND sequence=?').run('one', 1)
    expect(store.usageJournal()[0]?.truncated).toBe(true)
  })
  it('bounds the journal to the window without dragging the whole transcript through the main process', () => {
    const { store, db } = fixture()
    const at = (day: number): string => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`
    store.append(event(1, { type: 'session', phase: 'running', settings: { permission: 'default', plan: false, model: 'claude-old' } }, { timestamp: at(1) }))
    store.append(event(2, { type: 'usage', scope: 'session', source: 'provider', totalTokens: 100 }, { timestamp: at(2) }))
    store.append(event(3, { type: 'usage', scope: 'turn', source: 'provider', totalTokens: 7 }, { timestamp: at(3), turnId: 'stale-turn' }))
    store.append(event(4, { type: 'usage', scope: 'session', source: 'provider', totalTokens: 400 }, { timestamp: at(9) }))
    const window = store.usageJournal(at(1), at(8))[0]!
    // Inside the lookback: the cumulative baseline and the carried model survive. The superseded
    // turn report from before the window - the bulk of any real journal - is never read.
    expect(window.events.map(entry => entry.sequence)).toEqual([1, 2, 4])
    expect(window.events[0]?.data).toEqual({ type: 'session', phase: 'running', settings: { model: 'claude-old' } })
    expect(store.usageJournal(at(6), at(8))[0]?.events.map(entry => entry.sequence)).toEqual([4])
    // Every scanned row is a projection, so no message or tool body is in what crosses the boundary.
    store.append(event(5, { type: 'text', role: 'user', text: 'do not scan me', mode: 'snapshot' }, { timestamp: at(9) }))
    expect(JSON.stringify(store.usageJournal(at(1), at(1)))).not.toContain('do not scan me')
    expect((db.prepare("SELECT COUNT(*) AS rows FROM structured_events WHERE event_kind='usage'").get() as { rows: number }).rows).toBe(3)
  })
  it('keeps a runtime that predates the window distinguishable from one that started inside it', () => {
    const { store } = fixture()
    const at = (day: number): string => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`
    store.append(event(1, { type: 'notice', message: 'runtime up' }, { timestamp: at(2), runtimeId: 'old' }))
    store.append(event(2, { type: 'usage', scope: 'session', source: 'provider', totalTokens: 10 }, { timestamp: at(9), runtimeId: 'old' }))
    store.append(event(1, { type: 'usage', scope: 'session', source: 'provider', totalTokens: 10 }, { timestamp: at(9), runtimeId: 'new', sessionId: 'two', provider: 'codex' }))
    // The old runtime's only in-window row is a usage report, yet its start is still the notice
    // that opened it - that is what stops a lifetime counter being read as seven days of traffic.
    expect(store.usageJournal(at(8), at(8))[0]?.runtimeStarts).toEqual({ old: at(2) })
    expect(store.usageJournal(at(8), at(8))[1]?.runtimeStarts).toEqual({ new: at(9) })
  })
  it('reads only the newest reported allowance windows for the provider that asked', () => {
    const { store } = fixture()
    const limits = (usedPercent: number) => ({ rateLimits: { primary: { usedPercent, windowDurationMins: 10_080 } } })
    store.append(event(1, { type: 'usage', source: 'provider', limits: limits(10) }, { timestamp: '2026-09-08T00:00:00.000Z' }))
    store.append(event(2, { type: 'usage', source: 'provider', limits: limits(60) }, { timestamp: '2026-09-09T00:00:00.000Z' }))
    store.append(event(3, { type: 'usage', source: 'provider', limits: limits(99) }, { timestamp: '2026-09-09T12:00:00.000Z', parentId: 'nested' }))
    store.append(event(1, { type: 'usage', source: 'provider', limits: limits(5) }, { timestamp: '2026-09-09T06:00:00.000Z', sessionId: 'two', provider: 'codex' }))
    expect(store.recentUsageLimits('claude', '2026-09-01T00:00:00.000Z')).toEqual([
      { observedAt: '2026-09-09T00:00:00.000Z', limits: limits(60) },
      { observedAt: '2026-09-08T00:00:00.000Z', limits: limits(10) }
    ])
    expect(store.recentUsageLimits('codex', '2026-09-01T00:00:00.000Z')).toEqual([{ observedAt: '2026-09-09T06:00:00.000Z', limits: limits(5) }])
    expect(store.recentUsageLimits('claude', '2026-09-09T00:00:00.000Z', 1)).toEqual([{ observedAt: '2026-09-09T00:00:00.000Z', limits: limits(60) }])
  })
  it('redacts diagnostics while preserving private immutable bytes and session authorization', () => {
    const { store } = fixture()
    const secret = 'sk-ant-' + 'SYNTHETIC'.repeat(4)
    const safe = store.append(event(1, { type: 'notice', message: `Bearer ${secret}`, payload: { environment: { PRIVATE: secret }, authorization: secret } }))
    expect(JSON.stringify(safe)).not.toContain(secret)
    const artifact = store.putArtifact('one', { sessionId: 'one', path: 'file.txt', before: secret, after: 'new', patch: 'synthetic patch', additions: 1, deletions: 1, canUndo: true })
    expect(store.artifact('one', artifact.id).before).toBe(secret)
    expect(() => store.artifact('two', artifact.id)).toThrow('not found in this session')
    expect(() => store.artifact('one', '../file')).toThrow('not found')
    const outputId = store.putOutput('one', `Bearer ${secret}`)
    expect(store.output('one', outputId)).toBe('Bearer [REDACTED]')
    expect(store.artifact('one', artifact.id)).toEqual(artifact)
    expect(sanitizeDiagnostic({ password: 'synthetic', note: 'safe' })).toEqual({ password: '[REDACTED]', note: 'safe' })
  })
  it('hides an untouched registered session from history yet keeps it resumable via snapshot until it is actually used', () => {
    const { store } = fixture()
    expect(store.snapshot('one')).toMatchObject({ items: [], title: '' })
    expect(store.history('project')).toEqual([])
    store.append(event(1, { type: 'text', role: 'user', text: 'First real message', mode: 'snapshot' }))
    expect(store.history('project')).toEqual([{ id: 'one', title: 'First real message', provider: 'claude', archived: false, phase: 'idle', updatedAt: '2026-09-07T00:00:00.000Z', updatedSequence: 1, snippet: 'First real message', lastRole: 'user' }])
    expect(store.history('project').some((item) => item.id === 'two')).toBe(false)
  })
  it('surfaces an untouched session once it is only titled, without requiring timeline items', () => {
    const { store } = fixture()
    store.update('two', { title: 'Renamed before sending' })
    expect(store.history('project')).toEqual([{ id: 'two', title: 'Renamed before sending', provider: 'codex', archived: false, phase: 'idle' }])
    expect(store.snapshot('one')).toMatchObject({ items: [], title: '' })
    expect(store.history('project').some((item) => item.id === 'one')).toBe(false)
  })
  it('persists rename/archive/search independently of a process or pane', () => {
    const f = fixture()
    f.store.append(event(1, { type: 'text', role: 'assistant', text: 'Find searchable Unicode: 日本語', mode: 'snapshot' }))
    f.store.update('one', { title: 'Renamed', archived: true, settings: { permission: 'accept-edits', plan: false } })
    expect(f.store.history('project', '日本語')).toEqual([{ id: 'one', title: 'Renamed', archived: true, provider: 'claude', phase: 'idle', updatedAt: '2026-09-07T00:00:00.000Z', updatedSequence: 1, snippet: 'Find searchable Unicode: 日本語', lastRole: 'assistant' }])
    expect(f.store.history('another-project')).toEqual([])
    f.db.close()
    const reopened = new DatabaseSync(f.path); databases.push(reopened)
    const store = new StructuredAgentStore(reopened, f.root)
    expect(store.snapshot('one')).toMatchObject({ title: 'Renamed', archived: true, settings: { permission: 'accept-edits' } })
  })
  it('reserves suite allowance durably before dispatch and does not reset it on reopen', () => {
    const f = fixture()
    f.store.reserveLive('suite', 'claude', 2, 4); f.store.reserveLive('suite', 'claude', 2, 4)
    expect(() => f.store.reserveLive('suite', 'claude', 2, 4)).toThrow('allowance exhausted')
    f.db.close()
    const reopened = new DatabaseSync(f.path); databases.push(reopened)
    const store = new StructuredAgentStore(reopened, f.root)
    expect(() => store.reserveLive('suite', 'claude', 2, 4)).toThrow('allowance exhausted')
    store.reserveLive('suite', 'codex', 2, 4)
    store.addLiveCost('suite', 'codex', 0.25)
    expect(() => store.reserveLive('suite', 'codex', 2, 4)).toThrow('cost threshold')
  })

  it('retains stricter provider and total cost thresholds after database restart and removed environment settings', () => {
    vi.stubEnv('CONDUCTOR_LIVE_MAX_USD_CLAUDE', '0.05')
    vi.stubEnv('CONDUCTOR_LIVE_MAX_USD_TOTAL', '0.08')
    const f = fixture()
    f.store.reserveLive('strict-suite', 'claude', 2, 4, 'A')
    f.store.addLiveCost('strict-suite', 'claude', 0.05)
    f.db.close()
    vi.unstubAllEnvs()
    const reopened = new DatabaseSync(f.path); databases.push(reopened)
    const store = new StructuredAgentStore(reopened, f.root)
    expect(store.liveCostExceeded('strict-suite', 'claude')).toBe(true)
    expect(() => store.reserveLive('strict-suite', 'claude', 2, 4, 'B')).toThrow('cost threshold')
    store.reserveLive('strict-suite', 'codex', 2, 4, 'A')
    store.addLiveCost('strict-suite', 'codex', 0.031)
    expect(store.liveCostExceeded('strict-suite', 'codex')).toBe(true)
    expect(() => store.reserveLive('strict-suite', 'codex', 2, 4, 'B')).toThrow('cost threshold')
  })

  it('permits exactly one explicitly authorized replacement A in the original durable aggregate', () => {
    const f = fixture()
    f.store.reserveLive('original-suite', 'codex', 2, 4, 'A')
    expect(() => f.store.reserveLive('original-suite', 'codex', 99, 99, 'A')).toThrow('only once')
    vi.stubEnv('CONDUCTOR_LIVE_TESTS', '1')
    vi.stubEnv('CONDUCTOR_LIVE_REPLACEMENT_A_SUITE_ID', 'original-suite')
    f.store.reserveLive('original-suite', 'codex', 2, 4, 'A')
    const amendment = f.db.prepare('SELECT * FROM live_suite_amendments').get()
    expect(amendment).toMatchObject({ suite_id: 'original-suite', provider: 'codex', kind: 'one-replacement-A', prior_submissions: 1 })
    expect(f.db.prepare('SELECT submissions FROM live_suite_budget WHERE suite_id=? AND provider=?').get('original-suite', 'codex')).toMatchObject({ submissions: 2 })
    f.db.close()
    const reopened = new DatabaseSync(f.path); databases.push(reopened)
    const store = new StructuredAgentStore(reopened, f.root)
    expect(() => store.reserveLive('original-suite', 'codex', 99, 99, 'A')).toThrow('single-use')
    vi.unstubAllEnvs()
    store.reserveLive('original-suite', 'codex', 2, 4, 'B')
    expect(reopened.prepare('SELECT * FROM live_suite_amendments').all()).toEqual([amendment])
    expect(reopened.prepare('SELECT submissions FROM live_suite_budget WHERE suite_id=? AND provider=?').get('original-suite', 'codex')).toMatchObject({ submissions: 3 })
    expect(() => store.reserveLive('original-suite', 'codex', 99, 99)).toThrow('allowance exhausted')
    vi.stubEnv('CONDUCTOR_LIVE_TESTS', '1')
    vi.stubEnv('CONDUCTOR_LIVE_REPLACEMENT_A_SUITE_ID', 'original-suite')
    expect(() => store.reserveLive('original-suite', 'codex', 99, 99, 'A')).toThrow('single-use')
    vi.unstubAllEnvs()
    store.reserveLive('original-suite', 'claude', 2, 4, 'A')
    expect(() => store.reserveLive('original-suite', 'claude', 99, 99, 'B')).toThrow('allowance exhausted')
  })

  it('rejects replacement authorization for a new, mismatched, or completed suite without changing counters', () => {
    const { store, db } = fixture()
    vi.stubEnv('CONDUCTOR_LIVE_TESTS', '1')
    vi.stubEnv('CONDUCTOR_LIVE_REPLACEMENT_A_SUITE_ID', 'suite')
    expect(() => store.reserveLive('suite', 'codex', 2, 4, 'A')).toThrow('cannot expand a fresh or completed suite')
    expect(() => store.reserveLive('another-suite', 'codex', 2, 4, 'A')).toThrow('exactly')
    vi.unstubAllEnvs()
    store.reserveLive('suite', 'codex', 2, 4, 'A')
    store.reserveLive('suite', 'codex', 2, 4, 'B')
    vi.stubEnv('CONDUCTOR_LIVE_TESTS', '1')
    vi.stubEnv('CONDUCTOR_LIVE_REPLACEMENT_A_SUITE_ID', 'suite')
    expect(() => store.reserveLive('suite', 'codex', 2, 4, 'A')).toThrow('cannot expand a fresh or completed suite')
    expect(db.prepare('SELECT * FROM live_suite_amendments').all()).toEqual([])
    expect(db.prepare('SELECT submissions FROM live_suite_budget').all()).toEqual([{ submissions: 2 }])
  })

  it('does not relax an existing cost boundary when granting a replacement and rolls back the failed reservation', () => {
    const f = fixture()
    vi.stubEnv('CONDUCTOR_LIVE_MAX_USD_CODEX', '0.01')
    f.store.reserveLive('cost-suite', 'codex', 2, 4, 'A')
    f.store.addLiveCost('cost-suite', 'codex', .01)
    vi.unstubAllEnvs()
    f.db.close()
    const reopened = new DatabaseSync(f.path); databases.push(reopened)
    const store = new StructuredAgentStore(reopened, f.root)
    vi.stubEnv('CONDUCTOR_LIVE_TESTS', '1')
    vi.stubEnv('CONDUCTOR_LIVE_REPLACEMENT_A_SUITE_ID', 'cost-suite')
    expect(() => store.reserveLive('cost-suite', 'codex', 2, 4, 'A')).toThrow('cost threshold')
    expect(reopened.prepare('SELECT * FROM live_suite_amendments').all()).toEqual([])
    expect(reopened.prepare('SELECT submissions,cost_usd FROM live_suite_budget').get()).toMatchObject({ submissions: 1, cost_usd: .01 })
    expect(reopened.prepare('SELECT provider_usd,suite_usd FROM live_suite_limits').get()).toMatchObject({ provider_usd: .01, suite_usd: .50 })
  })
})


it('retains pending native input after a backend restart as uncertain, without replaying it', () => {
  const f = fixture()
  f.store.append(event(1, { type: 'session', phase: 'running', nativeSessionId: 'native' }))
  f.store.append(event(2, { type: 'steering', prompts: [{ id: 'input', text: 'Keep selected context', settings: { permission: 'default', plan: false }, attachments: [{ id: 'selection', kind: 'selection', name: 'Selection', content: 'Captured bytes' }], runtimeId: 'runtime', status: 'accepted' }] }))
  f.store.checkpoint('one'); f.db.close()
  const reopened = new DatabaseSync(f.path); databases.push(reopened)
  const restored = new StructuredAgentStore(reopened, f.root)
  expect(restored.snapshot('one')).toMatchObject({ phase: 'disconnected', pendingSteering: [{ id: 'input', status: 'uncertain', attachments: [{ content: 'Captured bytes' }] }] })
  expect(restored.snapshot('one')?.items).toEqual([])
  expect(restored.events('one')).toHaveLength(2)
})

describe('staged batches: persist is transactional, ordered, and crash-safe', () => {
  it('keeps a staged event off disk until persist runs, then writes a whole batch in one transaction, in order', () => {
    const { store } = fixture()
    const staged = [1, 2, 3].map(sequence => store.stage(event(sequence, { type: 'notice', message: `staged ${sequence}` })))
    // The in-memory projection is already current - a burst's later events can correlate against
    // it - even though nothing has reached disk yet.
    expect(store.snapshot('one')?.sequence).toBe(3)
    expect(store.events('one')).toHaveLength(0)
    store.persist(staged)
    expect(store.events('one').map(entry => entry.sequence)).toEqual([1, 2, 3])
    expect(store.events('one').map(entry => (entry.data as { message: string }).message)).toEqual(['staged 1', 'staged 2', 'staged 3'])
  })
  it('rolls back the whole batch when one of its rows cannot be written, never a partial commit', () => {
    const { store, db } = fixture()
    store.append(event(1, { type: 'notice', message: 'already durable' }))
    const staged = [store.stage(event(2, { type: 'notice', message: 'two' })), store.stage(event(3, { type: 'notice', message: 'three' }))]
    // Seed a row that collides with the batch's own second event, so persist's single transaction
    // has to fail partway through and roll back what it had already written in this same call.
    db.prepare('INSERT INTO structured_events(session_id,sequence,event_json) VALUES(?,?,?)').run('one', 3, JSON.stringify({ sequence: 3 }))
    expect(() => store.persist(staged)).toThrow()
    // Sequence 2 was valid on its own but never lands: the transaction that would have written it
    // aborted before COMMIT. Sequence 1 (committed earlier) and the seeded 3 are untouched.
    expect(store.events('one').map(entry => entry.sequence)).toEqual([1, 3])
  })
  it('a crash before the next persist loses only the still-pending batch, not what was already committed', () => {
    const f = fixture()
    f.store.append(event(1, { type: 'notice', message: 'committed before the crash' }))
    f.store.checkpoint('one')
    // Staged but never persisted or checkpointed - the in-flight batch a crash here would lose.
    f.store.stage(event(2, { type: 'notice', message: 'lost' }))
    f.db.close()
    const reopened = new DatabaseSync(f.path); databases.push(reopened)
    const restored = new StructuredAgentStore(reopened, f.root)
    expect(restored.snapshot('one')).toMatchObject({ sequence: 1 })
    expect(restored.events('one').map(entry => entry.sequence)).toEqual([1])
  })
})

describe('the control token is masked in every form it is stored in (H17)', () => {
  const token = 'c0ffee'.repeat(10) + 'beef'
  const hash = 'ab'.repeat(32)
  it('masks named, labelled and live tokens and leaves an ordinary hash alone', () => {
    expect(maskSecrets(`CONDUCTOR_CONTROL_TOKEN=${token} node probe.mjs`)).toBe('CONDUCTOR_CONTROL_TOKEN=[REDACTED] node probe.mjs')
    expect(maskSecrets(`$env:CONDUCTOR_CONTROL_TOKEN = "${token}"; node probe.mjs`)).toBe('$env:CONDUCTOR_CONTROL_TOKEN = "[REDACTED]"; node probe.mjs')
    expect(maskSecrets(`node -e "const call = { token: '${token}' }"`)).not.toContain(token)
    expect(maskSecrets(`sha256 ${hash}`)).toBe(`sha256 ${hash}`)
    expect(maskSecrets(`const t = '${token}'`)).toContain(token)
    const unregister = registerSecretCheck(candidate => candidate === token)
    try {
      expect(maskSecrets(`const t = '${token}'`)).toBe("const t = '[REDACTED]'")
      expect(maskSecrets(`sha256 ${hash}`)).toBe(`sha256 ${hash}`)
    } finally { unregister() }
    expect(maskSecrets(`const t = '${token}'`)).toContain(token)
  })

  it('rewrites rows stored before the mask in bounded chunks, after a dry run that changes nothing', () => {
    const f = fixture()
    const placeholder = 'PLACEHOLDER-SECRET'
    f.store.append(event(1, { type: 'text', role: 'assistant', text: `ran ${placeholder} node x.mjs`, mode: 'snapshot' }))
    f.store.append(event(2, { type: 'notice', message: 'kept', payload: { note: 'shape stays' } }))
    f.store.checkpoint('one')
    // Rows as an older build wrote them: the token in clear in the journal and the projection.
    f.db.prepare('UPDATE structured_events SET event_json=replace(event_json,?,?)').run(placeholder, `CONDUCTOR_CONTROL_TOKEN=${token}`)
    // A key the write-time sanitizer would redact outright: the rewrite must leave its value alone.
    f.db.prepare('UPDATE structured_events SET event_json=replace(event_json,?,?)').run('"note":', '"env":')
    f.db.prepare('UPDATE structured_sessions SET projection_json=replace(projection_json,?,?)').run(placeholder, `CONDUCTOR_CONTROL_TOKEN=${token}`)
    f.db.close()
    const db = new DatabaseSync(f.path); databases.push(db)
    const store = new StructuredAgentStore(db, f.root)
    // Until the walk has reached them, rows are masked as they are read back: the projection on
    // its way into memory (it is loaded when first used, not at launch) and the journal (agents.history raw).
    expect(JSON.stringify(store.snapshot('one'))).not.toContain(token)
    expect(JSON.stringify(store.snapshot('one'))).toContain('CONDUCTOR_CONTROL_TOKEN=[REDACTED]')
    expect(JSON.stringify(store.journalRange('one', 0, 100, 100))).not.toContain(token)
    expect(JSON.stringify(store.events('one'))).not.toContain(token)
    expect(JSON.stringify(store.journalRange('one', 0, 100, 100))).toContain('CONDUCTOR_CONTROL_TOKEN=[REDACTED]')
    const raw = (): string => (db.prepare('SELECT group_concat(event_json) AS body FROM structured_events').get() as { body: string }).body
    const before = raw()
    const dry = redactSecretsChunk(db, REDACTION_TARGETS[0], 0, false)
    expect(dry).toMatchObject({ scanned: 2, changed: 1, changedKeys: ['one'] })
    expect(raw()).toBe(before)
    let steps = 0
    while (store.redactSecretsStep()) steps++
    expect(steps).toBeGreaterThan(0)
    expect(raw()).not.toContain(token)
    expect(raw()).toContain('CONDUCTOR_CONTROL_TOKEN=[REDACTED]')
    expect(raw()).toContain('"env":"shape stays"')
    expect(JSON.stringify(store.snapshot('one'))).not.toContain(token)
    expect((db.prepare('SELECT projection_json FROM structured_sessions WHERE id=?').get('one') as { projection_json: string }).projection_json).not.toContain(token)
    expect(store.redactSecretsStep()).toBe(false)
    // Finished is durable: a reopened store neither repeats the walk nor masks events on read.
    expect(new StructuredAgentStore(db, f.root).redactSecretsStep()).toBe(false)
  })

  it('masks a command output on write, in every form the journal masks', () => {
    const f = fixture()
    const named = f.store.putOutput('one', `CONDUCTOR_CONTROL_TOKEN=${token} node probe.mjs\nAuthorization: Bearer ${token}`)
    expect(f.store.output('one', named)).not.toContain(token)
    const unregister = registerSecretCheck(candidate => candidate === token)
    try { expect(f.store.output('one', f.store.putOutput('one', `const t = '${token}'`))).toBe("const t = '[REDACTED]'") } finally { unregister() }
  })

  it('rewrites output artifacts stored before the mask once, in bounded steps, after the journal walk, and leaves diffs alone', () => {
    const f = fixture()
    const outputs = Array.from({ length: 23 }, (_, index) => f.store.putOutput('one', index % 7 === 0 ? `PLACEHOLDER ${index}` : `plain output ${index}`))
    const diff = f.store.putArtifact('one', { sessionId: 'one', path: 'probe.mjs', before: null, after: `const token = '${token}'`, patch: 'synthetic', additions: 1, deletions: 0, canUndo: true })
    // Files as an older build wrote them: the token in clear.
    const dir = join(f.root, 'agent-artifacts')
    const file = (id: string): string => join(dir, `${id}.txt`)
    for (const [index, id] of outputs.entries()) if (index % 7 === 0) writeFileSync(file(id), `$env:CONDUCTOR_CONTROL_TOKEN = "${token}"; node probe.mjs ${index}`)
    const plain = readFileSync(file(outputs[1]!), 'utf8')
    let steps = 0
    while (f.store.redactSecretsStep() || f.store.redactArtifactsStep()) steps++
    // 23 outputs at 10 a step, besides the journal phases.
    expect(steps).toBeGreaterThanOrEqual(3)
    for (const [index, id] of outputs.entries()) {
      if (index % 7) continue
      expect(f.store.output('one', id)).toBe(`$env:CONDUCTOR_CONTROL_TOKEN = "[REDACTED]"; node probe.mjs ${index}`)
    }
    expect(readFileSync(file(outputs[1]!), 'utf8')).toBe(plain)
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(f.store.artifact('one', diff.id).after).toContain(token)
    expect(JSON.parse((f.db.prepare('SELECT value FROM structured_meta WHERE key=?').get('secret_redaction_artifacts_v1') as { value: string }).value)).toMatchObject({ changed: 4, done: expect.any(String) })
    // Finished is durable: a reopened store does not walk the files again.
    writeFileSync(file(outputs[0]!), `CONDUCTOR_CONTROL_TOKEN=${token}`)
    const reopened = new StructuredAgentStore(f.db, f.root)
    expect(reopened.redactArtifactsStep()).toBe(false)
    expect(readFileSync(file(outputs[0]!), 'utf8')).toContain(token)
  })

  it('resumes the output pass where an earlier launch stopped', () => {
    const f = fixture()
    const ids = Array.from({ length: 15 }, (_, index) => f.store.putOutput('one', `output ${index}`)).sort()
    const dir = join(f.root, 'agent-artifacts')
    for (const id of ids) writeFileSync(join(dir, `${id}.txt`), `CONDUCTOR_CONTROL_TOKEN=${token}`)
    expect(f.store.redactArtifactsStep()).toBe(true)
    const done = ids.filter(id => !readFileSync(join(dir, `${id}.txt`), 'utf8').includes(token))
    expect(done).toEqual(ids.slice(0, 10))
    // The next launch lists the folder again and carries on after the last file done.
    const reopened = new StructuredAgentStore(f.db, f.root)
    expect(reopened.redactArtifactsStep()).toBe(false)
    for (const id of ids) expect(readFileSync(join(dir, `${id}.txt`), 'utf8')).toBe('CONDUCTOR_CONTROL_TOKEN=[REDACTED]')
  })
})

// 2026-10-22: the store parsed every stored projection at construction and kept them all; the
// owner's 1,666 conversations (1.27 GB of projection JSON) ran the main process out of its 4 GB
// heap four seconds into every launch, and nothing could start Conductor. Conversations are now
// loaded when first used and the idle ones are bounded.
describe('conversations are resident only while used', () => {
  const codex = (sequence: number, data: AgentEventData): AgentEvent => event(sequence, data, { sessionId: 'two', provider: 'codex' })
  it('opens without reading a single projection, lists a project from stored summaries, and loads a conversation the first time it is asked for', () => {
    const f = fixture()
    f.store.append(event(1, { type: 'text', role: 'user', text: 'First prompt', mode: 'snapshot' }))
    f.store.append(event(2, { type: 'session', phase: 'running', nativeSessionId: 'native' }))
    f.store.append(codex(1, { type: 'text', role: 'user', text: 'Second room', mode: 'snapshot' }))
    f.store.flush()
    f.db.close()
    const reopened = new DatabaseSync(f.path); databases.push(reopened)
    const store = new StructuredAgentStore(reopened, f.root)
    expect(store.residentStats()).toEqual({ count: 0, bytes: 0, live: 0 })
    // The stored phase of 'one' is still 'running'; nothing is running it, and the list says so.
    const listed = store.history('project').sort((a, b) => a.id.localeCompare(b.id))
    expect(listed.map(entry => [entry.id, entry.phase, entry.snippet, entry.lastRole, entry.updatedSequence])).toEqual([['one', 'disconnected', 'First prompt', 'user', 2], ['two', 'idle', 'Second room', 'user', 1]])
    expect(store.residentStats().count).toBe(0)
    expect(store.history('project', 'second').map(entry => entry.id)).toEqual(['two'])
    expect(store.peek('one')).toMatchObject({ phase: 'disconnected', sequence: 2, title: 'First prompt' })
    expect(store.residentStats().count).toBe(0)
    expect(store.resident('one')).toBeNull()
    expect(store.snapshot('one')).toMatchObject({ phase: 'disconnected', sequence: 2, title: 'First prompt' })
    expect(store.residentStats()).toMatchObject({ count: 1, live: 0 })
    expect(store.residentStats().bytes).toBeGreaterThan(100)
    expect(store.resident('one')).toMatchObject({ sequence: 2 })
  })
  it('drops the least recently used idle conversations past the budget, never a live one, and reloads them intact', () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-store-fixture-')); roots.push(root)
    const db = new DatabaseSync(join(root, 'events.sqlite')); databases.push(db)
    db.exec("CREATE TABLE agent_sessions(id TEXT PRIMARY KEY); INSERT INTO agent_sessions(id) VALUES('one'),('two'),('three')")
    const store = new StructuredAgentStore(db, root, { residentBudgetBytes: 1 })
    for (const id of ['one', 'two', 'three']) store.register(id, 'project', 'claude', { cwd: 'synthetic' })
    store.append(event(1, { type: 'session', phase: 'running', nativeSessionId: 'live' }))
    store.append(event(1, { type: 'text', role: 'user', text: 'Two says hello', mode: 'snapshot' }, { sessionId: 'two' }))
    store.append(event(1, { type: 'text', role: 'user', text: 'Three says hello', mode: 'snapshot' }, { sessionId: 'three' }))
    const two = store.snapshot('two')!, three = store.snapshot('three')!
    expect(store.residentStats()).toMatchObject({ count: 3, live: 1 })
    // Sizes are accounted at checkpoint. Only a load or the guard evicts; 'three' was touched last, so 'two' goes first.
    store.flush()
    expect(store.evictIdle(JSON.stringify(three).length)).toEqual(['two'])
    expect(store.evictIdle()).toEqual(['three'])
    expect(store.residentStats()).toMatchObject({ count: 1, live: 1 })
    expect(store.snapshot('one')).toMatchObject({ phase: 'running', nativeSessionId: 'live' })
    // A reload is this process's own snapshot: nothing is marked lost, and the turn continues.
    expect(store.snapshot('two')).toEqual(two)
    expect(store.residentStats().count).toBe(2)
    store.append(event(2, { type: 'text', role: 'assistant', text: 'Two is answered', mode: 'snapshot' }, { sessionId: 'two' }))
    expect(store.snapshot('two')).toMatchObject({ sequence: 2, phase: 'idle' })
    expect(store.events('two')).toHaveLength(2)
    expect(store.peek('three')).toEqual(three)
    // 'one' has neither items nor a title yet: a bookkeeping row, hidden from history as before.
    expect(store.history('project').map(entry => entry.id).sort()).toEqual(['three', 'two'])
  })
  it('summarises a row from before the summary column once, from its stored projection, and lists from the summary after', () => {
    const f = fixture()
    f.store.append(event(1, { type: 'text', role: 'user', text: 'Legacy row', mode: 'snapshot' }))
    f.store.flush()
    f.db.prepare('UPDATE structured_sessions SET summary_json=NULL').run()
    f.db.close()
    const reopened = new DatabaseSync(f.path); databases.push(reopened)
    const store = new StructuredAgentStore(reopened, f.root)
    expect(store.history('project')).toEqual([{ id: 'one', title: 'Legacy row', provider: 'claude', archived: false, phase: 'idle', updatedAt: '2026-09-07T00:00:00.000Z', updatedSequence: 1, snippet: 'Legacy row', lastRole: 'user' }])
    expect(JSON.parse((reopened.prepare("SELECT summary_json FROM structured_sessions WHERE id='one'").get() as { summary_json: string }).summary_json)).toEqual({ phase: 'idle', items: 1, snippet: 'Legacy row', lastRole: 'user' })
    expect(store.residentStats().count).toBe(0)
  })
  it('the memory guard drops every idle conversation once the heap nears its limit, and says so', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const f = fixture()
      f.store.append(event(1, { type: 'text', role: 'user', text: 'idle one', mode: 'snapshot' }))
      f.store.append(codex(1, { type: 'session', phase: 'running', nativeSessionId: 'busy' }))
      let used = 10
      const stop = f.store.startMemoryGuard(1000, 0.7, () => ({ used, limit: 100 }))
      vi.advanceTimersByTime(1000)
      expect(f.store.residentStats().count).toBe(2)
      used = 80
      vi.advanceTimersByTime(1000)
      expect(f.store.residentStats()).toMatchObject({ count: 1, live: 1 })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 1 idle resident conversations'))
      stop()
      expect(f.store.snapshot('one')).toMatchObject({ title: 'idle one', sequence: 1 })
    } finally { warn.mockRestore(); vi.useRealTimers() }
  })
  it('no query in the store reads the projection of more than one conversation', () => {
    const source = readFileSync(fileURLToPath(new URL('./structured-store.ts', import.meta.url)), 'utf8')
    const reads = source.split('\n').filter(line => /SELECT\b/.test(line) && /projection_json/.test(line) && /structured_sessions/.test(line))
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read).toMatch(/WHERE id=\?/)
  })
})

describe('caller-sized journal and archive pages, bounded in SQL', () => {
  const text = (sequence: number, sessionId = 'one'): AgentEvent => event(sequence, { type: 'text', role: sequence % 2 ? 'assistant' : 'user', text: `Message ${sequence}`, mode: 'snapshot' }, { sessionId, itemId: `item-${sequence}` })
  const seed = (store: StructuredAgentStore, db: DatabaseSync, count: number, sessionId = 'one'): void => {
    db.exec('BEGIN')
    for (let sequence = 1; sequence <= count; sequence++) store.append(text(sequence, sessionId))
    db.exec('COMMIT')
  }
  /** Rows each prepared statement handed to JavaScript, so a test can see the bound was SQL's. */
  const countRows = (db: DatabaseSync): Array<{ sql: string; rows: number }> => {
    const reads: Array<{ sql: string; rows: number }> = []
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      const statement = prepare(sql), all = statement.all.bind(statement)
      statement.all = ((...args: Parameters<typeof all>) => { const rows = all(...args); reads.push({ sql, rows: rows.length }); return rows }) as typeof statement.all
      return statement
    }) as typeof db.prepare
    return reads
  }
  /** A durable archive as `trimJournal` leaves it: rendered items plus its coverage row. */
  const archiveRows = (db: DatabaseSync, sequences: number[], through: number, from = 1, body = (sequence: number) => `Archived ${sequence}`): void => {
    db.exec('BEGIN')
    const insert = db.prepare('INSERT INTO structured_transcript_archive(session_id,sequence,item_json) VALUES(?,?,?)')
    for (const sequence of sequences) insert.run('one', sequence, JSON.stringify({ id: `archived-${sequence}`, sequence, data: { type: 'text', role: 'assistant', text: body(sequence), mode: 'snapshot' } }))
    db.prepare(`INSERT INTO structured_transcript_archive_state(session_id,archived_through,archived_from) VALUES('one',?,?)
      ON CONFLICT(session_id) DO UPDATE SET archived_through=excluded.archived_through`).run(through, from)
    db.exec('COMMIT')
  }

  it('pages a journal larger than a page in exact sequence order, with a durable cursor and no gap or repeat', () => {
    const f = fixture()
    seed(f.store, f.db, 1_234)
    const reads = countRows(f.db)
    const seen: number[] = []
    let cursor = 0, pages = 0
    for (;;) {
      const page = f.store.eventsPage('one', cursor, 100)
      pages++
      expect(page.events.length).toBeLessThanOrEqual(100)
      seen.push(...page.events.map(entry => entry.sequence))
      expect(page.nextAfter).toBe(page.events.at(-1)?.sequence ?? cursor)
      cursor = page.nextAfter
      if (!page.hasMore) break
    }
    expect(pages).toBe(13)
    expect(seen).toEqual(Array.from({ length: 1_234 }, (_, index) => index + 1))
    // Each page asked SQLite for at most limit+1 rows, never the 20,001 `events` reads.
    expect(reads.filter(read => read.sql.includes('structured_events')).every(read => read.rows <= 101)).toBe(true)
    // The cursor survives what happens between pages: new events continue after it, a trim below it is invisible.
    f.store.append(text(1_235))
    expect(f.store.eventsPage('one', cursor, 100)).toMatchObject({ events: [{ sequence: 1_235 }], nextAfter: 1_235, hasMore: false })
    f.db.prepare('DELETE FROM structured_events WHERE session_id=? AND sequence<?').run('one', 1_000)
    expect(f.store.eventsPage('one', 1_100, 3).events.map(entry => entry.sequence)).toEqual([1_101, 1_102, 1_103])
    // Past the end: nothing, and the cursor stays where it was.
    expect(f.store.eventsPage('one', 5_000, 10)).toEqual({ events: [], nextAfter: 5_000, hasMore: false })
    // Another conversation's rows never leak into the page.
    expect(f.store.eventsPage('two', 0, 10).events).toEqual([])
  })

  it('defaults a missing page size, caps an oversized one, and refuses an invalid size or cursor', () => {
    const f = fixture()
    seed(f.store, f.db, JOURNAL_PAGE_MAX + 2)
    const fallback = f.store.eventsPage('one')
    expect(fallback.events).toHaveLength(JOURNAL_PAGE_DEFAULT)
    expect(fallback).toMatchObject({ nextAfter: JOURNAL_PAGE_DEFAULT, hasMore: true })
    const capped = f.store.eventsPage('one', 0, 1_000_000)
    expect(capped.events).toHaveLength(JOURNAL_PAGE_MAX)
    expect(capped.hasMore).toBe(true)
    expect(f.store.eventsPage('one', capped.nextAfter, 1_000_000)).toMatchObject({ events: [{ sequence: JOURNAL_PAGE_MAX + 1 }, { sequence: JOURNAL_PAGE_MAX + 2 }], hasMore: false })
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '10', null]) {
      expect(() => f.store.eventsPage('one', 0, limit as number)).toThrow(RangeError)
      expect(() => f.store.archivePage('one', 0, limit as number)).toThrow(RangeError)
      expect(() => journalPageSize(limit)).toThrow(RangeError)
    }
    for (const after of [-1, 0.5, Number.NaN, '3']) {
      expect(() => f.store.eventsPage('one', after as number, 10)).toThrow(RangeError)
      expect(() => f.store.archivePage('one', after as number, 10)).toThrow(RangeError)
    }
    // journalRange keeps its callers' sizes uncapped but never lets a negative LIMIT read everything.
    expect(f.store.journalRange('one', 1, Number.MAX_SAFE_INTEGER, JOURNAL_PAGE_MAX + 2)).toHaveLength(JOURNAL_PAGE_MAX + 2)
    expect(() => f.store.journalRange('one', 1, 10, -1)).toThrow(RangeError)
    expect(() => f.store.journalRange('one', 1, 10, 0)).toThrow(RangeError)
    // The restore replay keeps its own default, untouched by the page reader's.
    expect(f.store.events('one')).toHaveLength(JOURNAL_PAGE_MAX + 2)
  })

  it('pages the durable archive in order, reads it bounded in SQL, and keeps one consistent archive across a checkpoint', () => {
    const f = fixture()
    const sequences = Array.from({ length: 2_500 }, (_, index) => (index + 1) * 3)
    archiveRows(f.db, sequences, 7_500, 1)
    const reads = countRows(f.db)
    const items: number[] = []
    let page = f.store.archivePage('one', 0, 1_000)!
    const through = page.through
    expect(page).toMatchObject({ from: 1, through: 7_500, hasMore: true })
    items.push(...page.items.map(item => item.sequence))
    // A checkpoint archives more between pages: a reader that passes `through` back never sees it.
    archiveRows(f.db, [7_503, 7_506], 7_510, 1)
    while (page.hasMore) {
      page = f.store.archivePage('one', page.nextAfter, 1_000, through)!
      items.push(...page.items.map(item => item.sequence))
    }
    expect(items).toEqual(sequences)
    expect(reads.filter(read => read.sql.includes('structured_transcript_archive ')).every(read => read.rows <= 1_001)).toBe(true)
    // A fresh read sees the new coverage, and `archive` is the concatenation of every page.
    const whole = f.store.archive('one')!
    expect(whole.from).toBe(1)
    expect(whole.items.map(item => item.sequence)).toEqual([...sequences, 7_503, 7_506])
    const direct = (f.db.prepare('SELECT item_json FROM structured_transcript_archive WHERE session_id=? ORDER BY sequence').all('one') as Array<{ item_json: string }>).map(row => JSON.parse(row.item_json))
    expect(whole.items).toEqual(direct)
    // No archive yet is null, the same as before.
    expect(f.store.archivePage('two')).toBeNull()
    expect(f.store.archive('two')).toBeNull()
  })

  it('masks journal and archive rows the one-off redaction has not reached yet, on every page', () => {
    const token = 'c0ffee'.repeat(10) + 'beef'
    const f = fixture()
    seed(f.store, f.db, 30)
    archiveRows(f.db, [1, 2, 3], 3, 1, sequence => `ran CONDUCTOR_CONTROL_TOKEN=${token} step ${sequence}`)
    f.db.prepare('UPDATE structured_events SET event_json=replace(event_json,?,?)').run('Message 2', `CONDUCTOR_CONTROL_TOKEN=${token} Message 2`)
    f.db.close()
    const db = new DatabaseSync(f.path); databases.push(db)
    const store = new StructuredAgentStore(db, f.root)
    let cursor = 0, journal = ''
    for (let page = store.eventsPage('one', 0, 7); ; page = store.eventsPage('one', cursor, 7)) { journal += JSON.stringify(page.events); cursor = page.nextAfter; if (!page.hasMore) break }
    expect(journal).not.toContain(token)
    expect(journal).toContain('CONDUCTOR_CONTROL_TOKEN=[REDACTED] Message 2')
    const archive = store.archivePage('one', 0, 2)!
    expect(JSON.stringify([archive.items, store.archivePage('one', archive.nextAfter, 2, archive.through)!.items])).not.toContain(token)
    expect(JSON.stringify(store.archive('one'))).toContain('CONDUCTOR_CONTROL_TOKEN=[REDACTED]')
  })

  it('reads nothing of an anonymous conversation', () => {
    const f = fixture()
    anonymousConversations.mark('ghost')
    try {
      f.store.register('ghost', 'project', 'local', {})
      f.store.append(text(1, 'ghost'))
      expect(f.store.eventsPage('ghost', 0, 10)).toEqual({ events: [], nextAfter: 0, hasMore: false })
      expect(f.store.archivePage('ghost', 0, 10)).toBeNull()
      expect(f.store.archive('ghost')).toBeNull()
      expect(f.store.journalRange('ghost', 0, 100, 10)).toEqual([])
    } finally { anonymousConversations.forget('ghost') }
  })
})
