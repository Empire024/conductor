import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { DecisionRecord, ModelKey, SourceRef } from '../../shared/model-routing'
import { ModelRegistry } from './registry'
import { BINDINGS_MAX, ModelIntelligenceStore, systemOneOf } from './store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const AT = '2026-09-28T00:00:00.000Z'

function decision(patch: Partial<DecisionRecord>): DecisionRecord {
  return { id: 'd', kind: 'approval', requester: 'approval-gate', question: 'q', options: ['allow', 'deny', 'escalate'].map(id => ({ id, label: id })), state: {}, at: AT, choice: 'allow',
    confidence: 1, margin: 1, probabilities: { allow: 1, deny: 0, escalate: 0 }, decidedBy: 'approval-reviewer:opus', escalated: true, escalationReason: 'mode shadow', rationale: 'r', outcome: null, projectId: 'p', agentSessionId: 'w',
    verdicts: [{ decider: 'local-llm:qwen', probabilities: { allow: 0.8, deny: 0.1, escalate: 0.1 }, rationale: 'l', elapsedMs: 1 }, { decider: 'approval-reviewer:opus', probabilities: { allow: 1, deny: 0, escalate: 0 }, rationale: 'o', elapsedMs: 1 }], ...patch }
}

describe('ModelIntelligenceStore v2', () => {
  it('migrates a v1 database: doubled local keys become registry form, decisions gain route and dry-run columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-intel-v2-')); dirs.push(dir)
    const path = join(dir, 'conductor.db')
    new ModelIntelligenceStore(path).close()
    const db = new DatabaseSync(path)
    db.exec("UPDATE model_intel_meta SET value = '1' WHERE key = 'schema_version'")
    db.exec("INSERT INTO model_registry (key, provider, model, status, family, first_seen_at, updated_at, record_json) VALUES ('local/local/qwen', 'local', 'local/qwen', 'unproven', 'qwen', 'x', 'x', '{}')")
    db.exec("INSERT INTO execution_outcomes (id, key, source, ref, category, at, result, row_json) VALUES ('o', 'local/local/qwen', 'turn', 'r', 'debugging', 'x', 'success', '{}')")
    db.close()
    const store = new ModelIntelligenceStore(path)
    expect(store.schemaVersion()).toBe(2)
    expect(store.known({ provider: 'local', model: 'local/qwen' })).toBe(true)
    const check = new DatabaseSync(path)
    expect((check.prepare('SELECT key FROM execution_outcomes').get() as { key: string }).key).toBe('local/qwen')
    expect((check.prepare('PRAGMA table_info(routing_decisions)').all() as Array<{ name: string }>).map(column => column.name)).toEqual(expect.arrayContaining(['route_json', 'dry_run']))
    check.close()
    store.close()
  })

  it('counts approval agreement: the owner answer first, else the frontier choice; dry runs and failed or missing verdicts are not cases', () => {
    const store = new ModelIntelligenceStore(':memory:')
    store.recordDecision(decision({ id: 'agree-reviewer' }))
    store.recordDecision(decision({ id: 'disagree-reviewer', choice: 'escalate', probabilities: { allow: 0, deny: 0, escalate: 1 } }))
    store.recordDecision(decision({ id: 'owner-overrides', choice: 'escalate' }))
    store.updateDecisionOutcome('owner-overrides', { result: 'success', at: AT, detail: 'owner answered allow', answer: 'allow' })
    store.recordDecision(decision({ id: 'local-failed', verdicts: [{ decider: 'local-llm', failed: 'no server' }, { decider: 'approval-reviewer:opus', probabilities: { allow: 1, deny: 0, escalate: 0 }, rationale: 'o', elapsedMs: 1 }] }))
    store.recordDecision(decision({ id: 'reviewer-only', verdicts: [{ decider: 'approval-reviewer:opus', probabilities: { allow: 1, deny: 0, escalate: 0 }, rationale: 'o', elapsedMs: 1 }] }))
    store.recordDecision(decision({ id: 'explicit', systemOne: { decider: 'local-llm:qwen', choice: 'deny', confidence: 0.7 }, choice: 'deny' }))
    store.recordDecision(decision({ id: 'dry', dryRun: true }))
    store.recordDecision(decision({ id: 'route', kind: 'route' }))
    expect(store.approvalAgreement({ kind: 'approval', since: '2026-01-01T00:00:00Z' })).toEqual({ kind: 'approval', since: '2026-01-01T00:00:00.000Z', cases: 4, agreed: 3, rate: 0.75 })
    expect(store.approvalAgreement({ kind: 'retry', since: '2026-01-01T00:00:00Z' })).toMatchObject({ cases: 0, rate: null })
    expect(systemOneOf(decision({}))).toEqual({ decider: 'local-llm:qwen', choice: 'allow', confidence: 0.8 })
  })

  it('lends a key its family members benchmarks when it has none of its own', () => {
    const store = new ModelIntelligenceStore(':memory:'), registry = new ModelRegistry(store)
    const source: SourceRef = { kind: 'aggregator', name: 'test' }, bench: SourceRef = { kind: 'benchmark', name: 'benchmark:swe' }
    const cli: ModelKey = { provider: 'claude', model: 'opus[1m]' }, routed: ModelKey = { provider: 'openrouter', model: 'anthropic/claude-opus-5.5' }
    registry.applyBatch({ source, fetchedAt: AT, complete: false, observations: [cli, routed].map(key => ({ key, field: 'family' as const, value: 'claude-opus-5.5', source, observedAt: AT })),
      benchmarks: [{ key: routed, benchmark: 'swe-bench-verified', score: 0.8, raw: '80%', categories: ['difficult-coding'], source: bench, observedAt: AT }] })
    expect(store.benchmarks(cli)).toEqual([{ key: cli, benchmark: 'swe-bench-verified', score: 0.8, raw: '80%', categories: ['difficult-coding'], source: bench, observedAt: AT }])
    expect(store.benchmarks(routed)[0]!.key).toEqual(routed)
  })

  it('bounds dispatch bindings to the newest BINDINGS_MAX', () => {
    const store = new ModelIntelligenceStore(':memory:', () => new Date('2026-09-28T12:00:00Z'))
    const base = Date.parse('2026-09-28T00:00:00Z')
    const binding = (at: number) => ({ decisionId: null, features: { category: 'general' as const, complexity: 2 as const, risk: 'low' as const, toolsRequired: [], contextTokens: null }, key: { provider: 'codex', model: 'x' }, effort: null, projectId: 'p', at })
    for (let index = 0; index <= BINDINGS_MAX; index++) store.saveBinding(`agent-${index}`, binding(base + index))
    expect(store.binding('agent-0')).toBeNull()
    expect(store.binding('agent-1')).not.toBeNull()
    expect(store.binding(`agent-${BINDINGS_MAX}`)).not.toBeNull()
  })

  it('journals evaluation spend per run and sums cloud runs only', () => {
    const store = new ModelIntelligenceStore(':memory:')
    store.recordEvaluationSpend({ runId: 'a', key: { provider: 'claude', model: 'opus[1m]' }, at: AT, tokens: 1000, jobs: 3, gradedJobs: 3, stoppedBy: null })
    store.recordEvaluationSpend({ runId: 'a', key: { provider: 'claude', model: 'opus[1m]' }, at: AT, tokens: 1500, jobs: 3, gradedJobs: 3, stoppedBy: 'token-cap' })
    store.recordEvaluationSpend({ runId: 'b', key: { provider: 'codex', model: 'sol' }, at: AT, tokens: 200, jobs: 1, gradedJobs: 1, stoppedBy: null })
    store.recordEvaluationSpend({ runId: 'c', key: { provider: 'local', model: 'local/qwen' }, at: AT, tokens: 9000, jobs: 1, gradedJobs: 1, stoppedBy: null })
    expect(store.evaluationSpend('2026-09-27T00:00:00Z')).toEqual({ runs: 2, tokens: 1700 })
    expect(store.evaluationSpend('2026-09-27T00:00:00Z', 'codex')).toEqual({ runs: 1, tokens: 200 })
    expect(store.evaluationSpend('2026-09-29T00:00:00Z')).toEqual({ runs: 0, tokens: 0 })
  })
})
