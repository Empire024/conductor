import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StructuredAgentStore } from './structured-store'
import { measureBurn, registerTokenBurnIpc, TokenBurnMeter, TokenBurnService } from './token-burn'
import { DEFAULT_TOKEN_BURN_ALERT_PER_HOUR, formatBurn, TOKEN_BURN_ALERT_SETTING } from '../shared/token-burn'
import type { AgentEvent, AgentEventData } from '../shared/structured-agent'

const roots: string[] = [], databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) { try { db.close() } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'conductor-burn-')); roots.push(root)
  const db = new DatabaseSync(join(root, 'events.sqlite')); databases.push(db)
  db.exec('CREATE TABLE agent_sessions(id TEXT PRIMARY KEY); INSERT INTO agent_sessions(id) VALUES(\'codex\'),(\'claude\')')
  const store = new StructuredAgentStore(db, root)
  store.register('codex', 'project', 'codex', {}); store.register('claude', 'project', 'claude', {})
  let sequence = 0
  const append = (sessionId: string, minutesAgo: number, data: AgentEventData, extra: Partial<AgentEvent> = {}): void => {
    store.append({ schemaVersion: 1, id: `e${++sequence}`, sequence, sessionId, runtimeId: 'runtime', provider: sessionId === 'codex' ? 'codex' : 'claude', projectId: 'project', workspaceId: 'workspace', cwd: 'fixture', timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(), data, ...extra })
  }
  return { db, store, append }
}
const NOW = Date.parse('2026-09-29T10:00:00.000Z')
const usage = (fields: Partial<Extract<AgentEventData, { type: 'usage' }>>): AgentEventData => ({ type: 'usage', source: 'provider', ...fields })

