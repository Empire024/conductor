import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { DecisionRecord, ExecutionOutcome } from '../../shared/model-routing'
import { ModelRegistry } from './registry'
import { ReputationService } from './reputation-service'
import { MAX_QUERY_LIMIT, MODEL_INTEL_SCHEMA_VERSION, ModelIntelligenceStore } from './store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const opus = { provider: 'claude', model: 'opus[1m]' }
const qwen = { provider: 'local', model: 'local/qwen3.6-35b-a3b' }

function outcome(patch: Partial<ExecutionOutcome> = {}): Omit<ExecutionOutcome, 'id'> {
  return {
    key: opus, effort: 'high', source: 'turn', ref: 'turn_1', category: 'difficult-coding', complexity: 4, projectId: 'project_1', agentSessionId: 'session_1',
    decisionId: null, at: '2026-09-20T10:00:00.000Z', result: 'success', verifier: 'pass', durationMs: 60_000, tokens: 12_000, costUsd: 0.4, retries: 0,
    iterations: 3, toolFailures: 0, contextFailure: false, looped: false, timedOut: false, overBudget: false, invalidOutput: false, falseCompletion: false,
    escalated: false, repairedBy: null, ownerCorrected: false, ...patch
  }
}

function decision(patch: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: 'decision_1', kind: 'route', requester: 'router', question: 'Which model?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], state: { category: 'debugging' },
    at: '2026-09-20T10:00:00.000Z', choice: 'a', confidence: 0.8, margin: 0.6, probabilities: { a: 0.8, b: 0.2 }, decidedBy: 'scorer', escalated: false, escalationReason: null,
    verdicts: [{ decider: 'scorer', probabilities: { a: 0.8, b: 0.2 }, rationale: 'cheaper', elapsedMs: 1 }], rationale: 'cheaper', outcome: null, projectId: 'project_1', agentSessionId: null, ...patch
  }
}

