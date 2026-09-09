import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentEventData } from '../../../shared/structured-agent'
import { emptyProjection, projectAgentEvent } from '../../../shared/structured-agent-reducer'
import { coalesceTextDeltas } from './coalesce-stream-events'

let sequence = 0
function event(data: AgentEventData, overrides: Partial<AgentEvent> = {}): AgentEvent {
  sequence += 1
  return {
    schemaVersion: 1, id: 'event-' + sequence, sequence, sessionId: 'session-1', runtimeId: 'runtime-1',
    provider: 'codex', projectId: 'project-1', workspaceId: 'workspace-1', cwd: '/cwd',
    timestamp: new Date(sequence).toISOString(), data, ...overrides
  }
}
const delta = (text: string, overrides: Partial<AgentEvent> = {}): AgentEvent =>
  event({ type: 'text', role: 'assistant', text, mode: 'delta' }, { itemId: 'message-1', turnId: 'turn-1', ...overrides })

describe('coalesceTextDeltas', () => {
  it('merges a run of same-item text deltas into a single event with concatenated text', () => {
    const events = [delta('café '), delta('🧪 '), delta('again ')]
    const merged = coalesceTextDeltas(events)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.data).toMatchObject({ type: 'text', text: 'café 🧪 again ' })
    // The merged event keeps the last event's envelope fields (sequence, id, timestamp).
    expect(merged[0]!.sequence).toBe(events.at(-1)!.sequence)
    expect(merged[0]!.id).toBe(events.at(-1)!.id)
  })

  it('produces the exact same projection as reducing every raw event one at a time, once the item already exists', () => {
    // The realistic target: the item was created by an earlier, already-flushed event (as
    // 'item/started' normally is), and this batch is a burst of pure continuation deltas.
    const seeded = projectAgentEvent(emptyProjection('session-1'), delta(''))
    const events = [delta('café '), delta('🧪 '), delta('again '), delta('again ')]
    const sequential = events.reduce(projectAgentEvent, seeded)
    const withCoalescing = coalesceTextDeltas(events).reduce(projectAgentEvent, seeded)
    expect(withCoalescing).toEqual(sequential)
  })

  it('may advance an item creation sequence when a brand-new item is entirely created within one merged batch, but never its text', () => {
    // Known, harmless edge case: if 'item/started' and its first deltas all land in the very
    // first flush, the merged event's envelope is the batch's last event, so the freshly
    // created TimelineItem.sequence reflects that instead of the true first event. This only
    // affects where the "show earlier" pagination boundary falls, never rendered content.
    const events = [delta('café '), delta('🧪 ')]
    const sequential = events.reduce(projectAgentEvent, emptyProjection('session-1'))
    const withCoalescing = coalesceTextDeltas(events).reduce(projectAgentEvent, emptyProjection('session-1'))
    expect(withCoalescing.items[0]!.data).toEqual(sequential.items[0]!.data)
    expect(withCoalescing.sequence).toBe(sequential.sequence)
    expect(sequential.items[0]!.sequence).toBe(events[0]!.sequence)
    expect(withCoalescing.items[0]!.sequence).toBe(events.at(-1)!.sequence)
  })

  it('does not merge across a different itemId, runtimeId or turnId', () => {
    const events = [delta('a', { itemId: 'message-1' }), delta('b', { itemId: 'message-2' })]
    expect(coalesceTextDeltas(events)).toHaveLength(2)
    const acrossRuntime = [delta('a', { runtimeId: 'runtime-1' }), delta('b', { runtimeId: 'runtime-2' })]
    expect(coalesceTextDeltas(acrossRuntime)).toHaveLength(2)
    const acrossTurn = [delta('a', { turnId: 'turn-1' }), delta('b', { turnId: 'turn-2' })]
    expect(coalesceTextDeltas(acrossTurn)).toHaveLength(2)
  })

  it('never merges an event carrying nativeSessionId, since that can redirect which item a later delta resolves to', () => {
    const events = [delta('a'), delta('b', { nativeSessionId: 'native-1' }), delta('c')]
    const merged = coalesceTextDeltas(events)
    expect(merged).toHaveLength(3)
    expect(merged.map((item) => item.data.type === 'text' ? item.data.text : '')).toEqual(['a', 'b', 'c'])
  })

  it('leaves snapshot-mode text, non-text events and single-item batches untouched', () => {
    const snapshotPair = [delta('a', { itemId: 'message-1' }), event({ type: 'text', role: 'assistant', text: 'b', mode: 'snapshot' }, { itemId: 'message-1' })]
    expect(coalesceTextDeltas(snapshotPair)).toHaveLength(2)
    const interleaved = [delta('a'), event({ type: 'session', phase: 'running' }), delta('b')]
    expect(coalesceTextDeltas(interleaved)).toHaveLength(3)
    const single = [delta('only')]
    expect(coalesceTextDeltas(single)).toEqual(single)
    expect(coalesceTextDeltas([])).toEqual([])
  })
})
