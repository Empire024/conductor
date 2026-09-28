import { describe, expect, it } from 'vitest'
import type { LocalStopReason, LocalStopReport } from '../../../shared/local-stop'
import type { LocalTelemetryEntry } from '../../local-models/agent'
import { captureLocalAgentStop } from './local-agent'

const report = (reason: LocalStopReason, extra: Partial<LocalStopReport> = {}): LocalStopReport => ({
  reason, detail: `${reason} detail`, rounds: 7, hardLimit: 40,
  context: { usedTokens: 20_000, capacityTokens: 60_000, reserveTokens: 4_096, windowTokens: 65_536, percent: 33, estimated: false },
  compactions: 0, recoveredTokens: 0, loopWarnings: 0, filesChanged: [], commandsRun: 3, excludedOutputChars: 0, timeline: [],
  task: { lifecycle: 'completed', requests: 7, recoveries: 1, elapsedMs: 42_000, tokens: 91_000, segmentLimit: 8, maxRounds: 40 },
  ...extra,
})
const stop = (r: LocalStopReport): LocalTelemetryEntry => ({ kind: 'stop', report: r })
const base = { model: 'local/qwen3.6-35b-a3b', ref: 'task-1', agentSessionId: 'loc-1', projectId: 'p1', prompt: 'fix the failing test', at: '2026-09-28T10:00:00Z' }

describe('captureLocalAgentStop', () => {
  it('maps a completed stop with acceptance and the telemetry stream', () => {
    const entries: LocalTelemetryEntry[] = [
      { kind: 'repair', round: 2, name: 'edit', outcome: 'failed' },
      { kind: 'acceptance', round: 6, passed: true, exitCode: 0 },
      stop(report('completed')),
    ]
    expect(captureLocalAgentStop({ ...base, telemetry: entries })).toMatchObject({
      key: { provider: 'local', model: 'local/qwen3.6-35b-a3b' }, source: 'local-agent', ref: 'task-1', category: 'debugging', result: 'success', verifier: 'pass',
      durationMs: 42_000, tokens: 91_000, retries: 1, iterations: 7, toolFailures: 1, looped: false,
    })
  })
  it.each([
    ['stagnation', { looped: true, result: 'failure' }],
    ['context_limit', { contextFailure: true, result: 'failure' }],
    ['round_limit', { timedOut: true, overBudget: true, result: 'failure' }],
    ['output_limit', { invalidOutput: true }],
    ['output_budget_loop', { looped: true, invalidOutput: true }],
    ['empty_answer', { invalidOutput: true }],
    ['unverified_claim', { falseCompletion: true, result: 'failure' }],
    ['interrupted', { result: 'cancelled' }],
    ['provider_error', { result: 'failure', timedOut: false }],
  ] as const)('%s', (reason, expected) => {
    const result = captureLocalAgentStop({ ...base, telemetry: stop(report(reason)) })!
    expect(result).toMatchObject(expected)
    if (reason !== 'interrupted') expect(result.detail).toContain(reason)
  })
  it('a completed stop whose acceptance failed is a false completion', () => {
    expect(captureLocalAgentStop({ ...base, telemetry: stop(report('completed', { acceptance: { command: 'npm test', passed: false, exitCode: 1 } })) })).toMatchObject({ result: 'failure', verifier: 'fail', falseCompletion: true })
  })
  it('partial when files changed before a failure; provider timeouts; no stop entry', () => {
    expect(captureLocalAgentStop({ ...base, telemetry: stop(report('round_limit', { filesChanged: ['a.ts'] })) })!.result).toBe('partial')
    expect(captureLocalAgentStop({ ...base, telemetry: stop(report('provider_error', { detail: 'the server timed out' })) })!.timedOut).toBe(true)
    expect(captureLocalAgentStop({ ...base, telemetry: [{ kind: 'stage', round: 1, stage: 'normal' }] })).toBeNull()
  })
  it('is idempotent per ref and model', () => {
    const a = captureLocalAgentStop({ ...base, telemetry: stop(report('completed')) })!, b = captureLocalAgentStop({ ...base, model: 'qwen3.6-35b-a3b', telemetry: stop(report('completed')) })!
    expect(a.id).toBe(b.id)
  })
})
