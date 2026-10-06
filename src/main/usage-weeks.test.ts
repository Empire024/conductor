import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StructuredAgentStore } from './structured-store'
import { UsageWeeksStore, READING_RETENTION_MS } from './usage-weeks-store'
import { UsageWeeksService } from './usage-weeks'
import type { AgentEvent, AgentEventData, Json } from '../shared/structured-agent'
import { describeAccountLimits, recordAccountLimits } from '../shared/usage-accounting'
import type { AllowanceReading } from '../shared/usage-weeks'

const H = 3_600_000, D = 24 * H, WEEK = 7 * D
const T0 = Date.parse('2026-09-07T09:00:00.000Z')
const roots: string[] = [], databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) { try { db.close() } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'conductor-usage-weeks-')); roots.push(root)
  const db = new DatabaseSync(join(root, 'events.sqlite')); databases.push(db)
  db.exec("CREATE TABLE agent_sessions(id TEXT PRIMARY KEY); INSERT INTO agent_sessions(id) VALUES('claude-a'),('claude-b'),('codex-a')")
  const store = new StructuredAgentStore(db, root)
  store.register('claude-a', 'project', 'claude', { model: 'opus' }); store.register('claude-b', 'project', 'claude', { model: 'fable' }); store.register('codex-a', 'project', 'codex', { model: 'gpt-6.1-sol' })
  const sequences = new Map<string, number>()
  const append = (sessionId: string, at: number, data: AgentEventData, extra: Partial<AgentEvent> = {}): void => {
    const sequence = (sequences.get(sessionId) ?? 0) + 1; sequences.set(sessionId, sequence)
    const provider = sessionId.startsWith('codex') ? 'codex' : 'claude'
    store.append({ schemaVersion: 1, id: `${sessionId}-${sequence}`, sequence, sessionId, runtimeId: `run-${sessionId}`, provider, projectId: 'project', workspaceId: 'w', cwd: 'fixture', timestamp: new Date(at).toISOString(), data, ...extra })
  }
  return { db, store, append }
}
const claudeLimits = (percent: number, reset: number, fable?: number): Json => ({ rateLimits: {
  seven_day: { usedPercent: percent, windowDurationMins: 10_080, resetsAt: reset / 1000 },
  ...(fable !== undefined ? { seven_day_overage_included: { usedPercent: fable, windowDurationMins: 10_080, resetsAt: reset / 1000, scope: 'model', modelSelectors: ['fable'], label: 'Fable weekly' } } : {})
} })
const codexLimits = (percent: number, reset: number): Json => ({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: percent, windowDurationMins: 10_080, resetsAt: Math.round(reset / 1000) } } } })
const limitsEvent = (limits: Json): AgentEventData => ({ type: 'usage', source: 'provider', limits })
const turn = (input: number, output: number): AgentEventData => ({ type: 'usage', scope: 'turn', source: 'provider', inputTokens: input, outputTokens: output, totalTokens: input + output })
const cost = (usd: number): AgentEventData => ({ type: 'usage', scope: 'turn', source: 'estimate', costUsd: usd })

