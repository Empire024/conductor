import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSpec } from '../../shared/models'
import type { DecisionRequest, ModelKey, SourceRef } from '../../shared/model-routing'
import type { AccountLimitWindow } from '../../shared/usage-accounting'
import type { ReviewAction } from '../approval-review'
import type { LocalModelRequest } from '../local-assist/contract'
import { outcome as outcomeRow } from './capture/common'
import { batchJobTokens, type EvaluationSuite } from './evaluation'
import { DEFAULT_FIXED_OVERHEAD_TOKENS, EvaluationRefused } from './evaluation-ports'
import { softmax } from './deciders/scorer'
import {
  CALLER_DECIDER_ID, callerFrontier, chosenOnTop, closeCandidates, createModelIntelligence, DEFAULT_EVALUATION_CAPS, DEFAULT_EXCLUDED_MODELS, EVALUATION_CAPS_SETTING, EXCLUDED_MODELS_SETTING,
  EVALUATION_OVERHEAD_PROFILE, EVALUATION_OVERHEAD_SETTING, excludedMatcher, LOCAL_DECIDER_UNAVAILABLE, routeUsage, usageVerdict, weeklyUsage, WEEKLY_STOP_SETTING, type ModelIntelligenceOptions
} from './index'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })
const settings = () => { const values = new Map<string, string>(); return { values, getSetting: (key: string) => values.get(key) ?? null, setSetting: (key: string, value: string) => { values.set(key, value) } } }
const noTimers = { every: () => () => {}, after: () => () => {} }
const NOW = new Date('2026-09-28T12:00:00Z')
const OPUS: ModelKey = { provider: 'claude', model: 'opus[1m]' }
const SOL: ModelKey = { provider: 'codex', model: 'gpt-5.6-sol' }
const QWEN: ModelKey = { provider: 'local', model: 'local/qwen3.6-35b-a3b' }
const FABLE: ModelKey = { provider: 'claude', model: 'claude-fable-5-1' }
const CONFIG: SourceRef = { kind: 'config', name: 'configured:test' }

function service(extra: Partial<ModelIntelligenceOptions> = {}, dbPath = ':memory:') {
  const clock = { now: NOW }
  const created = createModelIntelligence({ dbPath, settings: settings(), timers: noTimers, clock: () => clock.now, log: () => {}, ...extra })
  return { service: created, clock }
}
function register(s: ReturnType<typeof createModelIntelligence>, keys: Array<[ModelKey, string]>) {
  s.registry.applyBatch({ source: CONFIG, fetchedAt: NOW.toISOString(), complete: false, benchmarks: [], observations: keys.flatMap(([key, label]) => [
    { key, field: 'displayName' as const, value: label, source: CONFIG, observedAt: NOW.toISOString() },
    { key, field: 'availability' as const, value: 'available', source: CONFIG, observedAt: NOW.toISOString() }]) })
}
const window = (patch: Partial<AccountLimitWindow>): AccountLimitWindow => ({ bucket: 'b', key: 'k', label: 'Weekly', kind: 'weekly', scope: 'provider', usedPercent: 10, windowMinutes: 10_080, resetsAt: null, state: 'current', observedAt: NOW.toISOString(), ageSeconds: 5, source: { agentSessionId: 'a', projectId: 'p' }, ...patch })

describe('usage windows for routing (D5)', () => {
  it('ignores reset windows', () => {
    expect(usageVerdict([window({ usedPercent: 100, state: 'reset' })], { id: 'opus[1m]' }, 85)).toEqual({ percent: null, blocked: null })
  })
  it('applies a model-scoped window only to the models it selects', () => {
    const fable = window({ label: 'Fable weekly', scope: 'model', models: ['fable'], usedPercent: 99 })
    expect(usageVerdict([fable, window({ usedPercent: 40 })], { id: 'opus[1m]', label: 'Opus (1M context)' }, 85)).toEqual({ percent: 40, blocked: null })
    expect(usageVerdict([fable, window({ usedPercent: 40 })], { id: 'claude-fable-5-1', label: 'Fable' }, 85).blocked).toBe('Fable weekly usage 99% at or above the 85% weekly stop')
  })
  it('compares the weekly window with the weekly stop and a short window with 100 %', () => {
    const fiveHour = (usedPercent: number) => window({ label: '5-hour', kind: 'short', windowMinutes: 300, usedPercent })
    expect(usageVerdict([fiveHour(92), window({ usedPercent: 50 })], { id: 'opus' }, 85)).toEqual({ percent: 50, blocked: null })
    expect(usageVerdict([fiveHour(100), window({ usedPercent: 50 })], { id: 'opus' }, 85).blocked).toBe('5-hour usage 100% at or above its limit')
    expect(usageVerdict([fiveHour(10), window({ usedPercent: 85 })], { id: 'opus' }, 85).blocked).toBe('Weekly usage 85% at or above the 85% weekly stop')
    expect(usageVerdict([fiveHour(10), window({ usedPercent: 84 })], { id: 'opus' }, 85).blocked).toBeNull()
  })
  it('reads a current provider-wide weekly percent, or unknown', () => {
    expect(weeklyUsage([window({ usedPercent: 30 }), window({ usedPercent: 70, state: 'reset' }), window({ usedPercent: 90, kind: 'short' })])).toBe(30)
    expect(weeklyUsage([window({ usedPercent: 99, scope: 'model', models: ['fable'] })])).toBeNull()
  })
})