describe('per-tab token burn (codex-credit-burn 2)', () => {
  it('measures a cumulative Codex counter by its deltas inside the hour, against the last report before it', () => {
    const { store, append } = fixture()
    append('codex', 400, { type: 'text', role: 'user', text: 'start', mode: 'snapshot' })
    // Before the hour: the baseline only.
    append('codex', 90, usage({ scope: 'session', inputTokens: 10_000_000, cachedTokens: 9_000_000, outputTokens: 50_000 }))
    append('codex', 40, usage({ scope: 'session', inputTokens: 12_000_000, cachedTokens: 10_900_000, outputTokens: 60_000 }))
    append('codex', 5, usage({ scope: 'session', inputTokens: 13_500_000, cachedTokens: 12_300_000, outputTokens: 70_000 }))
    // A nested report never counts.
    append('codex', 4, usage({ scope: 'session', inputTokens: 99_000_000, outputTokens: 1 }), { parentId: 'task:1' })
    const measured = measureBurn(store.usageBurn('codex', new Date(NOW - 4 * 3_600_000).toISOString()), NOW)!
    expect(measured).toMatchObject({ inputPerHour: 3_500_000, cachedPerHour: 3_300_000, outputPerHour: 20_000, tokensPerHour: 3_520_000, reports: 2 })
  })

  it('counts each Claude message once, and nothing from before the hour', () => {
    const { store, append } = fixture()
    append('claude', 70, usage({ scope: 'message', inputTokens: 900_000, outputTokens: 900 }), { itemId: 'm0', turnId: 't0' })
    append('claude', 30, usage({ scope: 'message', inputTokens: 100_000, cachedTokens: 95_000, outputTokens: 100 }), { itemId: 'm1', turnId: 't1' })
    append('claude', 30, usage({ scope: 'message', inputTokens: 100_000, cachedTokens: 95_000, outputTokens: 400 }), { itemId: 'm1', turnId: 't1' })
    append('claude', 20, usage({ scope: 'message', inputTokens: 120_000, cachedTokens: 110_000, outputTokens: 600 }), { itemId: 'm2', turnId: 't1' })
    expect(measureBurn(store.usageBurn('claude', new Date(NOW - 4 * 3_600_000).toISOString()), NOW)).toMatchObject({ inputPerHour: 220_000, outputPerHour: 1000, tokensPerHour: 221_000 })
  })

  it('reads only the usage rows of the window through the accounting index', () => {
    const { db, store, append } = fixture()
    append('codex', 300, usage({ scope: 'session', inputTokens: 1 }))
    append('codex', 10, { type: 'session', phase: 'running', settings: { permission: 'default', plan: false, model: 'm' } })
    append('codex', 5, usage({ scope: 'session', inputTokens: 2 }))
    expect(store.usageBurn('codex', new Date(NOW - 60 * 60_000).toISOString())!.events.map(event => event.data.type)).toEqual(['usage'])
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT sequence FROM structured_events WHERE session_id=? AND event_kind IN ('usage','session') AND event_at>=? AND event_kind='usage' AND json_extract(event_json,'$.parentId') IS NULL ORDER BY sequence`).all('codex', '') as Array<{ detail: string }>
    expect(plan.map(row => row.detail).join(' ')).toContain('structured_events_accounting')
    expect(store.usageBurn('missing', '')).toBeNull()
  })

  it('alerts past the owner rate, caches reads, and lists live tabs highest first', () => {
    const settings = new Map<string, string>()
    let reads = 0
    const conversation = (id: string, tokens: number) => ({ sessionId: id, provider: 'codex' as const, runtimeStarts: { runtime: new Date(NOW - 7_200_000).toISOString() }, truncated: false, events: [
      { id: id + '1', sequence: 1, timestamp: new Date(NOW - 50 * 60_000).toISOString(), runtimeId: 'runtime', data: usage({ scope: 'session', inputTokens: 0, outputTokens: 0 }) },
      { id: id + '2', sequence: 2, timestamp: new Date(NOW - 5 * 60_000).toISOString(), runtimeId: 'runtime', data: usage({ scope: 'session', inputTokens: tokens, outputTokens: 0 }) }
    ] })
    const service = new TokenBurnService({ usageBurn: id => { reads++; return id === 'idle' ? null : conversation(id, id === 'relay' ? 7_000_000 : 400_000) } }, key => settings.get(key) ?? null, () => NOW)
    const live = [{ agentSessionId: 'worker', title: 'Worker', provider: 'codex' }, { agentSessionId: 'relay', title: 'P0 bridge', provider: 'codex' }, { agentSessionId: 'idle', title: 'Idle', provider: 'claude' }]
    const snapshot = service.snapshot(live)
    expect(snapshot.alertPerHour).toBe(DEFAULT_TOKEN_BURN_ALERT_PER_HOUR)
    expect(snapshot.rates.map(rate => [rate.agentSessionId, rate.tokensPerHour, rate.alert])).toEqual([['relay', 7_000_000, true], ['worker', 400_000, false]])
    service.snapshot(live)
    expect(reads).toBe(3)
    expect(service.rate('relay')).toMatchObject({ alert: true, alertPerHour: 5_000_000 })
    settings.set(TOKEN_BURN_ALERT_SETTING, '0')
    expect(service.snapshot(live).rates.some(rate => rate.alert)).toBe(false)
    settings.set(TOKEN_BURN_ALERT_SETTING, '1000000')
    expect(service.rate('worker')?.alert).toBe(false)
    expect(formatBurn(7_000_000)).toBe('7.0M/h')
    expect(formatBurn(12_400_000)).toBe('12M/h')
    expect(formatBurn(820_400)).toBe('820k/h')
  })

  it('broadcasts only when a rate or an alert moves, and validates the alert setting over IPC', async () => {
    const settings = new Map<string, string>(), published: unknown[] = []
    const tokens = 400_000
    const service = new TokenBurnService({ usageBurn: id => ({ sessionId: id, provider: 'codex', runtimeStarts: { runtime: new Date(NOW - 7_200_000).toISOString() }, truncated: false, events: [
      { id: 'a', sequence: 1, timestamp: new Date(NOW - 50 * 60_000).toISOString(), runtimeId: 'runtime', data: usage({ scope: 'session', inputTokens: 0, outputTokens: 0 }) },
      { id: 'b', sequence: 2, timestamp: new Date(NOW - 5 * 60_000).toISOString(), runtimeId: 'runtime', data: usage({ scope: 'session', inputTokens: tokens, outputTokens: 0 }) }
    ] }) }, key => settings.get(key) ?? null, () => NOW)
    const meter = new TokenBurnMeter({ service, live: () => [{ agentSessionId: 'w', title: 'W', provider: 'codex' }], setSetting: (key, value) => settings.set(key, value), publish: (_channel, payload) => published.push(payload) })
    meter.publish(); meter.publish()
    expect(published).toHaveLength(1)
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const trusted = vi.fn()
    registerTokenBurnIpc({ handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, handler) } } as never, () => meter, trusted)
    expect(() => handlers.get('token-burn:set-alert')!({}, 1234)).toThrow(/Choose one of/)
    expect(handlers.get('token-burn:set-alert')!({}, 0)).toBe(0)
    expect(settings.get(TOKEN_BURN_ALERT_SETTING)).toBe('0')
    expect(published).toHaveLength(2)
    expect(handlers.get('token-burn:alert')!({})).toBe(0)
    expect(trusted).toHaveBeenCalledTimes(3)
    expect((handlers.get('token-burn:snapshot')!({}) as { rates: unknown[] }).rates).toHaveLength(1)
    // Before the app has started the meter, a read says so rather than returning nothing.
    const early = new Map<string, (event: unknown) => unknown>()
    registerTokenBurnIpc({ handle: (channel: string, handler: (event: unknown) => unknown) => { early.set(channel, handler) } } as never, () => undefined, trusted)
    expect(() => early.get('token-burn:snapshot')!({})).toThrow(/still starting/)
  })
})
