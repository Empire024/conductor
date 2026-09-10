import { describe, expect, it } from 'vitest'
import { CLOSED_FIND, conversationMatches, findPositionLabel, findReducer, type FindAction, type FindState } from './conversation-find'
import type { AgentEventData, TimelineItem } from '../../../shared/structured-agent'

let sequence = 0
const item = (data: AgentEventData): TimelineItem => ({ id: 'item-' + ++sequence, runtimeId: 'runtime', sequence, timestamp: '2026-09-10T00:00:00.000Z', data })
const message = (role: 'user' | 'assistant' | 'status', text: string): TimelineItem => item({ type: 'text', role, text, mode: 'snapshot' })
const run = (state: FindState, actions: FindAction[]): FindState => actions.reduce(findReducer, state)

describe('conversation find matching', () => {
  it('matches message text case-insensitively and never provider internals', () => {
    const items = [
      message('user', 'Check the RETRY budget'),
      item({ type: 'tool', name: 'Bash', input: { command: 'retry budget --dump' }, status: 'completed', output: 'retry budget = 4' }),
      item({ type: 'notice', message: 'retry budget notice' }),
      message('assistant', 'retry budget retry budget')
    ]
    const matches = conversationMatches(items, 'Retry Budget')
    expect(matches.map(match => match.itemId)).toEqual(['item-1', 'item-4'])
    expect(matches.map(match => match.matches)).toEqual([1, 2])
    expect(conversationMatches(items, '   ')).toEqual([])
    expect(conversationMatches(items, 'absent')).toEqual([])
    expect(conversationMatches([message('user', 'aaaa'), message('user', 'aa')], 'a', 1)).toHaveLength(1)
  })
})

describe('find bar state machine', () => {
  it('opens, keeps the previous needle and closes back to the first match', () => {
    const opened = run(CLOSED_FIND, [{ type: 'open' }, { type: 'query', query: 'plan' }, { type: 'step', direction: 1, count: 3 }])
    expect(opened).toEqual({ open: true, query: 'plan', index: 1 })
    expect(findReducer(opened, { type: 'open' })).toBe(opened)
    const closed = findReducer(opened, { type: 'close' })
    expect(closed).toEqual({ open: false, query: 'plan', index: 0 })
    expect(findReducer(closed, { type: 'close' })).toBe(closed)
    expect(findReducer(closed, { type: 'open' })).toEqual({ open: true, query: 'plan', index: 0 })
  })
  it('wraps in both directions and resets the position when the query changes', () => {
    let state = run(CLOSED_FIND, [{ type: 'open' }, { type: 'query', query: 'plan' }])
    expect(state.index).toBe(0)
    state = findReducer(state, { type: 'step', direction: -1, count: 3 })
    expect(state.index).toBe(2)
    state = findReducer(state, { type: 'step', direction: 1, count: 3 })
    expect(state.index).toBe(0)
    state = run(state, [{ type: 'step', direction: 1, count: 3 }, { type: 'step', direction: 1, count: 3 }])
    expect(state.index).toBe(2)
    expect(findReducer(state, { type: 'query', query: 'plan' })).toBe(state)
    expect(findReducer(state, { type: 'query', query: 'other' })).toEqual({ open: true, query: 'other', index: 0 })
    // A shrinking result set (a live message edited the timeline under the cursor) clamps first.
    expect(findReducer(state, { type: 'step', direction: 1, count: 2 }).index).toBe(0)
    expect(findReducer(state, { type: 'step', direction: 1, count: 0 }).index).toBe(0)
    expect(findReducer({ open: true, query: 'plan', index: 0 }, { type: 'select', index: 9, count: 3 }).index).toBe(2)
    expect(findReducer({ open: true, query: 'plan', index: 2 }, { type: 'select', index: 2, count: 3 })).toEqual({ open: true, query: 'plan', index: 2 })
  })
  it('reports the position only once something was searched for', () => {
    expect(findPositionLabel(0, 0, '')).toBe('')
    expect(findPositionLabel(0, 0, 'plan')).toBe('No matches')
    expect(findPositionLabel(17, 2, 'plan')).toBe('3 of 17')
    expect(findPositionLabel(3, 9, 'plan')).toBe('3 of 3')
  })
})
