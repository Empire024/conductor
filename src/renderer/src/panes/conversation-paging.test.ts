import { describe, expect, it } from 'vitest'
import { withStoredMatches } from './conversation-paging'

describe('in-chat find over the whole stored conversation', () => {
  const loaded = [{ itemId: 'resident-1', sequence: 900, matches: 1 }, { itemId: 'resident-2', sequence: 950, matches: 2 }]
  it('counts journal-only hits first, since everything the store holds beyond the renderer is older', () => {
    const stored = [{ itemId: 'journal-1', sequence: 10, matches: 1 }, { itemId: 'journal-2', sequence: 20, matches: 1 }]
    expect(withStoredMatches(stored, loaded, new Set(['resident-1', 'resident-2'])).map(match => match.itemId)).toEqual(['journal-1', 'journal-2', 'resident-1', 'resident-2'])
  })
  it('does not count a stored hit twice once its page is loaded', () => {
    const stored = [{ itemId: 'journal-1', sequence: 10, matches: 1 }, { itemId: 'journal-2', sequence: 20, matches: 1 }]
    const withPage = [{ itemId: 'journal-2', sequence: 20, matches: 1 }, ...loaded]
    expect(withStoredMatches(stored, withPage, new Set(['journal-2', 'resident-1', 'resident-2'])).map(match => match.itemId)).toEqual(['journal-1', 'journal-2', 'resident-1', 'resident-2'])
  })
  it('keeps the renderer\'s own list when the store adds nothing', () => {
    expect(withStoredMatches([], loaded, new Set())).toBe(loaded)
  })
})
