import { describe, expect, it, vi } from 'vitest'
import type { AgentSpec } from '../../shared/models'
import type { DurableJob, DurableJobStage } from '../../shared/durable-jobs'
import type { Decider, DeciderOutcome, DecisionRequest, ModelKey, SourceRef } from '../../shared/model-routing'
import type { ReviewAction, ReviewRecord } from '../approval-review'
import type { LoopGuardPort, StageObservation } from '../durable-jobs/ports'
import { withStageCapture } from './app-wiring'
import { createLayaDecider, layaQuestion, type LayaPort } from './deciders/laya'
import { explainDecision } from './explain'
import { createModelIntelligence, type ModelIntelligenceOptions } from './index'

/** The CPU decision model in shadow (docs/model-routing.md, "CPU decider"): every kind is journaled with its verdict
 *  beside the decision the app made, and nothing it answers changes or delays that decision. */

const NOW = new Date('2026-09-29T12:00:00Z')
const OPUS: ModelKey = { provider: 'claude', model: 'opus[1m]' }
const SOL: ModelKey = { provider: 'codex', model: 'gpt-5.6-sol' }
const CONFIG: SourceRef = { kind: 'config', name: 'configured:test' }
const noTimers = { every: () => () => {}, after: () => () => {} }
const settings = () => { const values = new Map<string, string>(); return { values, getSetting: (key: string) => values.get(key) ?? null, setSetting: (key: string, value: string) => { values.set(key, value) } } }

/** A Laya port answering the first option unless told otherwise; `gate` holds every answer until released. */
function fakeLaya(answer: (questions: Record<string, unknown>) => Record<string, number> | Error = questions => {
  const keys = Object.keys((questions.decision as { criteria: Record<string, string> }).criteria)
  return Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 0.7 : 0.3 / Math.max(1, keys.length - 1)]))
}) {
  const calls: Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }> = []
  let release!: () => void
  const gate = { held: false, opened: new Promise<void>(resolve => { release = resolve }) }
  const port: LayaPort = {
    async predict(state, questions) {
      calls.push({ state, questions })
      if (gate.held) await gate.opened
      const result = answer(questions)
      if (result instanceof Error) throw result
      const choice = Object.entries(result).sort((a, b) => b[1] - a[1])[0]![0]
      return { answers: { decision: { type: 'choice', choice, probabilities: result, confidence: 0.4 } }, usage: { input_tokens: 120 }, inferenceMs: 412 }
    }
  }
  return { port, calls, hold: () => { gate.held = true }, release }
}

function service(port: LayaPort, extra: Partial<ModelIntelligenceOptions> = {}) {
  const logged: string[] = []
  const s = createModelIntelligence({ dbPath: ':memory:', settings: settings(), timers: noTimers, clock: () => NOW, log: message => { logged.push(message) }, decider: createLayaDecider(port), deciderAvailable: () => true, ...extra })
  s.registry.applyBatch({ source: CONFIG, fetchedAt: NOW.toISOString(), complete: false, benchmarks: [], observations: [[OPUS, 'Opus'], [SOL, 'Sol']].flatMap(([key, label]) => [
    { key: key as ModelKey, field: 'displayName' as const, value: label as string, source: CONFIG, observedAt: NOW.toISOString() },
    { key: key as ModelKey, field: 'availability' as const, value: 'available', source: CONFIG, observedAt: NOW.toISOString() }]) })
  return { s, logged }
}
const live = { offered: [OPUS, SOL], providerEnabled: () => true, usagePercent: () => null, loadedLocalModels: () => [] }
const HARD = { category: 'difficult-coding' as const, complexity: 5 as const, risk: 'high' as const, toolsRequired: [], contextTokens: null, summary: 'Refactor the approval gate' }