describe('ModelIntelligenceStore', () => {
  it('creates the documented tables and indexes, records its schema version, and reopens a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-intel-store-'))
    dirs.push(dir)
    const path = join(dir, 'nested', 'conductor.db')
    const store = new ModelIntelligenceStore(path)
    expect(store.schemaVersion()).toBe(MODEL_INTEL_SCHEMA_VERSION)
    store.recordOutcome(outcome())
    store.close()
    const db = new DatabaseSync(path)
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as Array<{ name: string }>).map(row => row.name)
    for (const table of ['model_intel_meta', 'model_registry', 'model_observations', 'model_benchmarks', 'model_changes', 'execution_outcomes', 'routing_decisions']) expect(names).toContain(table)
    for (const index of ['model_observations_key_idx', 'model_benchmarks_key_idx', 'model_changes_at_idx', 'execution_outcomes_key_idx', 'execution_outcomes_at_idx', 'routing_decisions_at_idx', 'routing_decisions_kind_idx']) expect(names).toContain(index)
    db.close()
    const reopened = new ModelIntelligenceStore(path)
    expect(reopened.outcomes({ since: '2026-01-01T00:00:00Z', limit: 10 })).toHaveLength(1)
    reopened.close()
  })

  it('refuses a database written by a newer schema', () => {
    const db = new DatabaseSync(':memory:')
    new ModelIntelligenceStore(db)
    db.prepare("UPDATE model_intel_meta SET value = '99' WHERE key = 'schema_version'").run()
    expect(() => new ModelIntelligenceStore(db)).toThrow(/newer than this build/)
  })

  it('records an outcome once per (source, ref, key) and returns the stored row on a repeat', () => {
    const store = new ModelIntelligenceStore(':memory:')
    const first = store.recordOutcome(outcome())
    const again = store.recordOutcome(outcome({ result: 'failure' }))
    expect(first.inserted).toBe(true)
    expect(again).toEqual({ outcome: first.outcome, inserted: false })
    expect(store.recordOutcome(outcome({ key: qwen })).inserted).toBe(true)
    expect(store.recordOutcome(outcome({ source: 'owner' })).inserted).toBe(true)
    expect(store.outcomes({ since: '2026-01-01T00:00:00Z', limit: 10 })).toHaveLength(3)
  })

  it('queries outcomes by key, category and window, newest first and bounded', () => {
    const store = new ModelIntelligenceStore(':memory:')
    store.recordOutcome(outcome({ ref: 'a', at: '2026-09-01T00:00:00Z' }))
    store.recordOutcome(outcome({ ref: 'b', at: '2026-09-10T00:00:00Z', category: 'debugging' }))
    store.recordOutcome(outcome({ ref: 'c', at: '2026-09-20T00:00:00Z' }))
    store.recordOutcome(outcome({ ref: 'd', at: '2026-09-21T00:00:00Z', key: qwen }))
    expect(store.outcomes({ key: opus, category: 'difficult-coding', since: '2026-08-01T00:00:00Z', limit: 10 }).map(row => row.ref)).toEqual(['c', 'a'])
    expect(store.outcomes({ category: 'difficult-coding', since: '2026-08-01T00:00:00Z', limit: 10 }).map(row => row.ref)).toEqual(['d', 'c', 'a'])
    expect(store.outcomes({ key: opus, since: '2026-09-05T00:00:00Z', until: '2026-09-15T00:00:00Z', limit: 10 }).map(row => row.ref)).toEqual(['b'])
    expect(store.outcomes({ since: '2026-08-01T00:00:00Z', limit: 2 }).map(row => row.ref)).toEqual(['d', 'c'])
    expect(() => store.outcomes({ since: '2026-08-01T00:00:00Z', limit: 0 })).toThrow(/limit/)
    expect(() => store.outcomes({ since: 'yesterday', limit: 5 })).toThrow(/ISO/)
    expect(MAX_QUERY_LIMIT).toBeGreaterThan(1000)
  })

  it('amends an outcome with the owner verdict and finds outcomes by decision', () => {
    const store = new ModelIntelligenceStore(':memory:')
    const { outcome: row } = store.recordOutcome(outcome({ decisionId: 'decision_1' }))
    const amended = store.amendOutcome(row.id, { result: 'failure', ownerCorrected: true, falseCompletion: true })
    expect(amended).toMatchObject({ id: row.id, result: 'failure', ownerCorrected: true, falseCompletion: true, ref: 'turn_1' })
    expect(store.outcome(row.id)).toEqual(amended)
    expect(store.outcomesForDecision('decision_1').map(entry => entry.id)).toEqual([row.id])
    expect(store.amendOutcome('missing', { result: 'success' })).toBeNull()
  })

  it('journals decisions, links an outcome back later, and lists by kind and window', () => {
    const store = new ModelIntelligenceStore(':memory:')
    store.recordDecision(decision())
    store.recordDecision(decision({ id: 'decision_2', kind: 'approval', at: '2026-09-21T00:00:00Z', choice: null }))
    store.recordDecision(decision({ id: 'decision_3', at: '2026-09-22T00:00:00Z' }))
    expect(() => store.recordDecision(decision())).toThrow()
    expect(store.decision('decision_1')).toEqual(decision())
    const updated = store.updateDecisionOutcome('decision_1', { result: 'failure', at: '2026-09-20T11:00:00Z', detail: 'tests failed' })
    expect(updated?.outcome).toEqual({ result: 'failure', at: '2026-09-20T11:00:00.000Z', detail: 'tests failed' })
    expect(store.updateDecisionOutcome('missing', { result: 'success', at: '2026-09-20T11:00:00Z' })).toBeNull()
    expect(store.decisions({ kind: 'route', since: '2026-09-01T00:00:00Z', limit: 10 }).map(row => row.id)).toEqual(['decision_3', 'decision_1'])
    expect(store.decisions({ since: '2026-09-21T00:00:00Z', limit: 10 }).map(row => row.id)).toEqual(['decision_3', 'decision_2'])
    expect(store.decisions({ since: '2026-09-01T00:00:00Z', limit: 1 }).map(row => row.id)).toEqual(['decision_3'])
  })

  it('prunes past retention in bounded batches and reports when the budget ran out', () => {
    const store = new ModelIntelligenceStore(':memory:')
    const now = new Date('2026-09-28T00:00:00Z')
    for (let index = 0; index < 7; index++) store.recordOutcome(outcome({ ref: `old_${index}`, at: '2026-01-01T00:00:00Z' }))
    store.recordOutcome(outcome({ ref: 'recent', at: '2026-09-01T00:00:00Z' }))
    store.recordDecision(decision({ id: 'old', at: '2026-06-01T00:00:00Z' }))
    store.recordDecision(decision({ id: 'recent', at: '2026-09-01T00:00:00Z' }))
    expect(store.prune(now, { batchSize: 3, maxBatches: 2 })).toEqual({ outcomes: 6, decisions: 1, complete: false })
    expect(store.prune(now, { batchSize: 3, maxBatches: 2 })).toEqual({ outcomes: 1, decisions: 0, complete: true })
    expect(store.outcomes({ since: '2020-01-01T00:00:00Z', limit: 100 }).map(row => row.ref)).toEqual(['recent'])
    expect(store.decisions({ since: '2020-01-01T00:00:00Z', limit: 100 }).map(row => row.id)).toEqual(['recent'])
  })

  it('keeps benchmarks apart, skipping an unchanged repeat and returning the latest per benchmark and source', () => {
    const store = new ModelIntelligenceStore(':memory:')
    const result = { key: opus, benchmark: 'swe-bench-verified', score: 0.79, raw: '79%', categories: ['difficult-coding' as const], source: { kind: 'benchmark' as const, name: 'benchmark:swe' }, observedAt: '2026-09-01T00:00:00Z' }
    expect(store.recordBenchmark(result)).toBe('added')
    expect(store.recordBenchmark({ ...result, observedAt: '2026-09-02T00:00:00Z' })).toBe('unchanged')
    expect(store.recordBenchmark({ ...result, score: 0.81, raw: '81%', observedAt: '2026-09-03T00:00:00Z' })).toBe('added')
    expect(store.benchmarks(opus)).toEqual([{ ...result, score: 0.81, raw: '81%', observedAt: '2026-09-03T00:00:00.000Z' }])
    expect(() => store.recordBenchmark({ ...result, score: 79 })).toThrow(/0..1/)
  })

  it('is the ReputationStorePort: a registered key without evidence gets a prior, and family priors flow from other providers', () => {
    const now = new Date('2026-09-28T00:00:00Z')
    const store = new ModelIntelligenceStore(':memory:', () => now)
    const registry = new ModelRegistry(store)
    const routed = { provider: 'openrouter', model: 'anthropic/claude-opus-5.5' }
    const fresh = { provider: 'codex', model: 'gpt-7-nova' }
    registry.applyBatch({ source: { kind: 'cli', name: 'runtime:claude' }, fetchedAt: now.toISOString(), complete: false, benchmarks: [], observations: [
      { key: opus, field: 'displayName', value: 'Claude Opus 5.5 (1M context)', source: { kind: 'cli', name: 'runtime:claude' }, observedAt: now.toISOString() }
    ] })
    registry.applyBatch({ source: { kind: 'aggregator', name: 'openrouter' }, fetchedAt: now.toISOString(), complete: true, benchmarks: [], observations: [
      { key: routed, field: 'displayName', value: 'Anthropic: Claude Opus 5.5', source: { kind: 'aggregator', name: 'openrouter' }, observedAt: now.toISOString() },
      { key: fresh, field: 'displayName', value: 'GPT-7 Nova', source: { kind: 'aggregator', name: 'openrouter' }, observedAt: now.toISOString() }
    ] })
    expect(store.known(fresh)).toBe(true)
    expect(store.known({ provider: 'codex', model: 'never-seen' })).toBe(false)
    expect(store.family(opus)).toEqual([routed])
    const service = new ReputationService(store, { now: () => now.getTime() })
    expect(service.reputation(fresh, 'difficult-coding')).toMatchObject({ key: fresh, evidence: 0, priorSource: 'default' })
    expect(service.reputation({ provider: 'codex', model: 'never-seen' }, 'difficult-coding')).toBeNull()
    for (let index = 0; index < 6; index++) store.recordOutcome(outcome({ key: routed, ref: `r${index}`, result: 'failure', at: '2026-09-27T00:00:00Z' }))
    const withFamily = service.reputation(opus, 'difficult-coding')!
    expect(withFamily).toMatchObject({ evidence: 0, priorSource: 'family' })
    expect(withFamily.priorMean).toBeLessThan(0.6)
    store.recordOutcome(outcome({ ref: 'own', at: '2026-09-27T00:00:00Z' }))
    service.outcomeRecorded({ key: opus })
    expect(service.reputation(opus, 'difficult-coding')!.evidence).toBeGreaterThan(0.9)
  })

  it('rolls back every write of a transaction that throws', () => {
    const store = new ModelIntelligenceStore(':memory:')
    expect(() => store.transaction(() => { store.recordOutcome(outcome()); throw new Error('boom') })).toThrow('boom')
    expect(store.outcomes({ since: '2020-01-01T00:00:00Z', limit: 10 })).toEqual([])
  })
})