describe('the caller as the route frontier (D2)', () => {
  type Features = { complexity: number; risk: string }
  const request = (utilities: number[], features: Features = { complexity: 3, risk: 'medium' }, ids = [`${SOL.provider}/${SOL.model}`, 'claude/opus[1m]', 'local/qwen']): DecisionRequest => ({ kind: 'route', question: 'q', impact: 'routine', requester: 'test',
    state: { features: { category: 'summarization', ...features } }, options: ids.slice(0, utilities.length).map((id, index) => ({ id, label: id, facts: { utility: utilities[index]! } })) })
  const rank = (id: string) => id.startsWith('claude') ? 3 : id.startsWith('local') ? 0 : 1
  const decide = async (utilities: number[], features?: Features) => {
    const outcome = await callerFrontier(() => 0.15, rank).decide(request(utilities, features))
    if (!outcome.ok) throw new Error(outcome.reason)
    const [choice, confidence] = Object.entries(outcome.verdict.probabilities).sort((a, b) => b[1] - a[1])[0]!
    return { verdict: outcome.verdict, choice, confidence }
  }

  // N1: a close call keeps the top-utility (cheaper) pick unless the work is hard (complexity 4+) or high-risk.
  it.each([
    { cell: 'summarization, complexity 1, low risk', features: { complexity: 1, risk: 'low' }, choice: 'codex/gpt-5.6-sol' },
    { cell: 'simple coding, complexity 2, low risk', features: { complexity: 2, risk: 'low' }, choice: 'codex/gpt-5.6-sol' },
    { cell: 'frontend, complexity 3, medium risk', features: { complexity: 3, risk: 'medium' }, choice: 'codex/gpt-5.6-sol' },
    { cell: 'difficult coding, complexity 4, medium risk', features: { complexity: 4, risk: 'medium' }, choice: 'claude/opus[1m]' },
    { cell: 'complexity 5', features: { complexity: 5, risk: 'low' }, choice: 'claude/opus[1m]' },
    { cell: 'easy but high risk', features: { complexity: 1, risk: 'high' }, choice: 'claude/opus[1m]' },
  ])('$cell -> $choice', async ({ features, choice }) => {
    const utilities = [0.50, 0.42, 0.20]
    const decided = await decide(utilities, features)
    expect(decided.choice).toBe(choice)
    // N6: the confidence is the chosen candidate's own scorer probability, not 1 (floored at an even split,
    // below which no distribution can keep it on top).
    const probability = softmax(utilities)[[`${SOL.provider}/${SOL.model}`, 'claude/opus[1m]'].indexOf(choice)]!
    expect(decided.confidence).toBeCloseTo(Math.max(probability, 1 / 3), 5)
    expect(decided.confidence).toBeLessThan(1)
    expect(decided.verdict.rationale).toMatch(/^Close call between codex\/gpt-5\.6-sol \(0\.\d\d, capability 1\), claude\/opus\[1m\] \(0\.\d\d, capability 3\); the caller decides\./)
    expect(decided.verdict.rationale).not.toContain('local/qwen')
  })

  it('measures the close set in utility (not probability), best first, at most three', () => {
    // 0.50 against 0.40: 0.10 apart in utility but about 0.55 apart in softmax probability.
    expect(closeCandidates(request([0.50, 0.40, 0.20]), 0.15, rank).map(entry => entry.id)).toEqual(['codex/gpt-5.6-sol', 'claude/opus[1m]'])
    const five = request([0.40, 0.50, 0.45, 0.48, 0.44], undefined, ['a/1', 'b/2', 'c/3', 'd/4', 'e/5'])
    expect(closeCandidates(five, 0.15, rank).map(entry => entry.id)).toEqual(['b/2', 'd/4', 'c/3'])
  })

  it('keeps the chosen probability and puts it on top of a valid distribution', () => {
    const put = chosenOnTop({ a: 0.5, b: 0.4, c: 0.1 }, 'b')
    expect(put.b).toBeCloseTo(0.4, 9)
    expect(put.c).toBeCloseTo(0.2, 5)
    expect(put.a).toBeLessThan(put.b!)
    expect(Object.values(put).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9)
    const top = chosenOnTop({ a: 0.6, b: 0.3, c: 0.1 }, 'a')
    for (const [id, value] of Object.entries({ a: 0.6, b: 0.3, c: 0.1 })) expect(top[id]).toBeCloseTo(value, 9)
    const small = chosenOnTop({ a: 0.9, b: 0.05, c: 0.05 }, 'b')
    expect(Object.entries(small).sort((x, y) => y[1] - x[1])[0]![0]).toBe('b')
  })
  it('is the app frontier when no model port is wired: a close route is escalated to the caller, with the close set stored', async () => {
    const { service: s } = service()
    register(s, [[OPUS, 'Opus (1M context)'], [SOL, 'GPT-5.6 Sol']])
    const live = { offered: [OPUS, SOL], providerEnabled: () => true, usagePercent: () => null, loadedLocalModels: () => [] }
    const { decision } = await s.route({ category: 'review', complexity: 4, risk: 'high', toolsRequired: [], contextTokens: null }, {}, live, { requester: 'router.dispatch' })
    const record = s.store.decision(decision.decisionId)!
    if (record.escalated) {
      expect(record.decidedBy).toBe(CALLER_DECIDER_ID)
      expect(record.route!.closeCandidates!.map(entry => entry.id).sort()).toEqual(['claude/opus[1m]', 'codex/gpt-5.6-sol'])
      expect(decision.selected.key).toEqual(OPUS)
      expect(record.confidence).toBeLessThan(1)
    }
    expect(record.escalationReason).not.toBe('close call, no frontier configured')
    expect(record.route).toMatchObject({ selected: decision.selected, reasons: decision.reasons })
    expect(record.route!.fallback).toEqual(decision.fallback)
    s.dispose()
  })
})

describe('decisions, bindings and status', () => {
  it('stores route details with the decision, marks models.route runs as dry, and journals open attempts', async () => {
    const { service: s } = service()
    register(s, [[OPUS, 'Opus'], [SOL, 'Sol']])
    const live = { offered: [OPUS, SOL], providerEnabled: () => true, usagePercent: () => null, loadedLocalModels: () => [] }
    const features = { category: 'simple-coding' as const, complexity: 1 as const, risk: 'low' as const, toolsRequired: [], contextTokens: null }
    const dry = await s.route(features, {}, live, { requester: 'models.route' })
    const real = await s.route(features, {}, live, { requester: 'router.dispatch' })
    expect(s.store.decision(dry.decision.decisionId)).toMatchObject({ dryRun: true })
    expect(s.store.decisions({ since: '2020-01-01T00:00:00Z', limit: 10 }).map(record => record.id)).toEqual([real.decision.decisionId])
    expect(s.store.decisions({ since: '2020-01-01T00:00:00Z', limit: 10, includeDryRun: true })).toHaveLength(2)
    s.routeAttempt(real.decision.decisionId, { provider: 'local', model: 'qwen' }, 'Qwen is busy')
    s.routeAttempt(real.decision.decisionId, SOL)
    expect(s.store.decision(real.decision.decisionId)!.route!.attempts).toEqual([
      { key: { provider: 'local', model: 'local/qwen' }, ok: false, error: 'Qwen is busy', at: NOW.toISOString() }, { key: SOL, ok: true, at: NOW.toISOString() }])
    s.dispose()
  })

  it('keeps dispatch bindings across a restart, within 7 days', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-intel-service-')); dirs.push(dir)
    const path = join(dir, 'conductor.db')
    const first = service({}, path)
    first.service.bindDispatch('worker', { decisionId: 'decision_1', features: { category: 'debugging', complexity: 3, risk: 'medium', toolsRequired: [], contextTokens: null }, key: { provider: 'local', model: 'qwen' }, effort: null, projectId: 'project' })
    first.service.dispose()
    const second = service({}, path)
    expect(second.service.binding('worker')).toMatchObject({ decisionId: 'decision_1', key: { provider: 'local', model: 'local/qwen' }, projectId: 'project' })
    second.clock.now = new Date(NOW.getTime() + 8 * 86_400_000)
    expect(second.service.binding('worker')).toBeUndefined()
    second.service.dispose()
  })

  it('promotes a key to proven once its recent evidence reaches the proven count (D10)', () => {
    const { service: s } = service()
    register(s, [[SOL, 'Sol']])
    for (let index = 0; index < 11; index++) s.recordOutcome(outcomeRow({ key: SOL, source: 'turn', ref: `t${index}`, category: 'debugging', at: NOW.toISOString(), result: 'success' }))
    expect(s.registry.get(SOL)!.status).toBe('unproven')
    s.recordOutcome(outcomeRow({ key: SOL, source: 'turn', ref: 't11', category: 'debugging', at: NOW.toISOString(), result: 'failure' }))
    expect(s.registry.get(SOL)!.status).toBe('proven')
    s.dispose()
  })
})

