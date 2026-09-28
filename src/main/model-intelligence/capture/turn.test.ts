import { describe, expect, it } from 'vitest'
import type { AgentEventData, TimelineItem } from '../../../shared/structured-agent'
import { captureTurn } from './turn'
import { outcomeId } from './common'

let seq = 0
const item = (data: AgentEventData, extra: Partial<TimelineItem> = {}): TimelineItem => ({ id: `i${++seq}`, runtimeId: 'rt1', turnId: 'turn-1', sequence: seq, timestamp: new Date(Date.parse('2026-09-28T10:00:00Z') + seq * 1_000).toISOString(), data, ...extra })
const session = item({ type: 'session', phase: 'running', capabilities: { provider: 'claude', runtimeVersion: '2.1', adapterVersion: 1, authentication: 'cli', textStreaming: true, steering: true, toolInputStreaming: true, toolOutputStreaming: true, approvals: true, questions: true, resume: true, fork: true, plans: true, effort: ['high'], models: [], limitations: [], effectiveSettings: { model: 'opus[1m]', effort: 'high' } }, settings: { model: 'opus[1m]', effort: 'high', permission: 'auto', plan: false } }, { turnId: undefined })

function timeline(prompt: string, extra: TimelineItem[] = []): TimelineItem[] {
  return [
    session,
    item({ type: 'text', role: 'user', text: prompt, mode: 'snapshot' }),
    item({ type: 'tool', name: 'Bash', input: { command: 'npm test' }, status: 'failed', exitCode: 1, durationMs: 900 }),
    item({ type: 'tool', name: 'Edit', status: 'completed' }),
    item({ type: 'tool', name: 'Read', status: 'failed' }, { parentId: 'sub' }),
    item({ type: 'usage', inputTokens: 12_000, outputTokens: 800, cachedTokens: 10_000, costUsd: 0.12, scope: 'turn', source: 'provider' }),
    item({ type: 'text', role: 'assistant', text: 'Fixed.', mode: 'snapshot' }),
    ...extra,
  ]
}

describe('captureTurn', () => {
  it('maps a completed turn with usage, tool failures and the session model', () => {
    const items = timeline('fix the failing test in parser.test.ts')
    const result = captureTurn({ agentSessionId: 'a1', projectId: 'p1', turnId: 'turn-1', phase: 'completed', items })!
    expect(result).toMatchObject({ key: { provider: 'claude', model: 'opus[1m]' }, effort: 'high', source: 'turn', ref: 'a1:turn-1', category: 'debugging', result: 'completed-unverified', toolFailures: 1, costUsd: 0.12, projectId: 'p1', agentSessionId: 'a1', verifier: 'none' })
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.durationMs).toBe(5_000)
    expect(result.id).toBe(outcomeId('turn', 'a1:turn-1', { provider: 'claude', model: 'opus[1m]' }))
    expect(captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'completed', items })!.id).toBe(result.id)
  })
  it('is a success or failure only with a verifier signal, and counts retried errors', () => {
    const items = timeline('fix the failing test in parser.test.ts')
    expect(captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'completed', items, verifier: 'pass' })).toMatchObject({ result: 'success', verifier: 'pass' })
    expect(captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'completed', items, verifier: 'fail' })).toMatchObject({ result: 'failure', verifier: 'fail' })
    const retried = timeline('fix the failing test in parser.test.ts', [item({ type: 'error', message: 'stream disconnected, retrying' }), item({ type: 'error', message: 'stream disconnected, retrying' })])
    expect(captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'completed', items: retried })!.retries).toBe(2)
    expect(captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'failed', items: retried })!.retries).toBe(1)
    expect(captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'completed', items: retried, retries: 5 })!.retries).toBe(5)
  })
  it('skips turns with no category signal, unless routed', () => {
    const items = timeline('hello there')
    expect(captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'completed', items })).toBeNull()
    expect(captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'completed', items, decisionId: 'd1' })).toMatchObject({ category: 'general', decisionId: 'd1' })
    expect(captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'completed', items, category: 'research' })).toMatchObject({ category: 'research' })
  })
  it('maps failures, interruptions, usage limits and unsettled phases', () => {
    const failed = captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'failed', items: timeline('fix the crash', [item({ type: 'error', message: 'prompt is too long: context window exceeded' })]) })!
    expect(failed).toMatchObject({ result: 'failure', contextFailure: true, timedOut: false })
    expect(failed.detail).toContain('context window')
    expect(captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'failed', items: timeline('fix the crash', [item({ type: 'error', message: 'Request timed out' })]) })).toMatchObject({ result: 'failure', timedOut: true })
    expect(captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'failed', items: timeline('fix the crash', [item({ type: 'error', message: "You've hit your usage limit" })]) })).toMatchObject({ result: 'cancelled', overBudget: true })
    expect(captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'interrupted', items: timeline('fix the crash') })).toMatchObject({ result: 'cancelled' })
    expect(captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'running', items: timeline('fix the crash') })).toBeNull()
  })
  it('honours provider/model overrides and needs a model', () => {
    const bare = timeline('fix the crash').filter(entry => entry.data.type !== 'session')
    expect(captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'completed', items: bare })).toBeNull()
    expect(captureTurn({ agentSessionId: 'a1', turnId: 'turn-1', phase: 'completed', items: bare, provider: 'codex', model: 'gpt-6-astra', effort: 'xhigh' })).toMatchObject({ key: { provider: 'codex', model: 'gpt-6-astra' }, effort: 'xhigh' })
  })
})
