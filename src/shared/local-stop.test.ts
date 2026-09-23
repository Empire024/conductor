import { describe, expect, it } from 'vitest'
import { localStopLabels, localStopOf, localStopPayload, localStopSummary, type LocalStopReport } from './local-stop'

const report = (reason: LocalStopReport['reason']): LocalStopReport => ({
  reason, detail: 'detail', rounds: 16, hardLimit: 24,
  context: { usedTokens: 24_100, capacityTokens: 30_208, reserveTokens: 2560, windowTokens: 32_768, percent: 79.8, estimated: false },
  compactions: 2, recoveredTokens: 9000, loopWarnings: 1, filesChanged: ['public/text-diff.js'], commandsRun: 3, excludedOutputChars: 12_000, timeline: []
})

describe('local stop report', () => {
  it('round-trips through a notice payload and distinguishes tokens from rounds', () => {
    for (const reason of ['context_limit', 'round_limit', 'completed', 'stagnation', 'output_limit', 'unverified_claim'] as const) {
      const value = report(reason)
      expect(localStopOf({ type: 'notice', message: localStopSummary(value), payload: localStopPayload(value) })).toEqual(value)
    }
    expect(localStopOf({ type: 'notice', message: 'plain' })).toBeUndefined()
    expect(localStopOf({ type: 'notice', message: 'x', payload: { localStop: { reason: 'nonsense' } } })).toBeUndefined()
    expect(localStopLabels.context_limit).not.toBe(localStopLabels.round_limit)
    expect(localStopSummary(report('context_limit'))).toBe('Context limit reached after 16 of 24 tool rounds; context 24,100 / 30,208 tokens (80%); compacted 2×; 1 loop warning.')
    expect(localStopSummary(report('round_limit'))).toMatch(/^Tool-round limit reached after 16 of 24 tool rounds/)
  })
})
