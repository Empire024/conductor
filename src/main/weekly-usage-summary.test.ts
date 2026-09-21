import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../shared/structured-agent'
import { WeeklyUsageSummaryService } from './weekly-usage-summary'

const usage = (sessionId: string): AgentEvent => ({
  schemaVersion: 1, id: `usage-${sessionId}`, sequence: 1, sessionId, runtimeId: `run-${sessionId}`, provider: 'codex', projectId: 'p', workspaceId: 'w', cwd: 'C:\\work', timestamp: '2026-09-21T00:00:00.000Z',
  data: { type: 'usage', scope: 'turn', source: 'provider', inputTokens: 8, outputTokens: 2, totalTokens: 10 }
})

describe('WeeklyUsageSummaryService', () => {
  it('reads every journal conversation and memoizes the shared report for thirty seconds', () => {
    let now = Date.parse('2026-09-22T00:00:00.000Z')
    const records = Array.from({ length: 240 }, (_, index) => ({ sessionId: `s-${index}`, provider: 'codex' as const, model: index % 2 ? 'gpt-a' : 'gpt-b', events: [usage(`s-${index}`)] }))
    const journal = vi.fn(() => records)
    const service = new WeeklyUsageSummaryService({ structured: { usageJournal: journal } }, () => now)
    const first = service.read()
    expect(first.coverage.conversationsScanned).toBe(240)
    expect(first.models.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0)).toBe(2400)
    expect(service.read()).toBe(first)
    expect(journal).toHaveBeenCalledTimes(1)
    now += 30_001
    expect(service.read()).not.toBe(first)
    expect(journal).toHaveBeenCalledTimes(2)
    service.invalidate(); service.read()
    expect(journal).toHaveBeenCalledTimes(3)
  })
})
