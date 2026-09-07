import { describe, expect, it } from 'vitest'
import { emptyProjection, MAX_PREVIEW_CHARS, MAX_TIMELINE_ITEMS, projectAgentEvent, replayAgentEvents } from './structured-agent-reducer'
import type { AgentEvent, AgentEventData } from './structured-agent'

const event = (sequence: number, data: AgentEventData, overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  schemaVersion: 1, id: `event-${sequence}`, sequence, sessionId: 'session', runtimeId: 'runtime', provider: 'claude', projectId: 'project', workspaceId: 'workspace', cwd: 'fixture', timestamp: '2026-09-07T00:00:00.000Z', data, ...overrides
})
describe('durable agent projection — synthetic events', () => {
  it('separates identical item IDs in different turns and native child conversations', () => {
    const facts = [
      event(1, { type: 'text', role: 'assistant', text: 'first', mode: 'snapshot' }, { itemId: 'reused', turnId: 'one', nativeSessionId: 'parent' }),
      event(2, { type: 'text', role: 'assistant', text: 'second', mode: 'snapshot' }, { itemId: 'reused', turnId: 'two', nativeSessionId: 'parent' }),
      event(3, { type: 'text', role: 'assistant', text: 'child', mode: 'snapshot' }, { itemId: 'reused', turnId: 'one', nativeSessionId: 'child' })
    ]
    const state = replayAgentEvents('session', facts)
    expect(state.items).toHaveLength(3)
    expect(state.nativeSessionId).toBe('parent')
  })
  it('replays deterministically without mutating its inputs or accepting duplicate/out-of-order sequence', () => {
    const events = [event(1, { type: 'text', role: 'assistant', text: 'go', mode: 'delta' }, { itemId: 'message' }), event(2, { type: 'text', role: 'assistant', text: 'go', mode: 'delta' }, { itemId: 'message' })]
    const original = JSON.stringify(events)
    const a = replayAgentEvents('session', events), b = replayAgentEvents('session', JSON.parse(original) as AgentEvent[])
    expect(a).toEqual(b)
    expect(JSON.stringify(events)).toBe(original)
    expect(a.items[0]?.data).toMatchObject({ text: 'gogo' })
    expect(projectAgentEvent(a, events[0]!)).toBe(a)
    expect(projectAgentEvent(a, event(3, { type: 'notice', message: 'other' }, { sessionId: 'other' }))).toBe(a)
  })
  it('reconciles snapshots and interleaved outputs by native identity without text deduplication', () => {
    const state = replayAgentEvents('session', [
      event(1, { type: 'tool', name: 'Bash', status: 'preparing', input: {} }, { itemId: 'A' }),
      event(2, { type: 'tool', name: 'Read', status: 'preparing', input: {} }, { itemId: 'B', parentId: 'agent' }),
      event(3, { type: 'tool', name: 'Bash', status: 'preparing', inputDelta: '{"cmd":' }, { itemId: 'A' }),
      event(4, { type: 'tool', name: 'Bash', status: 'preparing', inputDelta: '"node"}' }, { itemId: 'A' }),
      event(5, { type: 'tool', name: 'Read', status: 'completed', output: 'read data', outputMode: 'snapshot' }, { itemId: 'B', parentId: 'agent' }),
      event(6, { type: 'tool', name: 'Bash', status: 'running', input: { cmd: 'node' }, output: 'ha', outputMode: 'delta' }, { itemId: 'A' }),
      event(7, { type: 'tool', name: 'Bash', status: 'running', output: 'ha', outputMode: 'delta' }, { itemId: 'A' }),
      event(8, { type: 'tool', name: 'Bash', status: 'failed', output: 'haha!', outputMode: 'snapshot', exitCode: 1 }, { itemId: 'A' })
    ])
    expect(state.items).toHaveLength(2)
    expect(state.items[0]?.data).toMatchObject({ input: { cmd: 'node' }, output: 'haha!', status: 'failed', exitCode: 1 })
    expect(state.items[1]).toMatchObject({ parentId: 'agent', data: { output: 'read data', status: 'completed' } })
    expect(state.items.map((item) => item.sequence)).toEqual([1, 2])
  })
  it('separates native request identity across runtime incarnations and expires only pending interactions', () => {
    const interaction = { id: 'reused', kind: 'approval' as const, title: 'Allow tool?', input: {}, choices: [{ id: 'allow', label: 'Allow once' }], status: 'pending' as const }
    const state = replayAgentEvents('session', [
      event(1, { type: 'interaction', interaction }, { requestId: 'reused' }),
      event(2, { type: 'session', phase: 'disconnected' }),
      event(3, { type: 'interaction', interaction }, { runtimeId: 'runtime-2', requestId: 'reused' })
    ])
    expect(state.items).toHaveLength(2)
    expect(state.items[0]?.data).toMatchObject({ interaction: { status: 'expired' } })
    expect(state.items[1]?.data).toMatchObject({ interaction: { status: 'pending' } })
    expect(state.items[0]?.id).not.toBe(state.items[1]?.id)
  })
  it('bounds large synthetic histories and previews while preserving real counts and statuses', () => {
    let state = emptyProjection('session')
    for (let i = 1; i <= MAX_TIMELINE_ITEMS + 100; i++) state = projectAgentEvent(state, event(i, { type: 'notice', message: `Synthetic ${i}` }))
    expect(state.items).toHaveLength(MAX_TIMELINE_ITEMS)
    expect(state.truncated).toBe(true)
    state = projectAgentEvent(state, event(MAX_TIMELINE_ITEMS + 101, { type: 'tool', name: 'PowerShell', status: 'completed', output: 'X'.repeat(MAX_PREVIEW_CHARS + 10), outputMode: 'snapshot' }, { itemId: 'large' }))
    // First events must also be bounded, not just reconciliation updates.
    const initial = state.items.at(-1)?.data
    expect(initial?.type === 'tool' ? initial.output?.length : 0).toBeLessThanOrEqual(MAX_PREVIEW_CHARS)
  })
})


describe('queue and live usage projection', () => {
  it('replays old single-message queues and new multiple-message queues', () => {
    const prompt = { id: 'one', text: 'first', settings: { permission: 'default' as const, plan: false }, attachments: [] }
    const old = replayAgentEvents('session', [event(1, { type: 'queue', prompt })])
    expect(old.queuedPrompts).toEqual([prompt])
    const prompts = [prompt, { ...prompt, id: 'two', text: 'second' }]
    const next = projectAgentEvent(old, event(2, { type: 'queue', prompt, prompts }))
    expect(next.queued?.id).toBe('one')
    expect(next.queuedPrompts).toEqual(prompts)
  })
  it('preserves known usage fields and tracks latest snapshot sequence', () => {
    const state = replayAgentEvents('session', [
      event(1, { type: 'usage', source: 'provider', scope: 'message', inputTokens: 30, outputTokens: 1 }, { itemId: 'usage' }),
      event(2, { type: 'usage', source: 'provider', scope: 'message', inputTokens: undefined, outputTokens: 8 }, { itemId: 'usage' })
    ])
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ sequence: 1, updatedSequence: 2, data: { inputTokens: 30, outputTokens: 8 } })
  })
})