describe('weekly allowance store', () => {
  it('writes a reading only when a weekly window moved, or after an hour of the same figure, and prunes old readings', () => {
    const db = new DatabaseSync(':memory:'); databases.push(db)
    const store = new UsageWeeksStore(db)
    const report = (at: number, percent: number) => {
      const record = recordAccountLimits({}, 'claude', claudeLimits(percent, T0 + WEEK), { observedAt: new Date(at).toISOString(), agentSessionId: 'a', projectId: 'p' })!
      return describeAccountLimits(record, 'claude', at)
    }
    expect(store.record(report(T0 + H, 10), T0 + H)).toBe(1)
    expect(store.record(report(T0 + H + 60_000, 10), T0 + H)).toBe(0)
    expect(store.record(report(T0 + H + 120_000, 11), T0 + H)).toBe(1)
    expect(store.record(report(T0 + 3 * H, 11), T0 + 3 * H)).toBe(1)
    // A reading older than the newest one is not written (another tab reporting late).
    expect(store.record(report(T0 + 2 * H, 11), T0 + 3 * H)).toBe(0)
    expect(store.readings('claude').map(reading => reading.usedPercent)).toEqual([10, 11, 11])
    // A fresh store over the same table still knows the newest reading.
    expect(new UsageWeeksStore(db).record(report(T0 + 3 * H + 60_000, 11), T0 + 3 * H)).toBe(0)
    store.prune(T0 + 3 * H + 1 + READING_RETENTION_MS)
    expect(store.readings()).toEqual([])
  })

  it('backfills readings from the journal, totals tokens and cost per provider window, and keeps closed weeks', async () => {
    const f = fixture()
    const reset1 = T0 + WEEK, reset2 = T0 + 2 * WEEK
    // Claude week 1: climbs to 100% on day 5, Opus and Fable tokens with cost estimates.
    f.append('claude-a', T0 + D, limitsEvent(claudeLimits(20, reset1)))
    f.append('claude-a', T0 + D + 1000, turn(1000, 100))
    f.append('claude-a', T0 + D + 2000, cost(1.5), { itemId: 'usage:cost:t1' })
    f.append('claude-b', T0 + 2 * D, { type: 'session', phase: 'running', settings: { model: 'fable' } as never })
    f.append('claude-b', T0 + 2 * D + 1000, limitsEvent(claudeLimits(60, reset1, 30)))
    f.append('claude-b', T0 + 2 * D + 2000, turn(500, 50))
    f.append('claude-a', T0 + 5 * D, limitsEvent(claudeLimits(100, reset1)))
    f.append('claude-a', T0 + WEEK - H, limitsEvent(claudeLimits(100, reset1)))
    // Claude week 2: 25% so far.
    f.append('claude-a', T0 + WEEK + D, limitsEvent(claudeLimits(25, reset2)))
    f.append('claude-a', T0 + WEEK + D + 1000, turn(4000, 400))
    // Codex window of its own, by its own reset.
    const codexReset = T0 + 3 * D + WEEK
    f.append('codex-a', T0 + 3 * D, limitsEvent(codexLimits(5, codexReset)))
    f.append('codex-a', T0 + 3 * D + 1000, turn(700, 70))
    f.append('codex-a', T0 + 6 * D, limitsEvent(codexLimits(40, codexReset)))
    // Nested (subagent) allowance payloads are not read twice.
    f.append('claude-a', T0 + 5 * D + 10, limitsEvent(claudeLimits(1, reset1)), { parentId: 'tool-1' })

    const now = T0 + WEEK + 2 * D
    const journal = { usageSessionProviders: vi.fn(() => f.store.usageSessionProviders()), usageConversation: vi.fn(f.store.usageConversation.bind(f.store)), allowanceObservations: vi.fn(f.store.allowanceObservations.bind(f.store)) }
    const service = new UsageWeeksService(f.store.usageWeeks, journal, () => now)
    const report = await service.report({ weeks: 4 })

    const claude = report.weeks.filter(week => week.provider === 'claude' && week.bucket === 'seven_day')
    expect(claude.map(week => week.status)).toEqual(['current', 'closed'])
    expect(claude[1]).toMatchObject({ usedUp: true, usedUpAt: new Date(T0 + 5 * D).toISOString(), unusedPercent: 0, coverage: 'complete', peakPercent: 100 })
    expect(claude[1]!.tokens).toMatchObject({ processedTokens: 1650, costUsd: 1.5, costEstimated: true })
    expect(claude[1]!.tokens!.models.map(model => model.model).sort()).toEqual(['fable', 'opus'])
    expect(claude[0]).toMatchObject({ finalPercent: 25, tokens: { processedTokens: 4400, costUsd: null } })
    // The model-scoped Fable bucket counts only the Fable conversation's tokens.
    const fableWeeks = report.weeks.filter(week => week.bucket === 'seven_day_overage_included')
    // No Fable reading since its reset two days ago: that window is said to be unknown.
    expect(fableWeeks.map(week => week.status)).toEqual(['no-data', 'closed'])
    const fable = fableWeeks[1]!
    expect(fable).toMatchObject({ scope: 'model', label: 'Fable weekly', finalPercent: 30 })
    expect(fable.tokens!.models.map(model => model.model)).toEqual(['fable'])
    const codex = report.weeks.filter(week => week.provider === 'codex')
    expect(codex).toHaveLength(1)
    expect(codex[0]).toMatchObject({ status: 'current', startsAt: new Date(T0 + 3 * D).toISOString(), finalPercent: 40, tokens: { processedTokens: 770 } })
    expect(report.unknown).toEqual([expect.stringMatching(/^Grok does not report/)])
    expect(report.recordedSince).toBe(new Date(T0 + D).toISOString())

    // The closed week is kept with its tokens, so the next report does not measure it again.
    expect(f.store.usageWeeks.closedWeek('claude', 'seven_day', new Date(reset1).toISOString())?.tokens?.processedTokens).toBe(1650)
    const reads = journal.usageConversation.mock.calls.length
    await service.report({ weeks: 4 })
    // Only the current windows (cached for five minutes) and nothing closed was re-read.
    expect(journal.usageConversation.mock.calls.length).toBe(reads)
    expect(journal.allowanceObservations.mock.calls.length).toBe(3)
    // Backfill ran once per database: a new service over the same store does not replay the journal.
    await new UsageWeeksService(f.store.usageWeeks, journal, () => now).report({ provider: 'codex' })
    expect(journal.allowanceObservations.mock.calls.length).toBe(3)
  })

  it('reads allowance payloads through the accounting index, never a journal scan', () => {
    const f = fixture()
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN SELECT event_at AS at, json_extract(event_json,'$.data.limits') AS limits FROM structured_events
      WHERE session_id=? AND event_kind IN ('usage','session') AND event_at>=? AND event_kind='usage'
        AND json_extract(event_json,'$.data.source')='provider' AND json_extract(event_json,'$.parentId') IS NULL
        AND (json_extract(event_json,'$.data.limits.rateLimits') IS NOT NULL OR json_extract(event_json,'$.data.limits.rateLimitsByLimitId') IS NOT NULL)
      ORDER BY sequence`).all('claude-a', '2026-01-01') as Array<{ detail: string }>
    expect(plan.map(row => row.detail).join(' ')).toContain('structured_events_accounting')
  })

  it('says a week with no readings has none, and keeps a week whose readings were pruned', async () => {
    const db = new DatabaseSync(':memory:'); databases.push(db)
    const store = new UsageWeeksStore(db)
    const add = (at: number, percent: number, reset: number): void => { store.add({ provider: 'claude', bucket: 'seven_day', label: 'Weekly', scope: 'provider', at, usedPercent: percent, resetsAt: reset, windowMinutes: 10_080 } satisfies AllowanceReading) }
    add(T0 + D, 30, T0 + WEEK); add(T0 + WEEK - H, 70, T0 + WEEK)
    add(T0 + 2 * WEEK + D, 10, T0 + 3 * WEEK)
    const empty = { usageSessionProviders: () => [], usageConversation: () => null, allowanceObservations: () => [] }
    const now = T0 + 2 * WEEK + 2 * D
    const service = new UsageWeeksService(store, empty, () => now)
    const report = await service.report()
    expect(report.weeks.map(week => [week.status, week.coverage])).toEqual([['current', 'complete'], ['no-data', 'none'], ['closed', 'complete']])
    expect(report.weeks[2]).toMatchObject({ unusedPercent: 30, tokens: { processedTokens: 0, costUsd: null } })
    // Readings pruned: the closed week still comes back from usage_weeks.
    db.exec('DELETE FROM allowance_readings WHERE at < ' + (T0 + 2 * WEEK))
    const later = await new UsageWeeksService(store, empty, () => now + 1).report()
    expect(later.weeks.find(week => week.status === 'closed')).toMatchObject({ endsAt: new Date(T0 + WEEK).toISOString(), unusedPercent: 30 })
  })
})
