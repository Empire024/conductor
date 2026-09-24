import { describe, expect, it } from 'vitest'
import type { AgentEventData, SessionPhase, SessionProjection, TimelineItem } from '../shared/structured-agent'
import type { ReviewRecord } from './approval-review'
import { sinceCursor, supervise } from './agent-supervision'

let sequence = 0
const item = (data: AgentEventData, extra: Partial<TimelineItem> = {}): TimelineItem => ({ id: `item-${++sequence}`, runtimeId: 'run-1', sequence, timestamp: new Date(Date.UTC(2026, 8, 24, 20, 0, sequence)).toISOString(), data, ...extra })
const state = (phase: SessionPhase, items: TimelineItem[], extra: Partial<SessionProjection> = {}): SessionProjection => ({ sessionId: 'worker', runtimeId: 'run-1', phase, sequence, items, settings: { permission: 'auto', plan: false }, title: 'Worker', archived: false, truncated: false, ...extra })
const prompt = (text = 'Do the task') => item({ type: 'text', role: 'user', text, mode: 'snapshot', origin: { agentSessionId: 'controller', label: 'Controller' } })
const approval = (id: string, review?: { phase: string; reviewerModel?: string }) => item({ type: 'interaction', interaction: { id, kind: 'approval', title: 'Write panel.mjs?', input: {}, choices: [{ id: 'allow', label: 'Allow' }], status: 'pending', ...(review ? { review: { id: 'r-' + id, digest: 'd', rationale: '', ...review } } : {}) } })

describe('compact supervision view', () => {
  it('says whether a pending request waits on the stronger reviewer or on the owner', () => {
    const view = supervise(state('waiting_approval', [prompt(), approval('a', { phase: 'reviewing' }), approval('b', { phase: 'owner', reviewerModel: 'claude-opus-5-5' }), approval('c')]))
    expect(view.pending.map(entry => [entry.requestId, entry.waitingOn, entry.review?.phase ?? null])).toEqual([['a', 'reviewer', 'reviewing'], ['b', 'owner', 'owner'], ['c', 'owner', null]])
  })

  it('separates an accepted prompt from a turn the native runtime actually started', () => {
    const accepted = prompt()
    const settings = item({ type: 'notice', message: 'Claude settings acknowledged by native runtime' })
    expect(supervise(state('running', [accepted, settings])).turnStart).toMatchObject({ promptItemId: accepted.id, from: 'Controller', state: 'awaiting-native', startedAt: null })
    const answer = item({ type: 'text', role: 'assistant', text: 'Working', mode: 'delta' })
    expect(supervise(state('running', [accepted, settings, answer])).turnStart).toMatchObject({ state: 'started', startedAt: answer.timestamp, evidence: 'assistant text' })
    // Settled with nothing native in it: the prompt was accepted, the turn never started.
    expect(supervise(state('failed', [accepted, settings])).turnStart).toMatchObject({ state: 'not-started' })
    // Evidence from an older provider process does not count for a prompt sent to a new one.
    const older = item({ type: 'tool', name: 'Bash', status: 'completed' }, { runtimeId: 'run-0' })
    expect(supervise(state('running', [accepted, older])).turnStart?.state).toBe('awaiting-native')
    expect(supervise(state('running', [accepted], { queuedPrompts: [{ id: 'q', text: 'next', settings: { permission: 'auto', plan: false } } as never] })).waitingPrompts).toBe(1)
  })

  it('moves the cursor on meaningful changes only, never on a streamed token', () => {
    const accepted = prompt(), answer = item({ type: 'text', role: 'assistant', text: 'Work', mode: 'delta' })
    const first = supervise(state('running', [accepted, answer]))
    const streamed = supervise(state('running', [accepted, { ...answer, data: { type: 'text', role: 'assistant', text: 'Working on it', mode: 'delta' }, updatedSequence: ++sequence }]))
    expect(streamed.cursor).toBe(first.cursor)
    const tool = item({ type: 'tool', name: 'Bash', status: 'running' })
    const running = supervise(state('running', [accepted, answer, tool]))
    expect(running.cursor).not.toBe(first.cursor)
    expect(running.activeTool).toMatchObject({ name: 'Bash', status: 'running' })
    const done = supervise(state('completed', [accepted, answer, { ...tool, data: { type: 'tool', name: 'Bash', status: 'completed' } }]))
    expect(done.activeTool).toBeNull()
    expect(done.cursor).not.toBe(running.cursor)
    const view = { ...done, agentSessionId: 'worker', phase: 'completed', observedAt: 'now' }
    expect(sinceCursor(view, done.cursor)).toEqual({ agentSessionId: 'worker', unchanged: true, cursor: done.cursor, phase: 'completed', observedAt: 'now' })
    expect(sinceCursor(view, 'stale')).toBe(view)
  })

  it('reports only measured usage, with the stronger reviewer\'s cost attributed separately', () => {
    const unmeasured = supervise(state('completed', [prompt(), item({ type: 'text', role: 'assistant', text: 'Done', mode: 'snapshot' }, { turnId: 't1' })]))
    expect(unmeasured.usage).toMatchObject({ tokens: null, costUsd: null, reviewer: null, errors: 0 })
    const measured = supervise(state('completed', [
      prompt(), item({ type: 'usage', inputTokens: 1200, outputTokens: 80, source: 'provider', scope: 'turn' }, { turnId: 't1' }),
      item({ type: 'error', message: 'first attempt failed' }, { turnId: 't1' }), item({ type: 'changes', changes: [{ path: 'a.ts', status: 'applied' }, { path: 'b.ts', status: 'rejected' }] as never }, { turnId: 't1' })
    ]), [
      { id: 'review-1', workerId: 'worker', reviewerId: 'reviewer-1', reviewerElapsedMs: 4000, reviewerUsage: { run: { tokens: { inputTokens: 1800, outputTokens: 40 } } } },
      { id: 'review-2', workerId: 'worker', reviewerId: 'reviewer-2', reviewerElapsedMs: 3000, reviewerUsage: { conversation: { tokens: { inputTokens: 900, outputTokens: 20 } } } },
      { id: 'review-3', workerId: 'worker' }
    ] as unknown as ReviewRecord[])
    expect(measured.usage.tokens).toMatchObject({ inputTokens: 1200, outputTokens: 80 })
    expect(measured.usage.errors).toBe(1)
    expect(measured.usage.measured.length).toBeGreaterThan(0)
    // A review that never reached a reviewer turn costs nothing and is not counted.
    expect(measured.usage.reviewer).toEqual({ reviews: 2, elapsedMs: 7000, tokens: { inputTokens: 2700, outputTokens: 60 }, records: ['review-1', 'review-2'] })
    expect(measured.artifacts).toEqual({ applied: 1, rejected: 1, pending: 0, reverted: 0 })
  })
})
