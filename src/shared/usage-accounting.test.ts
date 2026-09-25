import { describe, expect, it } from 'vitest'
import type { AgentEventData, TimelineItem } from './structured-agent'
import { cacheReadBilledEquivalent, summarizeUsage, tokenBreakdown } from './usage-accounting'

const usage = (sequence: number, turnId: string, data: Partial<Extract<AgentEventData, { type: 'usage' }>>, runtimeId = 'run-1'): TimelineItem => ({
  id: `usage-${sequence}`, runtimeId, turnId, sequence, timestamp: '2026-09-25T10:00:00.000Z', nativeItemId: `message-${sequence}`,
  data: { type: 'usage', source: 'provider', scope: 'message', ...data }
})
// Claude's adapter reports a message's input as the whole prompt: new input plus the cache it
// read plus the cache it wrote. A long session re-reads the same prefix on every call.
const claudeMessage = (sequence: number, turnId: string, fresh: number, read: number, write: number, output: number): TimelineItem =>
  usage(sequence, turnId, { inputTokens: fresh + read + write, cachedTokens: read, cacheCreationTokens: write, outputTokens: output, totalTokens: fresh + read + write + output })

describe('token breakdown', () => {
  it('keeps new input, cache reads, cache writes and output apart', () => {
    expect(tokenBreakdown({ inputTokens: 10_500, cachedTokens: 9_000, cacheCreationTokens: 1_000, outputTokens: 300, reasoningTokens: 40, totalTokens: 10_800 })).toEqual({
      newInput: 500, cacheRead: 9_000, cacheWrite: 1_000, output: 300, reasoning: 40, processed: 1_800, total: 10_800
    })
    // A report with only a total cannot be split; it is its own headline.
    expect(tokenBreakdown({ totalTokens: 1234 })).toEqual({ total: 1234, processed: 1234, cacheRead: 0, cacheWrite: 0 })
    expect(tokenBreakdown(undefined)).toBeUndefined()
  })

  it('does not let a multi-turn cached conversation grow its headline with repeated context', () => {
    // Every call re-reads a 50k prefix. Each turn adds 200 new tokens and writes 1k of cache.
    const turns = (count: number): TimelineItem[] => Array.from({ length: count }, (_, turn) => [
      claudeMessage(turn * 2 + 1, `turn-${turn}`, 200, 50_000 + turn * 1_000, 1_000, 400),
      claudeMessage(turn * 2 + 2, `turn-${turn}`, 100, 51_000 + turn * 1_000, 0, 600)
    ]).flat()
    const short = tokenBreakdown(summarizeUsage(turns(2)).tokens)!
    const long = tokenBreakdown(summarizeUsage(turns(20)).tokens)!
    // Processed grows only with what each turn added: 300 new + 1k written + 1k output.
    expect(short.processed).toBe(2 * 2_300)
    expect(long.processed).toBe(20 * 2_300)
    expect(long.output).toBe(20 * 1_000)
    // The re-read context is all still there, but reported on its own.
    expect(long.cacheRead).toBeGreaterThan(2_000_000)
    expect(long.total).toBeGreaterThan(long.processed! * 40)
    expect(cacheReadBilledEquivalent(long, 'claude')).toBe(Math.round(long.cacheRead * 0.1))
    expect(cacheReadBilledEquivalent(long, 'local')).toBeUndefined()
  })

  it('never adds a cumulative Codex thread total to per-turn reports', () => {
    const items = [
      usage(1, 'turn-1', { scope: 'turn', inputTokens: 1_000, cachedTokens: 0, outputTokens: 100, totalTokens: 1_100 }),
      usage(2, 'turn-2', { scope: 'turn', inputTokens: 1_500, cachedTokens: 1_000, outputTokens: 200, totalTokens: 1_700 }),
      // thread/tokenUsage/updated: the whole thread so far, restated after every turn.
      { ...usage(3, 'turn-2', { scope: 'session', inputTokens: 2_500, cachedTokens: 1_000, outputTokens: 300, totalTokens: 2_800 }), turnId: undefined }
    ]
    const summary = summarizeUsage(items)
    expect(summary.tokens).toMatchObject({ inputTokens: 2_500, outputTokens: 300, totalTokens: 2_800 })
    expect(tokenBreakdown(summary.tokens)).toMatchObject({ newInput: 1_500, cacheRead: 1_000, output: 300, processed: 1_800 })
  })
})
