import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../shared/structured-agent'
import { WeeklyUsageSummaryService } from './weekly-usage-summary'

const usage = (sessionId: string): AgentEvent => ({
  schemaVersion: 1, id: `usage-${sessionId}`, sequence: 1, sessionId, runtimeId: `run-${sessionId}`, provider: 'codex', projectId: 'p', workspaceId: 'w', cwd: 'C:\\work', timestamp: '2026-09-21T00:00:00.000Z',
  data: { type: 'usage', scope: 'turn', source: 'provider', inputTokens: 8, outputTokens: 2, totalTokens: 10 }
})

describe('WeeklyUsageSummaryService', () => {
  it('reads every journal conversation and memoizes the shared report past any surface refresh', () => {
    let now = Date.parse('2026-09-22T00:00:00.000Z')
    const records = Array.from({ length: 240 }, (_, index) => ({ sessionId: `s-${index}`, provider: 'codex' as const, model: index % 2 ? 'gpt-a' : 'gpt-b', events: [usage(`s-${index}`)] }))
    const journal = vi.fn(() => records)
    const service = new WeeklyUsageSummaryService({ structured: { usageJournal: journal } }, () => now)
    const first = service.read()
    expect(first.coverage.conversationsScanned).toBe(240)
    expect(first.models.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0)).toBe(2400)
    expect(service.read()).toBe(first)
    now += 30_001
    expect(service.read()).toBe(first)
    expect(journal).toHaveBeenCalledTimes(1)
    now += 5 * 60_000
    expect(service.read()).not.toBe(first)
    expect(journal).toHaveBeenCalledTimes(2)
    service.invalidate(); service.read()
    expect(journal).toHaveBeenCalledTimes(3)
  })
  it('bounds the journal read to the reporting window plus one window of counter baseline', () => {
    const now = Date.parse('2026-09-22T00:00:00.000Z')
    const journal = vi.fn(() => [])
    new WeeklyUsageSummaryService({ structured: { usageJournal: journal } }, () => now).read()
    expect(journal).toHaveBeenCalledWith('2026-09-08T00:00:00.000Z', '2026-09-15T00:00:00.000Z')
  })
  it('reads one conversation per macrotask so a long journal never holds the main process', async () => {
    const now = Date.parse('2026-09-22T00:00:00.000Z')
    const ids = Array.from({ length: 30 }, (_, index) => `s-${index}`)
    const usageConversation = vi.fn((sessionId: string) => ({ sessionId, provider: 'codex' as const, model: 'gpt-a', events: [usage(sessionId)] }))
    const journal = vi.fn(() => { throw new Error('the desktop path must not take the blocking read') })
    const service = new WeeklyUsageSummaryService({ structured: { usageJournal: journal, usageSessions: () => ids, usageConversation } }, () => now)
    let ticks = 0
    const counting = setInterval(() => { ticks += 1 }, 0)
    const report = await service.readAsync()
    clearInterval(counting)
    expect(usageConversation).toHaveBeenCalledTimes(30)
    expect(usageConversation).toHaveBeenCalledWith('s-0', '2026-09-08T00:00:00.000Z', '2026-09-15T00:00:00.000Z')
    expect(report.models[0]?.totalTokens).toBe(300)
    // The loop kept running while the journal was read, which a single blocking scan cannot do.
    expect(ticks).toBeGreaterThan(0)
    // A second caller takes the memoized report, and concurrent callers share one scan.
    service.invalidate()
    const [first, second] = await Promise.all([service.readAsync(), service.readAsync()])
    expect(first).toBe(second)
    expect(usageConversation).toHaveBeenCalledTimes(60)
  })
  it('falls back to the blocking read when the source cannot be read one conversation at a time', async () => {
    const now = Date.parse('2026-09-22T00:00:00.000Z')
    const journal = vi.fn(() => [{ sessionId: 's', provider: 'codex' as const, model: 'gpt-a', events: [usage('s')] }])
    const report = await new WeeklyUsageSummaryService({ structured: { usageJournal: journal } }, () => now).readAsync()
    expect(journal).toHaveBeenCalledTimes(1)
    expect(report.models[0]?.totalTokens).toBe(10)
  })
})
