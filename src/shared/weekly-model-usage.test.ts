import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentEventData } from './structured-agent'
import { summarizeWeeklyModelUsage } from './weekly-model-usage'

const through = Date.parse('2026-09-22T00:00:00.000Z')
const event = (sequence: number, timestamp: string, data: AgentEventData, extra: Partial<AgentEvent> = {}): AgentEvent => ({
  schemaVersion: 1, id: `event-${sequence}`, sequence, sessionId: 'one', runtimeId: 'run-1', provider: 'codex', projectId: 'project', workspaceId: 'workspace', cwd: 'C:\\work', timestamp, data, ...extra
})

describe('weekly model usage', () => {
  it('subtracts durable cumulative baselines and groups the measured deltas by exact model', () => {
    const report = summarizeWeeklyModelUsage([{ sessionId: 'one', provider: 'codex', model: 'gpt-6-astra', events: [
      event(1, '2026-09-14T23:00:00.000Z', { type: 'usage', scope: 'session', source: 'provider', inputTokens: 80, outputTokens: 20, totalTokens: 100 }),
      event(2, '2026-09-16T00:00:00.000Z', { type: 'usage', scope: 'session', source: 'provider', inputTokens: 120, outputTokens: 40, totalTokens: 160 }),
      event(3, '2026-09-21T00:00:00.000Z', { type: 'usage', scope: 'session', source: 'provider', inputTokens: 150, outputTokens: 50, totalTokens: 200 })
    ] }], through)
    expect(report.models).toEqual([expect.objectContaining({ provider: 'codex', model: 'gpt-6-astra', inputTokens: 70, outputTokens: 30, totalTokens: 100, conversations: 1, reports: 2, estimated: false })])
    expect(report.coverage.countersWithoutBaseline).toBe(0)
  })

  it('excludes an old cumulative counter without a boundary baseline instead of calling it weekly', () => {
    const report = summarizeWeeklyModelUsage([{ sessionId: 'one', provider: 'codex', model: 'gpt-6-astra', events: [
      event(1, '2026-09-10T00:00:00.000Z', { type: 'text', role: 'user', text: 'old run', mode: 'snapshot' }),
      event(2, '2026-09-20T00:00:00.000Z', { type: 'usage', scope: 'session', source: 'provider', totalTokens: 50_000 })
    ] }], through)
    expect(report.models).toEqual([])
    expect(report.coverage.countersWithoutBaseline).toBe(1)
  })

  it('uses final turn totals over message snapshots, follows model changes, and excludes nested reports', () => {
    const report = summarizeWeeklyModelUsage([{ sessionId: 'one', provider: 'claude', model: 'sonnet', events: [
      event(1, '2026-09-20T00:00:00.000Z', { type: 'usage', scope: 'message', source: 'provider', inputTokens: 10, outputTokens: 2 }, { provider: 'claude', turnId: 'turn-a', itemId: 'message-a' }),
      event(2, '2026-09-20T00:01:00.000Z', { type: 'usage', scope: 'turn', source: 'provider', inputTokens: 15, outputTokens: 3 }, { provider: 'claude', turnId: 'turn-a', itemId: 'turn-a-total' }),
      event(3, '2026-09-20T00:02:00.000Z', { type: 'session', phase: 'running', settings: { permission: 'default', plan: false, model: 'fable' } }, { provider: 'claude' }),
      event(4, '2026-09-20T00:03:00.000Z', { type: 'usage', scope: 'turn', source: 'estimate', inputTokens: 7, outputTokens: 1 }, { provider: 'claude', turnId: 'turn-b' }),
      event(5, '2026-09-20T00:04:00.000Z', { type: 'usage', scope: 'turn', source: 'provider', totalTokens: 99 }, { provider: 'claude', turnId: 'child', parentId: 'task-child' })
    ] }], through)
    expect(report.models).toEqual([
      expect.objectContaining({ model: 'sonnet', totalTokens: 18, reports: 1 }),
      expect.objectContaining({ model: 'fable', totalTokens: 8, estimated: true })
    ])
    expect(report.coverage.nestedReportsExcluded).toBe(1)
  })

  it('does not double count turn reports beside a cumulative counter and attributes rollover deltas after a model change', () => {
    const report = summarizeWeeklyModelUsage([{ sessionId: 'one', provider: 'codex', model: 'old-model', events: [
      event(1, '2026-09-14T00:00:00.000Z', { type: 'usage', scope: 'session', source: 'provider', totalTokens: 100 }),
      event(2, '2026-09-18T00:00:00.000Z', { type: 'usage', scope: 'turn', source: 'provider', totalTokens: 40 }, { turnId: 'turn-a' }),
      event(3, '2026-09-18T00:01:00.000Z', { type: 'usage', scope: 'session', source: 'provider', totalTokens: 140 }),
      event(4, '2026-09-19T00:00:00.000Z', { type: 'session', phase: 'running', settings: { permission: 'default', plan: false, model: 'new-model' } }),
      event(5, '2026-09-19T00:01:00.000Z', { type: 'usage', scope: 'session', source: 'provider', totalTokens: 12 })
    ] }], through)
    expect(report.models).toEqual([
      expect.objectContaining({ model: 'old-model', totalTokens: 40 }),
      expect.objectContaining({ model: 'new-model', totalTokens: 12 })
    ])
  })

  it('counts only lower-scope reports outside the cumulative observation interval', () => {
    const report = summarizeWeeklyModelUsage([{ sessionId: 'one', provider: 'codex', model: 'gpt', events: [
      event(1, '2026-09-14T00:00:00.000Z', { type: 'usage', scope: 'session', source: 'provider', totalTokens: 100 }),
      event(2, '2026-09-16T00:00:00.000Z', { type: 'usage', scope: 'turn', source: 'provider', totalTokens: 50 }, { turnId: 'covered' }),
      event(3, '2026-09-16T00:01:00.000Z', { type: 'usage', scope: 'session', source: 'provider', totalTokens: 150 }),
      event(4, '2026-09-17T00:00:00.000Z', { type: 'usage', scope: 'turn', source: 'provider', totalTokens: 20 }, { turnId: 'after-counter' })
    ] }], through)
    expect(report.models[0]).toMatchObject({ totalTokens: 70, reports: 2 })
  })

  it('keeps independent turns when a first cumulative counter has no baseline and never trusts a truncated first counter', () => {
    const old = summarizeWeeklyModelUsage([{ sessionId: 'one', provider: 'codex', model: 'gpt', events: [
      event(1, '2026-09-10T00:00:00.000Z', { type: 'session', phase: 'idle' }),
      event(2, '2026-09-16T00:00:00.000Z', { type: 'usage', scope: 'turn', source: 'provider', totalTokens: 20 }, { turnId: 'known-turn' }),
      event(3, '2026-09-17T00:00:00.000Z', { type: 'usage', scope: 'session', source: 'provider', totalTokens: 900 })
    ] }], through)
    expect(old.models[0]).toMatchObject({ totalTokens: 20 })
    expect(old.coverage.countersWithoutBaseline).toBe(1)

    const truncated = summarizeWeeklyModelUsage([{ sessionId: 'one', provider: 'codex', model: 'gpt', truncated: true, runtimeStarts: { 'run-1': '2026-09-20T00:00:00.000Z' }, events: [
      event(2, '2026-09-20T01:00:00.000Z', { type: 'usage', scope: 'session', source: 'provider', totalTokens: 500 })
    ] }], through)
    expect(truncated.models).toEqual([])
    expect(truncated.coverage.complete).toBe(false)
    expect(truncated.coverage.notes.join(' ')).toMatch(/compacted/)
  })
})
