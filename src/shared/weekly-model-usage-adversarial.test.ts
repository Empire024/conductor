import { describe, expect, it } from 'vitest'
import type { AgentEvent } from './structured-agent'
import { summarizeWeeklyModelUsage } from './weekly-model-usage'

const now = Date.parse('2026-09-22T00:00:00Z')
const event = (sequence: number, timestamp: string, scope: 'session' | 'turn', totalTokens: number): AgentEvent => ({
  schemaVersion: 1, id: `e-${sequence}`, sessionId: 's', runtimeId: 'r', provider: 'codex', projectId: 'p', workspaceId: 'w', cwd: '',
  sequence, timestamp, ...(scope === 'turn' ? { turnId: `turn-${sequence}` } : {}),
  data: { type: 'usage', scope, source: 'provider', totalTokens }
})
const total = (events: AgentEvent[], truncated = false) => summarizeWeeklyModelUsage([{ sessionId: 's', provider: 'codex', model: 'test-model', events, truncated }], now)
const tokens = (report: ReturnType<typeof total>) => report.models.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0)

describe('weekly usage accounting boundaries', () => {
  it('preserves a native Codex thread counter across reconnects and separates new threads', () => {
    const events = [
      { ...event(1, '2026-09-14T00:00:00Z', 'session', 1000), nativeSessionId: 'thread-a' },
      { ...event(2, '2026-09-16T00:00:00Z', 'session', 1100), nativeSessionId: 'thread-a' },
      { ...event(3, '2026-09-20T00:00:00Z', 'session', 1200), runtimeId: 'reconnected', nativeSessionId: 'thread-a' },
      { ...event(4, '2026-09-21T00:00:00Z', 'session', 50), runtimeId: 'fresh', nativeSessionId: 'thread-b' }
    ]
    const report = summarizeWeeklyModelUsage([{ sessionId: 's', provider: 'codex', events, runtimeStarts: {
      r: '2026-09-14T00:00:00Z', reconnected: '2026-09-20T00:00:00Z', fresh: '2026-09-21T00:00:00Z'
    } }], now)
    expect(tokens(report)).toBe(250)
    expect(report.coverage.complete).toBe(true)
  })
  it('retains a completed turn newer than the last cumulative observation', () => {
    const report = total([
      event(1, '2026-09-14T00:00:00Z', 'session', 100),
      event(2, '2026-09-16T00:00:00Z', 'turn', 50),
      event(3, '2026-09-16T00:01:00Z', 'session', 150),
      event(4, '2026-09-20T00:00:00Z', 'turn', 20)
    ])
    expect(tokens(report)).toBe(70)
  })

  it('does not call an unbaselined retained lifetime counter weekly usage', () => {
    const report = total([
      event(900, '2026-09-19T00:00:00Z', 'session', 500_000),
      event(901, '2026-09-20T00:00:00Z', 'session', 500_050)
    ], true)
    expect(tokens(report)).toBe(50)
    expect(report.coverage.countersWithoutBaseline).toBe(1)
    expect(report.coverage.complete).toBe(false)
  })
})