describe('the local decider never starts a model server (D6)', () => {
  it('asks the shared runner with noStart and exposes none of its measurements', async () => {
    const asked: LocalModelRequest[] = []
    const runner = { ask: async (request: LocalModelRequest) => { asked.push(request); return { ok: false as const, reason: 'no local model server is running, and this call never starts one' } },
      contextTokens: vi.fn(async () => 4096), promptTokens: vi.fn(async () => 10) }
    const { service: s } = service({ localRunner: runner, localServerRunning: () => true })
    const record = await s.decisions.decide({ kind: 'retry', question: 'Retry?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], state: {}, impact: 'routine', requester: 'test' })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ noStart: true })
    expect(record.verdicts[0]).toMatchObject({ decider: 'local-llm', failed: expect.stringContaining('never starts one') })
    expect(runner.contextTokens).not.toHaveBeenCalled()
    expect(runner.promptTokens).not.toHaveBeenCalled()
    s.dispose()
  })
  const action = { projectId: 'p', machineId: 'local', workerId: 'w', runtimeId: 'r', requestId: 'q', tool: 'Write', arguments: {}, paths: [], boundary: 'workspace-write', reason: 'x', sideEffects: [], ownerEvidence: 'o', authorizationId: 'a', native: {} } as ReviewAction
  const spec = { id: 'w', projectId: 'p', sessionId: 's', provider: 'claude', cwd: '.', title: 'W' } as AgentSpec
  it('skips the shadow and records the skip when no server runs, and uses a running one', async () => {
    let running = false
    const asked: LocalModelRequest[] = []
    const runner = { ask: async (request: LocalModelRequest) => { asked.push(request); return { ok: true as const, answer: { text: '{"probabilities":{"allow":0.9,"deny":0.05,"escalate":0.05},"rationale":"ok"}', model: 'local/qwen', inputTokens: 1, outputTokens: 1, durationMs: 5 } } } }
    const { service: s } = service({ localRunner: runner, localServerRunning: () => running })
    s.approvalShadow.reviewing(spec, action)
    expect(s.approvalShadow.stats()).toMatchObject({ skipped: 1 })
    expect(asked).toEqual([])
    running = true
    s.approvalShadow.reviewing(spec, { ...action, requestId: 'q2' })
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    s.dispose()
  })
  it('refuses every other local decision too while no server runs', async () => {
    const runner = { ask: vi.fn() }
    const { service: s } = service({ localRunner: runner, localServerRunning: () => false })
    const record = await s.decisions.decide({ kind: 'retry', question: 'Retry?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], state: {}, impact: 'routine', requester: 'test' })
    expect(runner.ask).not.toHaveBeenCalled()
    expect(record.verdicts[0]).toEqual({ decider: 'local-llm', failed: LOCAL_DECIDER_UNAVAILABLE })
    s.dispose()
  })
})

describe('cloud evaluation under the owner caps (gap 8)', () => {
  const suite: EvaluationSuite = { name: 'mini', jobs: [{ id: 'answer', category: 'simple-coding', complexity: 1, prompt: 'Say 42', grader: { kind: 'exact', expected: '42' } }] }
  function cloud(usage: number | null, configure?: (values: Map<string, string>) => void) {
    const store = settings()
    configure?.(store.values)
    const runCloud = vi.fn(async (..._args: unknown[]) => ({ answer: '42', tokens: 900 as number | null, costUsd: 0.01 as number | null, durationMs: 1000 }))
    const s = createModelIntelligence({ dbPath: ':memory:', settings: store, timers: noTimers, clock: () => NOW, log: () => {}, evaluation: { runCloud, usage: () => usage, suites: () => ({ mini: suite }) } })
    register(s, [[OPUS, 'Opus'], [{ provider: 'grok', model: 'grok-4.7' }, 'Grok']])
    return { s, runCloud }
  }
  it('skips when usage is unknown or at the weekly stop, and when a provider has no stop', async () => {
    await expect(cloud(null).s.startEvaluation(OPUS, 'mini')).rejects.toThrow(/usage is unknown/)
    await expect(cloud(85).s.startEvaluation(OPUS, 'mini')).rejects.toThrow(/at or above the 85% stop/)
    await expect(cloud(10).s.startEvaluation({ provider: 'grok', model: 'grok-4.7' }, 'mini')).rejects.toThrow(/No weekly stop is set for grok/)
  })
  it('enforces the daily count and token caps from settings and hands the run its token budget', async () => {
    const { s, runCloud } = cloud(10)
    for (let index = 0; index < 2; index++) s.store.recordEvaluationSpend({ runId: `r${index}`, key: OPUS, at: NOW.toISOString(), tokens: 50_000, jobs: 1, gradedJobs: 1, stoppedBy: null })
    s.store.recordEvaluationSpend({ runId: 'local-run', key: QWEN, at: NOW.toISOString(), tokens: 999_999, jobs: 1, gradedJobs: 1, stoppedBy: null })
    // 100k spent: the third run gets the 50k left of the day, not the 60k run cap.
    const handle = await s.startEvaluation(OPUS, 'mini')
    expect(handle.maxTokens).toBe(DEFAULT_EVALUATION_CAPS.perDayTokens - 100_000)
    await vi.waitFor(() => expect(s.evaluation(handle.runId)!.state).not.toBe('running'))
    // The job ran with its budget (evaluation.ts hands the cloud port { maxTokens }).
    expect(runCloud.mock.calls[0]![3]).toEqual({ maxTokens: expect.any(Number) })
    // The run itself journaled its spend (evaluation.ts recordSpend): three today, the cap.
    expect(s.store.evaluationSpend('2026-09-27T12:00:00Z').runs).toBe(3)
    await expect(s.startEvaluation(OPUS, 'mini')).rejects.toThrow(/3 cloud evaluations ran in the last 24 h; the cap is 3/)
  })
  it('caps a run at what is left of the day and refuses one below the 45k floor (the default overhead plus a job) (N2, N14)', async () => {
    const over = cloud(10)
    over.s.store.recordEvaluationSpend({ runId: 'x', key: OPUS, at: NOW.toISOString(), tokens: 105_001, jobs: 1, gradedJobs: 1, stoppedBy: null })
    await expect(over.s.startEvaluation(OPUS, 'mini')).rejects.toThrow(/used 105001 tokens in the last 24 h; 44999 of the daily 150000 are left, below the 45000 a run needs/)
    const edge = cloud(10)
    edge.s.store.recordEvaluationSpend({ runId: 'x', key: OPUS, at: NOW.toISOString(), tokens: 105_000, jobs: 1, gradedJobs: 1, stoppedBy: null })
    expect((await edge.s.startEvaluation(OPUS, 'mini')).maxTokens).toBe(45_000)
    const tight = cloud(10, values => values.set(EVALUATION_CAPS_SETTING, JSON.stringify({ perDayTokens: 1000 })))
    await expect(tight.s.startEvaluation(OPUS, 'mini')).rejects.toThrow(/1000 of the daily 1000 are left, below the 45000 a run needs/)
    expect(tight.s.evaluationCaps()).toMatchObject({ perDayTokens: 1000, perRunTokens: 60_000, minRunTokens: 45_000, weeklyStop: { claude: 85, codex: 55 } })
    // A per-run cap below any native turn's overhead can never hold a job: refused, not run.
    const small = cloud(10, values => values.set(EVALUATION_CAPS_SETTING, JSON.stringify({ perRunTokens: 1000, perDayTokens: 1000 })))
    await expect(small.s.startEvaluation(OPUS, 'mini')).rejects.toThrow(/A 1000-token run cannot hold a claude turn's 5000 fixed tokens plus the smallest job's \d+; raise perRunTokens in model-intelligence:evaluation-caps to at least \d+; no run was counted/)
    expect(small.s.store.evaluationSpend('2026-09-27T12:00:00Z').runs).toBe(0)
  })
  it('never lets a learned overhead lock a provider out, and refuses a run that cannot fit before it counts (N14)', async () => {
    const smallest = batchJobTokens({ id: 'answer', category: 'simple-coding', complexity: 1, prompt: 'Say 42', grader: { kind: 'exact', expected: '42' } })
    // A multi-call turn learned 500k as the "overhead" under the old code: read back, it is bounded so a full run still holds one job.
    const locked = cloud(10, values => values.set(EVALUATION_OVERHEAD_SETTING, JSON.stringify({ claude: { tokens: 500_000, at: NOW.toISOString(), profile: EVALUATION_OVERHEAD_PROFILE } })))
    expect(locked.s.fixedOverheadTokens('claude')).toBe(60_000)
    locked.runCloud.mockImplementation(async () => ({ answer: '42', tokens: 41_000, costUsd: null, durationMs: 1, overheadTokens: 39_000 }))
    const full = await locked.s.startEvaluation(OPUS, 'mini')
    expect(full.maxTokens).toBe(60_000)
    await vi.waitFor(() => expect(locked.s.evaluation(full.runId)!.state).not.toBe('running'))
    // The next real turn re-measured it.
    expect(locked.s.fixedOverheadTokens('claude')).toBe(39_000)
    // A turn whose input is huge is learned bounded; the raw measurement is kept beside it.
    const huge = cloud(10)
    huge.runCloud.mockImplementation(async () => ({ answer: '42', tokens: 41_000, costUsd: null, durationMs: 1, overheadTokens: 250_000 }))
    const run = await huge.s.startEvaluation(OPUS, 'mini')
    await vi.waitFor(() => expect(huge.s.evaluation(run.runId)!.state).not.toBe('running'))
    expect(JSON.parse(huge.s.decisions['ports'].settings.getSetting(EVALUATION_OVERHEAD_SETTING)!)).toEqual({ claude: { tokens: 60_000 - smallest, measured: 250_000, at: NOW.toISOString(), profile: EVALUATION_OVERHEAD_PROFILE } })
    // What is left of the day cannot hold that overhead plus a job: refused before the run is counted, the runner never called.
    huge.runCloud.mockClear()
    huge.s.store.recordEvaluationSpend({ runId: 'earlier', key: OPUS, at: NOW.toISOString(), tokens: 60_000, jobs: 1, gradedJobs: 1, stoppedBy: null })
    const before = huge.s.store.evaluationSpend('2026-09-27T12:00:00Z')
    await expect(huge.s.startEvaluation(OPUS, 'mini')).rejects.toThrow(new RegExp(`A ${150_000 - before.tokens}-token run cannot hold a claude turn's 250000 fixed tokens \\(measured ${NOW.toISOString()}\\) plus the smallest job's ${smallest}; the day has ${150_000 - before.tokens} of its 150000 left; raise perRunTokens`))
    expect(huge.s.store.evaluationSpend('2026-09-27T12:00:00Z')).toEqual(before)
    expect(huge.runCloud).not.toHaveBeenCalled()
    // And a small learned value is raised to the band's floor.
    const tiny = cloud(10, values => values.set(EVALUATION_OVERHEAD_SETTING, JSON.stringify({ claude: { tokens: 12, at: NOW.toISOString(), profile: EVALUATION_OVERHEAD_PROFILE } })))
    expect(tiny.s.fixedOverheadTokens('claude')).toBe(5_000)
  })
  it('admits on the recent raw measurement: a cap below the real overhead refuses instead of starting a doomed turn (N19)', async () => {
    const smallest = batchJobTokens(suite.jobs[0]!), measuredAt = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString()
    const capped = (hoursAgo: number) => cloud(10, values => {
      values.set(EVALUATION_CAPS_SETTING, JSON.stringify({ perRunTokens: 30_000 }))
      values.set(EVALUATION_OVERHEAD_SETTING, JSON.stringify({ claude: { tokens: 30_000 - smallest, measured: 39_115, at: measuredAt(hoursAgo), profile: EVALUATION_OVERHEAD_PROFILE } }))
    })
    // reverify4: measured 39,115 two hours ago, the run cap 30k. Refused with the reason; nothing runs or counts.
    const recent = capped(2)
    await expect(recent.s.startEvaluation(OPUS, 'mini')).rejects.toThrow(new RegExp(`A 30000-token run cannot hold a claude turn's 39115 fixed tokens \\(measured ${measuredAt(2)}\\) plus the smallest job's ${smallest}; raise perRunTokens in model-intelligence:evaluation-caps to at least ${39_115 + smallest}, or from ${new Date(Date.parse(measuredAt(2)) + 24 * 3_600_000).toISOString()} one run measures it again; no run was counted`))
    expect(recent.runCloud).not.toHaveBeenCalled()
    expect(recent.s.store.evaluationSpend('2026-09-27T12:00:00Z').runs).toBe(0)
    // A day-old measurement may predate a CLI or Conductor update: one run is admitted and measures the preamble again,
    // and the run after it is refused on that measurement.
    const stale = capped(25)
    stale.runCloud.mockImplementation(async () => ({ answer: '', tokens: 39_353, costUsd: null, durationMs: 1, overheadTokens: 39_115 }))
    const run = await stale.s.startEvaluation(OPUS, 'mini')
    expect(run.maxTokens).toBe(30_000)
    await vi.waitFor(() => expect(stale.s.evaluation(run.runId)!.state).not.toBe('running'))
    await expect(stale.s.startEvaluation(OPUS, 'mini')).rejects.toThrow(/cannot hold a claude turn's 39115 fixed tokens \(measured 2026-/)
    expect(stale.runCloud).toHaveBeenCalledTimes(1)
    // A measurement that fits is admitted as before (a legacy entry without `measured` never refuses: the N14 test above).
    const fits = cloud(10, values => values.set(EVALUATION_OVERHEAD_SETTING, JSON.stringify({ claude: { tokens: 39_115, measured: 39_115, at: measuredAt(1), profile: EVALUATION_OVERHEAD_PROFILE } })))
    expect((await fits.s.startEvaluation(OPUS, 'mini')).maxTokens).toBe(60_000)
  })
  it('ignores an overhead measured before the lean evaluation profile and measures it again (B5-H)', async () => {
    const smallest = batchJobTokens(suite.jobs[0]!)
    // reverify: a full native tab measured 51,491 an hour ago; a 30k cap would refuse on it, but that preamble is gone.
    const old = cloud(10, values => {
      values.set(EVALUATION_CAPS_SETTING, JSON.stringify({ perRunTokens: 30_000 }))
      values.set(EVALUATION_OVERHEAD_SETTING, JSON.stringify({ claude: { tokens: 30_000 - smallest, measured: 51_491, at: new Date(NOW.getTime() - 3_600_000).toISOString() }, codex: { tokens: 45_000, measured: 45_000, at: NOW.toISOString(), profile: 'full-0' } }))
    })
    // Both read as unmeasured: the 40k default, bounded by the 30k run cap.
    expect(DEFAULT_FIXED_OVERHEAD_TOKENS).toBeGreaterThan(30_000)
    expect(old.s.fixedOverheadTokens('claude')).toBe(30_000)
    expect(old.s.fixedOverheadTokens('codex')).toBe(30_000)
    old.runCloud.mockImplementation(async () => ({ answer: '42', tokens: 13_000, costUsd: null, durationMs: 1, overheadTokens: 12_345 }))
    const run = await old.s.startEvaluation(OPUS, 'mini')
    expect(run.maxTokens).toBe(30_000)
    await vi.waitFor(() => expect(old.s.evaluation(run.runId)!.state).not.toBe('running'))
    expect(old.s.fixedOverheadTokens('claude')).toBe(12_345)
    expect(JSON.parse(old.s.decisions['ports'].settings.getSetting(EVALUATION_OVERHEAD_SETTING)!)).toEqual({ claude: { tokens: 12_345, measured: 12_345, at: NOW.toISOString(), profile: EVALUATION_OVERHEAD_PROFILE } })
  })
  it('refuses a cloud run of a suite whose jobs all need a command runner', async () => {
    const onlyCommands: EvaluationSuite = { name: 'commands', jobs: [{ id: 'check', category: 'simple-coding', complexity: 1, prompt: 'Write add.js', grader: { kind: 'command', cmd: 'node', args: ['test.mjs'], expectExit: 0, timeoutSec: 10 } }] }
    const runCloud = vi.fn(async () => ({ answer: '42', tokens: 900, costUsd: null, durationMs: 1 }))
    const s = createModelIntelligence({ dbPath: ':memory:', settings: settings(), timers: noTimers, clock: () => NOW, log: () => {}, evaluation: { runCloud, usage: () => 10, suites: () => ({ commands: onlyCommands }) } })
    register(s, [[OPUS, 'Opus']])
    await expect(s.startEvaluation(OPUS, 'commands')).rejects.toThrow(/No job of commands can be graded in a cloud run/)
    expect(s.store.evaluationSpend('2026-09-27T12:00:00Z').runs).toBe(0)
  })
  it('with a command runner, a cloud run takes the command jobs into its one batched turn and grades them by their checks', async () => {
    const mixed: EvaluationSuite = { name: 'mixed', jobs: [
      { id: 'check', category: 'simple-coding', complexity: 1, prompt: 'Write add.js', grader: { kind: 'command', cmd: 'node', args: ['test.mjs'], expectExit: 0, timeoutSec: 10, answerFile: 'add.mjs' } },
      { id: 'plain', category: 'general', complexity: 1, prompt: 'Say 42', grader: { kind: 'exact', expected: '42' } },
    ] }
    const runCloud = vi.fn(async () => ({ answer: '### JOB check\n```js\nexport const add = 1\n```\n### JOB plain\n42', tokens: 9_000, costUsd: null, durationMs: 1 }))
    const checks: string[] = []
    const command = vi.fn(async () => async (request: { files: Record<string, string> }) => { checks.push(request.files['add.mjs']!); return { exitCode: 0 } })
    const s = createModelIntelligence({ dbPath: ':memory:', settings: settings(), timers: noTimers, clock: () => NOW, log: () => {}, evaluation: { runCloud, command, usage: () => 10, suites: () => ({ mixed }) } })
    register(s, [[OPUS, 'Opus']])
    const run = await s.startEvaluation(OPUS, 'mixed')
    expect(run.notGradable).toEqual([])
    await vi.waitFor(() => expect(s.evaluation(run.runId)!.state).toBe('done'))
    expect(runCloud).toHaveBeenCalledTimes(1)
    expect(s.evaluation(run.runId)!.result!.jobs.map(job => [job.id, job.result])).toEqual([['check', 'success'], ['plain', 'success']])
    expect(checks).toEqual(['export const add = 1\n'])
  })
  it('validates an evaluation-caps weeklyStop override: a malformed value never disables the stop (N17)', async () => {
    const bad = cloud(86, values => values.set(EVALUATION_CAPS_SETTING, JSON.stringify({ weeklyStop: { codex: 'x', claude: 150, grok: -1 } })))
    expect(bad.s.evaluationCaps().weeklyStop).toEqual({ claude: 85, codex: 55 })
    await expect(bad.s.startEvaluation(OPUS, 'mini')).rejects.toThrow(/claude is at 86% of its week, at or above the 85% stop/)
    const garbage = cloud(10, values => values.set(EVALUATION_CAPS_SETTING, JSON.stringify({ weeklyStop: 'off' })))
    expect(garbage.s.evaluationCaps().weeklyStop).toEqual({ claude: 85, codex: 55 })
    const good = cloud(10, values => values.set(EVALUATION_CAPS_SETTING, JSON.stringify({ weeklyStop: { codex: 70, claude: 'x' } })))
    expect(good.s.evaluationCaps().weeklyStop).toEqual({ claude: 85, codex: 70 })
  })
  it('three runs that each spend their whole cap stay within the daily token cap', async () => {
    // Each run's one turn spends exactly the budget it is handed (the whole run cap); no fixed overhead, so every cap fits the job.
    const big: EvaluationSuite = { name: 'big', jobs: [{ id: 'big', category: 'simple-coding', complexity: 5, prompt: 'Say 42', maxTokens: 1_000, grader: { kind: 'exact', expected: '42' } }] }
    const runCloud = vi.fn(async (..._args: unknown[]) => ({ answer: '42', tokens: (_args[3] as { maxTokens: number }).maxTokens, costUsd: null, durationMs: 1 }))
    const store = settings()
    // The smallest overhead the band allows, and a floor that lets the day's 30k remainder run.
    store.values.set(EVALUATION_OVERHEAD_SETTING, JSON.stringify({ claude: { tokens: 0, at: NOW.toISOString(), profile: EVALUATION_OVERHEAD_PROFILE } }))
    store.values.set(EVALUATION_CAPS_SETTING, JSON.stringify({ minRunTokens: 20_000 }))
    const s = createModelIntelligence({ dbPath: ':memory:', settings: store, timers: noTimers, clock: () => NOW, log: () => {}, evaluation: { runCloud, usage: () => 10, suites: () => ({ big }) } })
    register(s, [[OPUS, 'Opus']])
    const caps: number[] = []
    for (let index = 0; index < 3; index++) {
      const handle = await s.startEvaluation(OPUS, 'big')
      caps.push(handle.maxTokens!)
      await vi.waitFor(() => expect(s.evaluation(handle.runId)!.state).not.toBe('running'))
    }
    expect(caps).toEqual([60_000, 60_000, 30_000])
    expect(s.store.evaluationSpend('2026-09-27T12:00:00Z')).toEqual({ runs: 3, tokens: DEFAULT_EVALUATION_CAPS.perDayTokens })
    await expect(s.startEvaluation(OPUS, 'big')).rejects.toThrow(/3 cloud evaluations ran/)
    s.dispose()
  })
  it('learns each provider\'s fixed turn overhead, keeps it in settings and hands it to evaluate() (N9)', async () => {
    const { s, runCloud } = cloud(10)
    expect(s.fixedOverheadTokens('claude')).toBe(40_000)
    runCloud.mockImplementation(async () => ({ answer: '42', tokens: 900, costUsd: null, durationMs: 1, overheadTokens: 38_500 }))
    const handle = await s.startEvaluation(OPUS, 'mini')
    await vi.waitFor(() => expect(s.evaluation(handle.runId)!.state).not.toBe('running'))
    expect(s.fixedOverheadTokens('claude')).toBe(38_500)
    expect(s.fixedOverheadTokens('codex')).toBe(40_000)
    expect(JSON.parse(s.decisions['ports'].settings.getSetting(EVALUATION_OVERHEAD_SETTING)!)).toEqual({ claude: { tokens: 38_500, measured: 38_500, at: NOW.toISOString(), profile: EVALUATION_OVERHEAD_PROFILE } })
    // A failed turn that reported its input still teaches the overhead.
    runCloud.mockImplementation(async () => { throw Object.assign(new Error('the evaluation turn ended failed'), { tokens: 6_000, overheadTokens: 41_000 }) })
    const next = await s.startEvaluation(OPUS, 'mini')
    await vi.waitFor(() => expect(s.evaluation(next.runId)!.state).not.toBe('running'))
    expect(s.fixedOverheadTokens('claude')).toBe(41_000)
  })
  it('counts a usage-less cloud job at its budget, never an estimate (N3)', async () => {
    const silent = cloud(10)
    silent.runCloud.mockImplementation(async () => ({ answer: '42', tokens: null, costUsd: null, durationMs: 1 }))
    const second = await silent.s.startEvaluation(OPUS, 'mini')
    await vi.waitFor(() => expect(silent.s.evaluation(second.runId)!.state).not.toBe('running'))
    expect(silent.s.evaluation(second.runId)!.result).toMatchObject({ tokens: (silent.runCloud.mock.calls[0]![3] as { maxTokens: number }).maxTokens })
  })
  it('never evaluates a key on the owner exclusion list (N5)', async () => {
    const { s, runCloud } = cloud(10)
    register(s, [[FABLE, 'Claude Fable 5.1']])
    await expect(s.startEvaluation(FABLE, 'mini')).rejects.toThrow(/claude\/claude-fable-5-1 is excluded by owner setting \(model-intelligence:excluded-models: claude\/claude-fable-5-1\*\)/)
    expect(runCloud).not.toHaveBeenCalled()
  })
})

describe('one weekly usage stop for routing and evaluation', () => {
  const ASTRA: ModelKey = { provider: 'codex', model: 'gpt-6-astra' }, LUNA: ModelKey = { provider: 'codex', model: 'gpt-6-luna' }, SONNET: ModelKey = { provider: 'claude', model: 'sonnet' }
  const HARD = { category: 'difficult-coding' as const, complexity: 5 as const, risk: 'high' as const, toolsRequired: [], contextTokens: null }
  /** The running app's shape: Claude and Codex tiers plus a local model, live facts built as AgentControl.routeLive builds them. */
  function liveShaped(codexWeekly: number, configure?: (values: Map<string, string>) => void) {
    const store = settings()
    configure?.(store.values)
    const s = createModelIntelligence({ dbPath: ':memory:', settings: store, timers: noTimers, clock: () => NOW, log: () => {} })
    register(s, [[OPUS, 'Claude Opus 5.5 (1M context)'], [SONNET, 'Claude Sonnet 5'], [ASTRA, 'GPT-6-Astra'], [LUNA, 'GPT-6-Luna'], [QWEN, 'Qwen3.6 35B-A3B (local)']])
    const windows = (provider: string) => provider === 'codex' ? [window({ label: 'Codex weekly', usedPercent: codexWeekly })] : provider === 'claude' ? [window({ label: 'Claude weekly', usedPercent: 30 })] : []
    const live = { offered: [OPUS, SONNET, ASTRA, LUNA, QWEN], providerEnabled: () => true, loadedLocalModels: () => [], ...routeUsage(windows, key => key.model, provider => s.weeklyStop(provider)) }
    return { s, store, live }
  }

  it('defaults to the owner stops (Claude 85, Codex 55), reads the setting, and treats an unnamed provider as 95', () => {
    const { s, store } = liveShaped(10)
    expect([s.weeklyStop('claude'), s.weeklyStop('codex'), s.weeklyStop('grok')]).toEqual([85, 55, 95])
    store.values.set(WEEKLY_STOP_SETTING, JSON.stringify({ codex: 70, grok: 80, claude: 'x' }))
    expect([s.weeklyStop('claude'), s.weeklyStop('codex'), s.weeklyStop('grok')]).toEqual([85, 70, 80])
    store.values.set(WEEKLY_STOP_SETTING, 'not json')
    expect(s.weeklyStop('codex')).toBe(55)
    s.dispose()
  })

  it('live-shaped: with Codex at or above 55 % of its week, hard work goes to Opus with a non-Codex fallback, and the route says Codex is blocked', async () => {
    for (const percent of [55, 80]) {
      const { s, live } = liveShaped(percent)
      const { decision, explanation } = await s.route(HARD, {}, live, { requester: 'models.route' })
      expect(decision.selected.key).toEqual(OPUS)
      // Codex is blocked and the unproven local model is not eligible for complexity 5, high risk: the fallback stays on Claude (builder C, same-provider fallback).
      expect(decision.fallback?.key.provider).toBe('claude')
      expect(decision.fallback?.reason).toMatch(/^no other provider eligible (.*); same-provider fallback/)
      expect(decision.candidates.filter(candidate => candidate.key.provider === 'codex').every(candidate => !candidate.eligible)).toBe(true)
      expect(decision.reasons).toContain(`codex blocked by its usage stop: Codex weekly usage ${percent}% at or above the 55% weekly stop`)
      expect(explanation).toContain('codex blocked by its usage stop')
      s.dispose()
    }
  })

  it('falls back to another unblocked provider, never to the blocked Codex', async () => {
    const { s: svc, live } = liveShaped(60)
    const GROK: ModelKey = { provider: 'grok', model: 'grok-4.7' }
    register(svc, [[GROK, 'Grok 4.7']])
    const { decision } = await svc.route(HARD, {}, { ...live, offered: [...live.offered, GROK] }, { requester: 'models.route' })
    expect(decision.selected.key).toEqual(OPUS)
    expect(decision.fallback?.key).toEqual(GROK)
    svc.dispose()
  })

  it('below the stop Codex stays eligible and nothing is blocked; the setting moves the stop for routing', async () => {
    const below = liveShaped(54)
    const { decision } = await below.s.route(HARD, {}, below.live, { requester: 'models.route' })
    expect(decision.candidates.find(candidate => candidate.key.model === ASTRA.model)?.eligible).toBe(true)
    expect(decision.reasons.some(reason => reason.includes('blocked by its usage stop'))).toBe(false)
    below.s.dispose()
    const raised = liveShaped(60, values => values.set(WEEKLY_STOP_SETTING, JSON.stringify({ codex: 90 })))
    expect((await raised.s.route(HARD, {}, raised.live, { requester: 'models.route' })).decision.candidates.find(candidate => candidate.key.model === ASTRA.model)?.eligible).toBe(true)
    raised.s.dispose()
  })

  it('applies the stop when the caller\'s live facts carry only a provider percent', async () => {
    const { s } = liveShaped(60)
    const bare = { offered: [OPUS, SONNET, ASTRA, LUNA], providerEnabled: () => true, loadedLocalModels: () => [], usagePercent: (provider: string) => provider === 'codex' ? 60 : 30 }
    const { decision } = await s.route(HARD, {}, bare, { requester: 'models.route' })
    expect(decision.selected.key.provider).toBe('claude')
    expect(decision.reasons).toContain('codex blocked by its usage stop: usage 60% at or above the 55% stop')
    s.dispose()
  })

  it('evaluation reads the same stop; evaluation-caps.weeklyStop overrides it for evaluation only', async () => {
    const suite: EvaluationSuite = { name: 'mini', jobs: [{ id: 'answer', category: 'simple-coding', complexity: 1, prompt: 'Say 42', grader: { kind: 'exact', expected: '42' } }] }
    const make = (usage: number, configure: (values: Map<string, string>) => void) => {
      const store = settings()
      configure(store.values)
      const runCloud = vi.fn(async () => ({ answer: '42', tokens: 900, costUsd: null, durationMs: 1 }))
      const s = createModelIntelligence({ dbPath: ':memory:', settings: store, timers: noTimers, clock: () => NOW, log: () => {}, evaluation: { runCloud, usage: () => usage, suites: () => ({ mini: suite }) } })
      register(s, [[ASTRA, 'GPT-6-Astra']])
      return s
    }
    await expect(make(60, () => {}).startEvaluation(ASTRA, 'mini')).rejects.toThrow(/codex is at 60% of its week, at or above the 55% stop/)
    await expect(make(60, values => values.set(WEEKLY_STOP_SETTING, JSON.stringify({ codex: 50 }))).startEvaluation(ASTRA, 'mini')).rejects.toThrow(/at or above the 50% stop/)
    const override = make(60, values => { values.set(WEEKLY_STOP_SETTING, JSON.stringify({ codex: 50 })); values.set(EVALUATION_CAPS_SETTING, JSON.stringify({ weeklyStop: { codex: 70 } })) })
    expect((await override.startEvaluation(ASTRA, 'mini')).state).toBe('running')
    expect(override.evaluationCaps().weeklyStop).toMatchObject({ claude: 85, codex: 70 })
    expect(override.weeklyStop('codex')).toBe(50)
  })
})

describe('the owner exclusion list (N5)', () => {
  it('matches globs on the key id, case-insensitively', () => {
    const excluded = excludedMatcher(DEFAULT_EXCLUDED_MODELS)
    expect(excluded(FABLE)).toBe('claude/claude-fable-5-1*')
    expect(excluded({ provider: 'claude', model: 'Fable-Next' })).toBe('claude/*fable*')
    expect(excluded(OPUS)).toBeNull()
    expect(excluded({ provider: 'openrouter', model: 'anthropic/claude-fable-5' })).toBeNull()
    expect(excludedMatcher(['local/*'])(QWEN)).toBe('local/*')
    expect(excludedMatcher(['codex/gpt-5.?-sol'])(SOL)).toBe('codex/gpt-5.?-sol')
  })
  it('drops excluded keys before routing and says so in the route, also against an allow-list; [] excludes nothing', async () => {
    const { service: s } = service()
    register(s, [[OPUS, 'Opus'], [FABLE, 'Claude Fable 5.1']])
    const live = { offered: [OPUS, FABLE], providerEnabled: () => true, usagePercent: () => null, loadedLocalModels: () => [] }
    const features = { category: 'difficult-coding' as const, complexity: 5 as const, risk: 'high' as const, toolsRequired: [], contextTokens: null }
    const routed = await s.route(features, {}, live, { requester: 'models.route' })
    expect(routed.decision.selected.key).toEqual(OPUS)
    expect(routed.decision.candidates.map(candidate => candidate.key.model)).not.toContain(FABLE.model)
    expect(routed.decision.reasons).toContain('claude/claude-fable-5-1 excluded by owner setting (model-intelligence:excluded-models)')
    expect(routed.explanation).toContain('claude/claude-fable-5-1 excluded by owner setting')
    await expect(s.route(features, { allow: [FABLE] }, live, { requester: 'models.route' })).rejects.toThrow(/claude\/claude-fable-5-1 excluded by owner setting/)
    s.decisions['ports'].settings.setSetting(EXCLUDED_MODELS_SETTING, '[]')
    expect(s.excludedModels()).toEqual([])
    const allowed = await s.route(features, { allow: [FABLE] }, live, { requester: 'models.route' })
    expect(allowed.decision.selected.key).toEqual(FABLE)
    s.dispose()
  })
  it('falls back to the defaults when the setting is unreadable', () => {
    const { service: s } = service()
    s.decisions['ports'].settings.setSetting(EXCLUDED_MODELS_SETTING, '{"not":"a list"}')
    expect(s.excludedModels()).toEqual([...DEFAULT_EXCLUDED_MODELS])
    s.dispose()
  })
})

describe('a cloud evaluation refused before any model call (B5-G)', () => {
  const suite: EvaluationSuite = { name: 'mini', jobs: [{ id: 'answer', category: 'simple-coding', complexity: 1, prompt: 'Say 42', grader: { kind: 'exact', expected: '42' } }] }
  const refusal = 'claude/opus[1m] is not offered on this machine now; models.list shows what is, or omit route and name provider and model'
  function cloud(reports: Record<string, string> = {}) {
    const runCloud = vi.fn(async (..._args: unknown[]): Promise<{ answer: string; tokens: number | null; costUsd: number | null; durationMs: number }> => { throw new EvaluationRefused(refusal) })
    const s = createModelIntelligence({ dbPath: ':memory:', settings: settings(), timers: noTimers, clock: () => NOW, log: () => {}, evaluation: { runCloud, usage: () => 10, suites: () => ({ mini: suite }), readReport: runId => reports[runId] ?? null } })
    register(s, [[OPUS, 'Opus']])
    return { s, runCloud }
  }

  it('spends nothing, is not one of the day\'s runs, and says why; the turn gets the caller\'s scope', async () => {
    const { s, runCloud } = cloud()
    for (let index = 0; index < 4; index++) {
      const handle = await s.startEvaluation(OPUS, 'mini', { scope: { projectId: 'p1', workspaceId: 'w2' } })
      await vi.waitFor(() => expect(s.evaluation(handle.runId)!.state).toBe('done'))
      expect(s.evaluation(handle.runId)!.result).toMatchObject({ tokens: 0, stoppedBy: 'refused', reason: refusal, outcomes: [] })
    }
    // Four refused runs, and the three-a-day cap still has all its runs and tokens.
    expect(s.store.evaluationSpend('2026-09-27T12:00:00Z')).toEqual({ runs: 0, tokens: 0 })
    expect(runCloud.mock.calls[0]![4]).toEqual({ scope: { projectId: 'p1', workspaceId: 'w2' } })
    // Nothing was measured, so the overhead is not learned from a refusal.
    expect(s.fixedOverheadTokens('claude')).toBe(40_000)
    s.dispose()
  })
  it('releases, once, a journaled run whose report shows its one turn refused, and keeps every real charge', () => {
    const phantomReport = ['## Jobs', '', '| Job | Category | Result | Detail | Time | Cost |', '| --- | --- | --- | --- | --- | --- |',
      `| answer | simple-coding | not-gradable | not graded: the batched turn failed: ${refusal} | 0 s | — |`, ''].join('\n')
    const failedReport = phantomReport.replace(refusal, 'the evaluation turn ended failed')
    const { s } = cloud({ phantom: phantomReport, failed: failedReport, graded: phantomReport })
    const at = NOW.toISOString(), base = { key: OPUS, at, costUsd: 0, jobs: 1, gradedJobs: 0, stoppedBy: 'token-cap' as const }
    s.store.recordEvaluationSpend({ ...base, runId: 'phantom', tokens: 60_000 })
    s.store.recordEvaluationSpend({ ...base, runId: 'failed', tokens: 60_000 })
    s.store.recordEvaluationSpend({ ...base, runId: 'graded', tokens: 45_000, gradedJobs: 1 })
    s.store.recordEvaluationSpend({ ...base, runId: 'no-report', tokens: 30_000 })
    expect(s.store.evaluationSpend('2026-09-27T12:00:00Z')).toEqual({ runs: 4, tokens: 195_000 })
    expect(s.reconcileRefusedEvaluations()).toEqual(['phantom'])
    expect(s.store.evaluationSpend('2026-09-27T12:00:00Z')).toEqual({ runs: 3, tokens: 135_000 })
    expect(s.store.evaluationRuns('2026-09-27T12:00:00Z').find(spend => spend.runId === 'phantom')).toMatchObject({ tokens: 0, stoppedBy: 'refused', reason: refusal })
    expect(s.reconcileRefusedEvaluations()).toEqual([])
    s.dispose()
  })
})
