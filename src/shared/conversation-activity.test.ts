import { describe, expect, it } from 'vitest'
import { isAnsweredThroughInteraction, isConversationActivity } from './conversation-activity'
import type { TimelineItem } from './structured-agent'

const tool = (index: number, runtimeId = 'runtime'): TimelineItem => ({ id: 'tool-' + index + runtimeId, runtimeId, nativeItemId: 'use-' + index, sequence: index, updatedSequence: index, timestamp: '', data: { type: 'tool', name: 'Bash', status: 'completed' } })
const question = (index: number, runtimeId = 'runtime'): TimelineItem => ({ id: 'question-' + index + runtimeId, runtimeId, nativeItemId: 'use-' + index, sequence: index, updatedSequence: index, timestamp: '', data: { type: 'interaction', interaction: { id: 'q' + index, kind: 'question', status: 'answered', title: 'Q' } } } as unknown as TimelineItem)
/** The original definition, a scan of the whole timeline per item. */
const scanned = (item: TimelineItem, items: TimelineItem[]): boolean => item.data.type === 'tool' && Boolean(item.nativeItemId) &&
  items.some(other => other !== item && other.runtimeId === item.runtimeId && other.nativeItemId === item.nativeItemId && other.data.type === 'interaction' && other.data.interaction.kind === 'question')

describe('a tool call answered through a question interaction', () => {
  it('matches a whole-timeline scan, per runtime', () => {
    const items = [...Array.from({ length: 300 }, (_, index) => tool(index)), ...Array.from({ length: 300 }, (_, index) => tool(index, 'other')), question(7), question(150, 'other'), question(299)]
    for (const item of items) expect(isAnsweredThroughInteraction(item, items), item.id).toBe(scanned(item, items))
    expect(items.filter(isConversationActivity)).toHaveLength(items.length - 3)
  })
  it('sees a question added to a new timeline array, and to the same array once it grows', () => {
    const items = [tool(1), tool(2)]
    expect(isAnsweredThroughInteraction(items[1]!, items)).toBe(false)
    const next = [...items, question(2)]
    expect(isAnsweredThroughInteraction(next[1]!, next)).toBe(true)
    items.push(question(2))
    expect(isAnsweredThroughInteraction(items[1]!, items)).toBe(true)
  })
  it('filters a 2,000-item timeline in linear time', () => {
    const items = Array.from({ length: 2000 }, (_, index) => index % 50 === 0 ? question(index - 1) : tool(index))
    const started = performance.now()
    for (let round = 0; round < 20; round++) items.slice().filter(isConversationActivity)
    // A whole-timeline scan per item took about 4 M comparisons a filter; this stays far below that.
    expect(performance.now() - started).toBeLessThan(500)
  })
})
