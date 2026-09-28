import { describe, expect, it } from 'vitest'
import { modelKeyId, type BenchmarkResult, type ExecutionOutcome, type ModelKey, type TaskCategory } from '../../shared/model-routing'
import { outcome } from './capture/common'
import { ReputationService, type ReputationStorePort } from './reputation-service'

const NOW = Date.parse('2026-09-28T12:00:00Z')
const opus: ModelKey = { provider: 'claude', model: 'opus' }, sonnet: ModelKey = { provider: 'claude', model: 'sonnet' }, stranger: ModelKey = { provider: 'grok', model: 'nobody' }

function fixture() {
  const rows: ExecutionOutcome[] = [], benches: BenchmarkResult[] = [], calls: string[] = []
  const known = new Set([modelKeyId(opus), modelKeyId(sonnet)])
  const port: ReputationStorePort = {
    outcomes: ({ key, since, limit }) => { calls.push(modelKeyId(key)); return rows.filter(row => modelKeyId(row.key) === modelKeyId(key) && row.at >= since).slice(0, limit) },
    benchmarks: key => benches.filter(bench => modelKeyId(bench.key) === modelKeyId(key)),
    family: key => key.provider === 'claude' ? [opus, sonnet] : [],
    known: key => known.has(modelKeyId(key)),
  }
  let clock = NOW
  const service = new ReputationService(port, { now: () => clock, ttlMs: 1_000 })
  let n = 0
  const add = (key: ModelKey, category: TaskCategory, result: ExecutionOutcome['result']) => { const row = outcome({ key, source: 'turn', ref: `r${n++}`, category, at: new Date(NOW).toISOString(), result }); rows.push(row); return row }
  return { rows, benches, calls, service, add, tick: (ms: number) => { clock += ms } }
}

describe('ReputationService', () => {
  it('returns null only for an unknown key, and the prior for a known key without evidence', () => {
    const { service } = fixture()
    expect(service.reputation(stranger, 'debugging')).toBeNull()
    expect(service.reputation(opus, 'debugging')).toMatchObject({ mean: 0.6, evidence: 0, priorSource: 'default' })
  })
  it('uses benchmarks, then family evidence, as the prior', () => {
    const { service, benches, add } = fixture()
    benches.push({ key: opus, benchmark: 'swe', score: 0.85, raw: '85%', categories: ['difficult-coding'], source: { kind: 'benchmark', name: 'swe' }, observedAt: '2026-09-01T00:00:00Z' })
    for (let i = 0; i < 6; i++) add(sonnet, 'research', 'success')
    expect(service.reputation(opus, 'difficult-coding')).toMatchObject({ priorMean: 0.85, priorSource: 'benchmark', evidence: 0 })
    const research = service.reputation(opus, 'research')!
    expect(research.priorSource).toBe('family'); expect(research.priorMean).toBeGreaterThan(0.7)
  })
  it('profile lists dimensions with evidence plus the prior-only ones', () => {
    const { service, add, benches } = fixture()
    add(opus, 'debugging', 'success')
    benches.push({ key: opus, benchmark: 'mmmu', score: 0.7, raw: '70', categories: ['vision'], source: { kind: 'benchmark', name: 'mmmu' }, observedAt: '2026-09-01T00:00:00Z' })
    const dims = service.profile(opus).map(entry => entry.dimension).sort()
    expect(dims).toEqual(['debugging', 'false-completion', 'loop-tendency', 'reliability', 'vision'].sort())
    expect(service.profile(stranger)).toEqual([])
  })
  it('caches for the TTL and invalidates on outcomeRecorded, including family members', () => {
    const { service, add, calls, tick } = fixture()
    service.reputation(opus, 'debugging'); service.reputation(opus, 'debugging')
    const reads = calls.filter(call => call === 'claude/opus').length
    expect(reads).toBe(1)
    const row = add(opus, 'debugging', 'failure')
    expect(service.reputation(opus, 'debugging')!.evidence).toBe(0)
    service.outcomeRecorded(row)
    expect(service.reputation(opus, 'debugging')!.evidence).toBe(1)
    // sonnet's family prior reads opus; recording for opus drops sonnet's cache too
    service.reputation(sonnet, 'debugging')
    const before = calls.length
    service.outcomeRecorded(add(opus, 'debugging', 'failure'))
    service.reputation(sonnet, 'debugging')
    expect(calls.length).toBeGreaterThan(before)
    tick(2_000); const again = calls.length; service.reputation(opus, 'debugging')
    expect(calls.length).toBeGreaterThan(again)
  })
  it('outcomes move the served score', () => {
    const { service, add } = fixture()
    const before = service.reputation(opus, 'debugging')!.mean
    for (let i = 0; i < 5; i++) service.outcomeRecorded(add(opus, 'debugging', 'failure'))
    expect(service.reputation(opus, 'debugging')!.mean).toBeLessThan(before)
    expect(service.proven(opus)).toBe(false)
    for (let i = 0; i < 7; i++) service.outcomeRecorded(add(opus, 'research', 'success'))
    expect(service.proven(opus)).toBe(true)
  })
})