describe('Laya question mapping', () => {
  it('asks one typed choice, with neutral keys for model ids and each option described with its facts', () => {
    const asked = layaQuestion({ kind: 'route', question: 'Which model?', impact: 'routine', requester: 'router', state: { features: { category: 'review' } },
      options: [{ id: 'claude/opus[1m]', label: 'Opus', facts: { expectedSuccess: 0.781234, cost: null } }, { id: 'retry', label: 'Retry' }] })
    expect(asked.questions).toEqual({ decision: { type: 'choice', instructions: 'Which model?', criteria: { option_1: 'Opus; expectedSuccess 0.781', retry: 'Retry' } } })
    expect([...asked.keys]).toEqual([['option_1', 'claude/opus[1m]'], ['retry', 'retry']])
    expect(asked.state).toEqual({ kind: 'route', impact: 'routine', features: '{"category":"review"}' })
  })
  it('maps the answer back to option ids and reports failures as failed verdicts', async () => {
    const request: DecisionRequest = { kind: 'retry', question: 'Retry?', impact: 'routine', requester: 't', state: {}, options: [{ id: 'retry', label: 'r' }, { id: 'escalate', label: 'e' }] }
    const ok = await createLayaDecider(fakeLaya(() => ({ retry: 0.2, escalate: 0.8 })).port).decide(request)
    expect(ok).toMatchObject({ ok: true, verdict: { decider: 'laya:typed-decisions', probabilities: { retry: 0.2, escalate: 0.8 }, tokens: 120, elapsedMs: 412 } })
    expect(await createLayaDecider(fakeLaya(() => new Error('the decider did not answer within 20 s')).port).decide(request)).toEqual({ ok: false, decider: 'laya', reason: 'the decider did not answer within 20 s' })
    expect(await createLayaDecider(fakeLaya(() => ({ ghost: 1 })).port).decide(request)).toMatchObject({ ok: false, reason: /no offered option/ })
  })
})

describe('route shadow', () => {
  it('journals the decision model beside the scorer after the route stands, without delaying it', async () => {
    const laya = fakeLaya()
    laya.hold()
    const { s } = service(laya.port)
    const { decision } = await s.route(HARD, {}, live, { requester: 'router.dispatch' })
    // The route returned while the shadow is still waiting: it never waits for the decision model.
    const before = s.store.decision(decision.decisionId)!
    expect(before.shadow).toBeUndefined()
    expect(before.decidedBy).not.toMatch(/^laya/)
    laya.release()
    await s.shadowsSettled()
    const after = s.store.decision(decision.decisionId)!
    expect(after.choice).toBe(before.choice)
    expect(after.shadow).toMatchObject({ decider: 'laya:typed-decisions', choice: expect.any(String), elapsedMs: 412, at: NOW.toISOString() })
    expect(after.route?.selected).toEqual(before.route?.selected)
    expect(explainDecision(after)).toMatch(/Shadow \(laya:typed-decisions, journaled only\): .* at \d\.\d\d, (agrees|disagrees); 412 ms/)
    s.dispose()
  })
  it('journals a failed shadow verdict and logs nothing into the caller', async () => {
    const { s } = service(fakeLaya(() => new Error('decider unavailable: the decider venv is not set up')).port)
    const { decision } = await s.route(HARD, {}, live, { requester: 'router.dispatch' })
    await s.shadowsSettled()
    expect(s.store.decision(decision.decisionId)!.shadow).toMatchObject({ choice: null, failed: 'decider unavailable: the decider venv is not set up' })
    s.dispose()
  })
  it('asks nothing when the decision model is not set up', async () => {
    const laya = fakeLaya()
    const { s } = service(laya.port, { deciderAvailable: () => false })
    const { decision } = await s.route(HARD, {}, live, { requester: 'router.dispatch' })
    await s.shadowsSettled()
    expect(laya.calls).toHaveLength(0)
    expect(s.store.decision(decision.decisionId)!.shadow).toBeUndefined()
    s.dispose()
  })
})

const job = { id: 'job-1', projectId: 'p', title: 'Job', objective: 'o', handoff: {}, counters: { retries: 0, recoveries: 0, loopsDetected: 0, contextRollovers: 0 }, model: { provider: 'local', model: 'local/qwen3.5-9b' } } as unknown as DurableJob
const stage = { id: 'st-1', jobId: 'job-1', index: 0, title: 'Write the parser', objective: 'Add parse() to src/parse.ts', completionCriteria: ['src/parse.ts exists'], inputs: [], status: 'running', attempt: 1 } as unknown as DurableJobStage
const observation: StageObservation = { phase: 'completed', stopSequence: 1, lastAnswer: 'Added parse(). JOB STATUS: DONE', filesChanged: ['src/parse.ts'] }

