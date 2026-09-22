import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StructuredAgentStore, sanitizeDiagnostic } from './structured-store'
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
  it('hydrates imported projections only after their database rows exist', () => {
    const { db, store } = fixture()
    const projection = { ...emptyProjection('imported'), title: 'Imported history', phase: 'disconnected' as const, nativeSessionId: 'native-imported' }
    db.prepare("INSERT INTO agent_sessions(id) VALUES('imported')").run()
    db.prepare('INSERT INTO structured_sessions(id,project_id,provider,spec_json,projection_json,title,archived) VALUES(?,?,?,?,?,?,0)')
      .run('imported', 'project', 'codex', JSON.stringify({ id: 'imported' }), JSON.stringify(projection), projection.title)
    expect(store.snapshot('imported')).toBeNull()
    store.loadImported(['missing', 'imported'])
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
