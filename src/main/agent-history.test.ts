import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentEventData } from '../shared/structured-agent'
import { compactEntry, readHistory, type HistoryJournal } from './agent-history'

const event = (sequence: number, data: AgentEventData, itemId?: string): AgentEvent => ({
  schemaVersion: 1, id: 'event-' + sequence, sequence, sessionId: 's', runtimeId: 'r', provider: 'claude', projectId: 'p', workspaceId: 'w', cwd: '.', timestamp: `2026-09-28T10:00:${String(sequence % 60).padStart(2, '0')}.000Z`, data, ...(itemId ? { itemId } : {}),
  native: { method: 'stream', payload: { big: 'x'.repeat(500) } }
})
const journalOf = (events: AgentEvent[]): HistoryJournal & { reads: number } => {
  const journal = {
    reads: 0,
    range: (from: number, to: number, limit: number) => { journal.reads++; return events.filter(item => item.sequence >= from && item.sequence < to).slice(0, limit) },
    floor: () => events[0]?.sequence ?? null,
    latest: () => events.at(-1)?.sequence ?? null
  }
  return journal
}
type Page = { order: string; entries: Array<{ sequence: number; firstSequence?: number; type: string; text?: string; tool?: string; status?: string; outputTail?: string }>; hasMore: boolean; before?: number; nextAfter?: number }

describe('agents.history compaction', () => {
  it('folds a streamed message into one entry and drops bookkeeping', () => {
    const events = [
      event(1, { type: 'text', role: 'user', text: 'Do it', mode: 'snapshot' }, 'u1'),
      event(2, { type: 'text', role: 'assistant', text: 'Hel', mode: 'delta' }, 'a1'),
      event(3, { type: 'usage', inputTokens: 5, source: 'provider' }),
      event(4, { type: 'text', role: 'assistant', text: 'lo', mode: 'delta' }, 'a1'),
      event(5, { type: 'tool', name: 'Bash', status: 'running', input: { command: 'npm test' } }, 't1'),
      event(6, { type: 'tool', name: 'Bash', status: 'failed', exitCode: 1, output: 'boom '.repeat(300), outputMode: 'snapshot' }, 't1'),
      event(7, { type: 'session', phase: 'running' }),
      event(8, { type: 'session', phase: 'completed' })
    ]
    const page = readHistory('s', journalOf(events), {}) as Page
    expect(page.order).toBe('newest-first')
    expect(page.entries.map(entry => entry.type)).toEqual(['session', 'tool', 'text', 'text'])
    expect(page.entries[0]).toMatchObject({ sequence: 8, firstSequence: 7 })
    expect(page.entries[1]).toMatchObject({ tool: 'Bash', status: 'failed', exitCode: 1, input: '{"command":"npm test"}' })
    expect(page.entries[1]!.outputTail!.length).toBeLessThanOrEqual(501)
    expect(page.entries[2]).toMatchObject({ text: 'Hello', sequence: 4, firstSequence: 2 })
    expect(page.hasMore).toBe(false)
    expect(JSON.stringify(page)).not.toContain('big')
  })

  it('pages back without repeats and forward from afterSequence with nextAfter', () => {
    const events = Array.from({ length: 900 }, (_, index) => event(index + 1, { type: 'text', role: 'assistant', text: `m${index + 1}`, mode: 'snapshot' }, 'item-' + (index + 1)))
    const journal = journalOf(events)
    const newest = readHistory('s', journal, { limit: 5 }) as Page
    expect(newest.entries.map(entry => entry.sequence)).toEqual([900, 899, 898, 897, 896])
    expect(newest).toMatchObject({ hasMore: true, before: 896 })
    const older = readHistory('s', journal, { limit: 5, before: newest.before }) as Page
    expect(older.entries.map(entry => entry.sequence)).toEqual([895, 894, 893, 892, 891])
    const forward = readHistory('s', journal, { afterSequence: 10, limit: 3 }) as Page
    expect(forward).toMatchObject({ order: 'oldest-first', hasMore: true, nextAfter: 13 })
    expect(forward.entries.map(entry => entry.text)).toEqual(['m11', 'm12', 'm13'])
    const tail = readHistory('s', journal, { afterSequence: 898 }) as Page
    expect(tail).toMatchObject({ hasMore: false, nextAfter: 900 })
    expect(readHistory('s', journal, { limit: 500 }) as Page).toMatchObject({ entries: expect.any(Array) })
    expect((readHistory('s', journal, { limit: 500 }) as Page).entries).toHaveLength(100)
  })

  it('caps a long text at 2000 characters and says so', () => {
    expect(compactEntry([event(1, { type: 'text', role: 'assistant', text: 'y'.repeat(4321), mode: 'snapshot' }, 'a')])).toMatchObject({ truncated: true, chars: 4321, text: 'y'.repeat(2000) })
  })

  it('reads an empty journal as an empty page', () => {
    expect(readHistory('s', journalOf([]), {})).toEqual({ agentSessionId: 's', order: 'newest-first', entries: [], hasMore: false })
  })
})
