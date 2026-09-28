import { describe, expect, it } from 'vitest'
import { fetchBatch, parseBenchmarks } from './benchmarks'

const AT = '2026-09-28T00:00:00.000Z'

describe('benchmark source', () => {
  it('normalises scores to 0..1, keeps the raw figure, and defaults categories per benchmark', () => {
    const { batch, skipped } = parseBenchmarks(JSON.stringify({
      source: { name: 'SWE-bench Verified', url: 'https://www.swebench.com' }, observedAt: '2026-09-01T00:00:00Z',
      results: [
        { provider: 'claude', model: 'opus[1m]', score: 79.4 },
        { key: 'openrouter/qwen/qwen3.6-35b-a3b', benchmark: 'Terminal Bench', score: '41.5%', categories: ['terminal-use', 'not-a-category'] },
        { provider: 'codex', model: 'gpt-6-astra', score: 0.81, raw: '81.0 (pass@1)' },
        { provider: 'local', model: 'local/x', score: 3, max: 5, benchmark: 'custom-eval' },
        { provider: 'claude', score: 50 },
        { key: 'claude', score: 50 },
        { provider: 'claude', model: 'sonnet', score: 'n/a' },
        { provider: 'claude', model: 'sonnet', score: 250 }
      ]
    }), AT)
    expect(skipped).toBe(4)
    expect(batch).toMatchObject({ source: { kind: 'benchmark', name: 'benchmark:swe-bench-verified', url: 'https://www.swebench.com' }, observations: [], complete: false })
    expect(batch.benchmarks.map(result => [result.key, result.benchmark, result.score, result.raw, result.categories])).toEqual([
      [{ provider: 'claude', model: 'opus[1m]' }, 'swe-bench-verified', 0.794, '79.4', ['difficult-coding', 'debugging', 'large-repo']],
      [{ provider: 'openrouter', model: 'qwen/qwen3.6-35b-a3b' }, 'terminal-bench', 0.415, '41.5%', ['terminal-use']],
      [{ provider: 'codex', model: 'gpt-6-astra' }, 'swe-bench-verified', 0.81, '81.0 (pass@1)', ['difficult-coding', 'debugging', 'large-repo']],
      [{ provider: 'local', model: 'local/x' }, 'custom-eval', 0.6, '3', ['general']]
    ])
    expect(batch.benchmarks.every(result => result.observedAt === '2026-09-01T00:00:00.000Z')).toBe(true)
  })

  it('rejects a file without a source or results', async () => {
    expect(() => parseBenchmarks('{"results": []}', AT)).toThrow(/source.name/)
    await expect(fetchBatch({ read: () => 'not json' })).rejects.toThrow()
  })
})
