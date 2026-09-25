import { describe, expect, it } from 'vitest'
import { emptyProjection, MAX_TIMELINE_ITEMS, projectAgentEvent, projectAgentEvents } from './structured-agent-reducer'
import type { AgentEvent, AgentEventData } from './structured-agent'

const event = (sequence: number, data: AgentEventData, overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  schemaVersion: 1, id: `event-${sequence}`, sequence, sessionId: 'session', runtimeId: 'runtime', provider: 'claude', projectId: 'project', workspaceId: 'workspace', cwd: 'fixture', timestamp: '2026-09-25T00:00:00.000Z', data, ...overrides
})
/** A small seeded generator, so a failure names a reproducible seed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32 }
}
/** A provider stream with every shape the reducer distinguishes: deltas and snapshots of the same
 *  message, tool status and output deltas, pending questions, turn ends that settle them, queues and
 *  steering, Claude revealing its root session after text began, child conversations, and events
 *  that must be ignored (other sessions, repeated or out-of-order sequences). */
function stream(seed: number, length: number): AgentEvent[] {
  const next = random(seed)
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!
  const events: AgentEvent[] = []
  let sequence = 0
  for (let count = 0; count < length; count++) {
    sequence += next() < 0.05 ? 0 : 1
    const turnId = 'turn-' + Math.floor(sequence / 40)
    const itemId = 'item-' + Math.floor(next() * 12)
    const revealed = next() < 0.5 ? { nativeSessionId: pick(['root', 'root', 'child']) } : {}
    const parent = next() < 0.2 ? { parentId: 'parent-' + Math.floor(next() * 2) } : {}
    const roll = next()
    const data: AgentEventData = roll < 0.3 ? { type: 'text', role: 'assistant', text: 'word ' + count, mode: next() < 0.8 ? 'delta' : 'snapshot' }
      : roll < 0.5 ? { type: 'tool', name: 'Bash', status: pick(['preparing', 'running', 'completed', 'failed'] as const), output: 'line ' + count + '\n', outputMode: next() < 0.7 ? 'delta' : 'snapshot', ...(next() < 0.3 ? { detached: true } : {}) }
        : roll < 0.6 ? { type: 'interaction', interaction: { id: 'question-' + count, kind: 'question', status: next() < 0.7 ? 'pending' : 'answered', title: 'Question ' + count } } as AgentEventData
          : roll < 0.7 ? { type: 'session', phase: pick(['running', 'completed', 'interrupted', 'waiting_input', 'failed', 'disconnected'] as const), ...(next() < 0.2 ? { nativeSessionId: 'root' } : {}) }
            : roll < 0.75 ? { type: 'queue', prompt: null, prompts: next() < 0.5 ? [] : [{ id: 'queued-' + count, text: 'queued ' + count, settings: { permission: 'default', plan: false }, attachments: [] }] }
              : roll < 0.8 ? { type: 'steering', prompts: [{ id: 'steer-' + count, text: 'steer', status: pick(['sending', 'accepted', 'delivered'] as const) }] } as AgentEventData
                : roll < 0.85 ? { type: 'text', role: 'user', text: 'prompt ' + count, mode: 'snapshot' }
                  : roll < 0.9 ? { type: 'notice', message: 'notice ' + count }
                    : { type: 'usage', inputTokens: count, outputTokens: count * 2, source: 'provider' }
    const overrides: Partial<AgentEvent> = { turnId, ...revealed, ...parent, ...(data.type === 'interaction' ? { requestId: 'request-' + Math.floor(next() * 5) } : data.type === 'notice' ? {} : { itemId }) }
    if (next() < 0.03) overrides.sessionId = 'other'
    if (next() < 0.03) overrides.runtimeId = 'runtime-2'
    events.push(event(next() < 0.03 ? Math.max(0, sequence - 3) : sequence, data, overrides))
  }
  return events
}
/** Applies the events in random batches, the way frames of a live stream arrive. */
function batched(seed: number, events: AgentEvent[], state = emptyProjection('session')) {
  const next = random(seed)
  for (let at = 0; at < events.length;) {
    const size = 1 + Math.floor(next() * 60)
    state = projectAgentEvents(state, events.slice(at, at + size))
    at += size
  }
  return state
}

describe('projectAgentEvents — the batched projection a live renderer applies', () => {
  it('equals folding projectAgentEvent for every event shape, in any batching', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const events = stream(seed, 400)
      const folded = events.reduce(projectAgentEvent, emptyProjection('session'))
      expect(projectAgentEvents(emptyProjection('session'), events), 'seed ' + seed).toEqual(folded)
      expect(batched(seed, events), 'seed ' + seed + ' batched').toEqual(folded)
    }
  })
  it('reconciles text that began before Claude revealed its root session, and only for the same parent', () => {
    const reveal = (parentId?: string): AgentEvent[] => [
      event(1, { type: 'text', role: 'assistant', text: 'began ', mode: 'delta' }, { itemId: 'message', turnId: 'turn', parentId: 'task' }),
      event(2, { type: 'text', role: 'assistant', text: 'revealed', mode: 'delta' }, { itemId: 'message', turnId: 'turn', parentId, nativeSessionId: 'root' }),
      event(3, { type: 'text', role: 'assistant', text: '!', mode: 'delta' }, { itemId: 'message', turnId: 'turn', parentId })
    ]
    for (const [parentId, texts] of [['task', ['began revealed!']], [undefined, ['began ', 'revealed!']]] as const) {
      const events = reveal(parentId)
      const folded = events.reduce(projectAgentEvent, emptyProjection('session'))
      expect(folded.items.map(item => item.data.type === 'text' ? item.data.text : '')).toEqual(texts)
      expect(projectAgentEvents(emptyProjection('session'), events)).toEqual(folded)
    }
  })
  it('caps the timeline exactly as the fold does, including updates to items the cap evicts mid-batch', () => {
    const events: AgentEvent[] = []
    for (let index = 0; index < MAX_TIMELINE_ITEMS + 300; index++) {
      events.push(event(events.length + 1, { type: 'notice', message: 'n' + index }))
      // Keep touching one early item: it is evicted in the middle of this batch, then comes back.
      if (index % 97 === 0) events.push(event(events.length + 1, { type: 'text', role: 'assistant', text: 'more ', mode: 'delta' }, { itemId: 'early' }))
    }
    const folded = events.reduce(projectAgentEvent, emptyProjection('session'))
    const batch = projectAgentEvents(emptyProjection('session'), events)
    expect(batch).toEqual(folded)
    expect(batch.items).toHaveLength(MAX_TIMELINE_ITEMS)
    expect(batch.truncated).toBe(true)
    // Starting from an already-full timeline behaves the same.
    const more = stream(7, 300).map((item, index) => ({ ...item, sequence: folded.sequence + index + 1 }))
    expect(projectAgentEvents(folded, more)).toEqual(more.reduce(projectAgentEvent, folded))
  })
  it('leaves its input untouched and returns the same state when nothing applies', () => {
    const base = stream(3, 200).reduce(projectAgentEvent, emptyProjection('session'))
    const frozen = JSON.stringify(base)
    const items = base.items
    projectAgentEvents(base, stream(4, 200).map((item, index) => ({ ...item, sequence: base.sequence + index + 1, sessionId: 'session' })))
    expect(JSON.stringify(base)).toBe(frozen)
    expect(base.items).toBe(items)
    expect(projectAgentEvents(base, [event(1, { type: 'notice', message: 'old' }), event(base.sequence + 1, { type: 'notice', message: 'elsewhere' }, { sessionId: 'other' })])).toBe(base)
  })
})