describe('shadow for the app\'s own decisions', () => {
  it('journals a durable stage completion with the controller as the decision and the model as system-one', async () => {
    const laya = fakeLaya(() => ({ finished: 0.9, unfinished: 0.1 }))
    const { s } = service(laya.port)
    s.stageSettled({ job, stage, observation, succeeded: false })
    await s.shadowsSettled()
    const [record] = s.store.decisions({ kind: 'completion', since: '2026-09-01T00:00:00Z', limit: 5 })
    expect(record).toMatchObject({ requester: 'durable-jobs', choice: 'unfinished', decidedBy: 'durable-jobs-controller', escalationReason: 'mode shadow', systemOne: { decider: 'laya:typed-decisions', choice: 'finished', confidence: 0.9 } })
    expect(laya.calls[0]!.state).toMatchObject({ stage: 'Write the parser: Add parse() to src/parse.ts', filesChanged: '1' })
    s.dispose()
  })
  it('journals the loop guard\'s retry and stop verdicts through the wrapped port, after the controller has them', async () => {
    const { s } = service(fakeLaya(() => ({ retry: 0.3, escalate: 0.7, continue: 0 })).port)
    const guard: LoopGuardPort = { assess: vi.fn(({ previousErrors }) => previousErrors.length >= 2 ? { loop: true as const, detail: 'same error three times' } : { loop: false as const }) }
    const ports = withStageCapture({ handoff: { stagePrompt: () => '', afterStage: () => ({ handoff: {} as never, jobDone: false, result: '' }) }, loopGuard: guard }, () => {}, (input, verdict) => s.loopAssessed(input, verdict))
    const failed = { ...stage, status: 'pending' } as DurableJobStage
    expect(ports.loopGuard.assess({ job, stage: failed, stages: [failed], observation, error: 'tests fail', previousErrors: [] })).toEqual({ loop: false })
    expect(ports.loopGuard.assess({ job, stage: failed, stages: [failed], observation, error: 'tests fail', previousErrors: ['tests fail', 'tests fail'] })).toMatchObject({ loop: true })
    const completed = { ...stage, status: 'completed' } as DurableJobStage
    ports.loopGuard.assess({ job, stage: completed, stages: [completed], observation, error: 'nothing to do', previousErrors: [] })
    await vi.waitFor(async () => { await s.shadowsSettled(); expect(s.store.decisions({ kind: 'retry', since: '2026-09-01T00:00:00Z', limit: 5 })).toHaveLength(2) })
    expect(s.store.decisions({ kind: 'retry', since: '2026-09-01T00:00:00Z', limit: 5 }).map(record => [record.choice, record.systemOne?.choice])).toEqual([['escalate', 'escalate'], ['retry', 'escalate']])
    expect(s.store.decisions({ kind: 'escalate', since: '2026-09-01T00:00:00Z', limit: 5 }).map(record => [record.choice, record.decidedBy])).toEqual([['continue', 'durable-jobs-loop-guard']])
    s.dispose()
  })
  it('journals the category of every dispatched task and the completion of its settled turns', async () => {
    const laya = fakeLaya()
    const { s } = service(laya.port)
    s.bindDispatch('agent-1', { decisionId: null, features: { ...HARD, category: 'review', summary: 'Review the approval gate diff' }, key: OPUS, effort: 'high', projectId: 'p' })
    await s.shadowsSettled()
    const [classify] = s.store.decisions({ kind: 'classify', since: '2026-09-01T00:00:00Z', limit: 5 })
    expect(classify).toMatchObject({ requester: 'dispatch', choice: 'review', decidedBy: 'dispatch-features', agentSessionId: 'agent-1', systemOne: { decider: 'laya:typed-decisions' } })
    expect(Object.keys((laya.calls[0]!.questions.decision as { criteria: object }).criteria)).toContain('difficult-coding')
    const items = [
      { id: 'u', sequence: 1, turnId: 't1', runtimeId: 'r', timestamp: NOW.toISOString(), data: { type: 'text', role: 'user', text: 'Review the approval gate diff' } },
      { id: 'a', sequence: 2, turnId: 't1', runtimeId: 'r', timestamp: NOW.toISOString(), data: { type: 'text', role: 'assistant', text: 'Reviewed: two findings, both fixed.' } },
      { id: 'usage', sequence: 3, turnId: 't1', runtimeId: 'r', timestamp: NOW.toISOString(), data: { type: 'usage', provider: 'claude', model: 'opus[1m]' } }
    ]
    s.turnSettled({ agentSessionId: 'agent-1', runtimeId: 'r', turnId: 't1', phase: 'completed' }, () => ({ items: items as never }))
    await s.shadowsSettled()
    const [completion] = s.store.decisions({ kind: 'completion', since: '2026-09-01T00:00:00Z', limit: 5 })
    expect(completion).toMatchObject({ requester: 'turn-capture', choice: 'finished', decidedBy: 'turn-phase', systemOne: { decider: 'laya:typed-decisions', choice: 'finished' } })
    expect(laya.calls.at(-1)!.state).toMatchObject({ lastAnswer: 'Reviewed: two findings, both fixed.' })
    s.dispose()
  })
  it('reports how the decision model did per kind in decisions.list terms', async () => {
    const { s } = service(fakeLaya(() => ({ finished: 0.8, unfinished: 0.2 })).port)
    s.stageSettled({ job, stage, observation, succeeded: true })
    s.stageSettled({ job, stage: { ...stage, id: 'st-2' }, observation, succeeded: false })
    await s.shadowsSettled()
    expect(s.deciderAgreement(['completion'])).toEqual([{ kind: 'completion', decider: 'laya', asked: 2, failed: 0, cases: 2, agreed: 1, rate: 0.5, medianMs: 412 }])
    s.dispose()
  })
  it('shadows an approval review with the decision model even when no GPU model server runs', async () => {
    const laya = fakeLaya(() => ({ allow: 0.6, deny: 0.1, escalate: 0.3 }))
    const { s } = service(laya.port, { localRunner: { ask: vi.fn() }, localServerRunning: () => false })
    const action = { projectId: 'p', machineId: 'local', workerId: 'w', runtimeId: 'r', requestId: 'q', tool: 'Bash', arguments: { command: 'npm test' }, paths: [], boundary: 'workspace-write', reason: 'run the tests', sideEffects: [], ownerEvidence: 'o', authorizationId: 'a', native: {} } as ReviewAction
    const spec = { id: 'w', projectId: 'p', sessionId: 's', provider: 'claude', cwd: '.', title: 'W' } as AgentSpec
    s.approvalShadow.reviewing(spec, action)
    expect(s.approvalShadow.stats().skipped).toBe(0)
    s.approvalShadow.reviewed({ workerId: 'w', runtimeId: 'r', requestId: 'q', phase: 'approved', rationale: 'fine', reviewerModel: 'opus', history: [{ phase: 'approved', at: NOW.toISOString(), rationale: 'fine' }] } as unknown as ReviewRecord)
    const record = await s.approvalShadow.settled({ workerId: 'w', runtimeId: 'r', requestId: 'q' })
    expect(record).toMatchObject({ kind: 'approval', choice: 'allow', decidedBy: 'approval-reviewer:opus', systemOne: { decider: 'laya:typed-decisions', choice: 'allow' } })
    expect(laya.calls).toHaveLength(1)
    s.dispose()
  })
  it('never lets a throwing decision model reach the caller', async () => {
    const thrower: Decider = { id: 'laya', tier: 'system-one', supports: () => true, decide: async (): Promise<DeciderOutcome> => { throw new Error('boom') } }
    const s = createModelIntelligence({ dbPath: ':memory:', settings: settings(), timers: noTimers, clock: () => NOW, log: () => {}, decider: thrower, deciderAvailable: () => true })
    expect(() => s.stageSettled({ job, stage, observation, succeeded: true })).not.toThrow()
    await s.shadowsSettled()
    expect(s.store.decisions({ kind: 'completion', since: '2026-09-01T00:00:00Z', limit: 5 })[0]).toMatchObject({ choice: 'finished', systemOne: { decider: 'laya', choice: null, failed: 'boom' } })
    s.dispose()
  })
})
