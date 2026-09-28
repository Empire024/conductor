import { describe, expect, it, vi } from 'vitest'
import type { HandoffPort, StageResultInput, StageResultDecision } from '../durable-jobs/ports'
import type { EvaluationSuite } from './evaluation'
import { latestModelsFromSchedules, latestModelsWatcher, turnObserver, withStageCapture } from './app-wiring'
import { createModelIntelligence } from './index'

const settings = () => { const values = new Map<string, string>(); return { getSetting: (key: string) => values.get(key) ?? null, setSetting: (key: string, value: string) => { values.set(key, value) } } }
const noTimers = { every: () => () => {}, after: () => () => {} }

describe('model intelligence app wiring', () => {
  it('captures a durable stage after afterStage without changing its decision or failing the stage', async () => {
    const decision = { handoff: {}, jobDone: false, result: 'done' } as unknown as StageResultDecision
    const handoff: HandoffPort = { stagePrompt: () => 'prompt', afterStage: () => decision }
    const seen: StageResultInput[] = []
    const wrapped = withStageCapture({ handoff, other: 1 }, input => { seen.push(input); throw new Error('capture broke') })
    const input = { succeeded: true } as unknown as StageResultInput
    expect(wrapped.other).toBe(1)
    expect(wrapped.handoff.stagePrompt({} as never)).toBe('prompt')
    expect(wrapped.handoff.afterStage(input)).toBe(decision)
    expect(seen).toEqual([])
    await Promise.resolve()
    expect(seen).toEqual([input])
  })

  it('reads the newest full latest-models outputs from schedule source state, and notices only newer runs', () => {
    const state: Record<string, { normalized: string; fetchedAt: string }> = {
      'old:script:cli-catalogs': { normalized: '{"claude":{}}', fetchedAt: '2026-09-20T00:00:00.000Z' },
      'new:script:cli-catalogs': { normalized: '{"codex":{}}', fetchedAt: '2026-09-27T00:00:00.000Z' },
      'new:script:primary-sources': { normalized: '{"sources":{}}', fetchedAt: '2026-09-27T00:00:01.000Z' }
    }
    const schedules = { all: () => [{ id: 'old', kind: 'latest-models-methods' }, { id: 'new', kind: 'latest-models-methods' }, { id: 'other', kind: 'agent' }], source: (id: string, source: string) => state[`${id}:${source}`] ?? null }
    expect(latestModelsFromSchedules(schedules)).toEqual({ cliCatalogs: { stdout: '{"codex":{}}', at: '2026-09-27T00:00:00.000Z' }, primarySources: { stdout: '{"sources":{}}', at: '2026-09-27T00:00:01.000Z' } })
    const ran = vi.fn(), changed = latestModelsWatcher(() => latestModelsFromSchedules(schedules), ran)
    changed()
    expect(ran).not.toHaveBeenCalled()
    state['new:script:cli-catalogs'] = { normalized: '{}', fetchedAt: '2026-09-28T00:00:00.000Z' }
    changed(); changed()
    expect(ran).toHaveBeenCalledOnce()
  })

  it('observes only settled phases of dispatched agents', async () => {
    const service = createModelIntelligence({ dbPath: ':memory:', settings: settings(), timers: noTimers })
    const settled = vi.spyOn(service, 'turnSettled')
    const observe = turnObserver(() => service, () => ({ items: [] }))
    service.bindDispatch('bound', { decisionId: null, features: { category: 'debugging', complexity: 3, risk: 'medium', toolsRequired: [], contextTokens: null }, key: { provider: 'codex', model: 'gpt-5.6-sol' }, effort: null, projectId: 'project' })
    observe('structured:events', [
      { sessionId: 'bound', runtimeId: 'r', turnId: 't1', data: { type: 'session', phase: 'running' } },
      { sessionId: 'unbound', runtimeId: 'r', data: { type: 'session', phase: 'completed' } },
      { sessionId: 'bound', runtimeId: 'r', data: { type: 'text', role: 'assistant', text: 'x', mode: 'snapshot' } },
      { sessionId: 'bound', runtimeId: 'r', turnId: 't1', data: { type: 'session', phase: 'failed', limitResumeAt: '2026-09-28T05:00:00Z' } }
    ])
    observe('agent:status', [{ sessionId: 'bound', data: { type: 'session', phase: 'completed' } }])
    await new Promise(resolve => setImmediate(resolve))
    expect(settled.mock.calls.map(call => call[0])).toEqual([{ agentSessionId: 'bound', runtimeId: 'r', turnId: 't1', phase: 'failed', limited: true }])
    service.dispose()
  })

  it('evaluates a local model with the whole suite, lists command jobs as not gradable without a sandbox, and refuses a cloud key it has no runner for', async () => {
    const suite: EvaluationSuite = { name: 'mini', jobs: [
      { id: 'answer', category: 'simple-coding', complexity: 1, prompt: 'Say 42', grader: { kind: 'exact', expected: '42' } },
      { id: 'tests', category: 'difficult-coding', complexity: 3, prompt: 'Write it', grader: { kind: 'command', cmd: 'node', args: ['t.mjs'], expectExit: 0, timeoutSec: 5 } }
    ] }
    const reports: string[] = []
    const service = createModelIntelligence({ dbPath: ':memory:', settings: settings(), timers: noTimers, evaluation: { runLocal: async () => ({ answer: '42' }), command: async () => null, precheck: key => key.model === 'local/busy' ? 'local/other holds the GPU' : null, writeReport: name => { reports.push(name) }, suites: () => ({ mini: suite }) } })
    const source = { kind: 'config' as const, name: 'configured:local' }
    service.registry.applyBatch({ source, fetchedAt: '2026-09-28T00:00:00Z', complete: true, benchmarks: [], observations: ['local/qwen', 'local/busy'].map(model => ({ key: { provider: 'local', model }, field: 'displayName' as const, value: model, source, observedAt: '2026-09-28T00:00:00Z' })) })
    await expect(service.startEvaluation({ provider: 'claude', model: 'opus[1m]' }, undefined)).rejects.toThrow(/Cloud model evaluation is not wired/)
    await expect(service.startEvaluation({ provider: 'local', model: 'local/busy' }, undefined)).rejects.toThrow('holds the GPU')
    const handle = await service.startEvaluation({ provider: 'local', model: 'qwen' }, 'mini')
    expect(handle).toMatchObject({ key: { provider: 'local', model: 'local/qwen' }, state: 'running', notGradable: ['tests (command: not gradable here)'] })
    await vi.waitFor(() => expect(service.evaluation(handle.runId)!.state).toBe('done'))
    expect(service.evaluation(handle.runId)!.result!.jobs.find(entry => entry.id === 'answer')!.result).toBe('success')
    expect(service.store.outcomes({ key: { provider: 'local', model: 'local/qwen' }, since: '2020-01-01T00:00:00Z', limit: 10 }).every(row => row.source === 'evaluation')).toBe(true)
    expect(service.registry.get({ provider: 'local', model: 'local/qwen' })!.status).toBe('unproven')
    expect(reports).toHaveLength(1)
    service.dispose()
  })
})
