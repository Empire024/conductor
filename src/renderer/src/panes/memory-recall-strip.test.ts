import { describe, expect, it } from 'vitest'
import type { TurnMemoryRecall } from '../../../shared/models'
import { recallsByItem } from './MemoryRecallStrip'

const recall = (patch: Partial<TurnMemoryRecall>): TurnMemoryRecall => ({
  itemId: 'item-1',
  agentSessionId: 'agent-1',
  prompt: 'Fix the checkout tax',
  createdAt: '2026-09-09T12:00:00.000Z',
  memories: [],
  forgotten: 0,
  ...patch
})

describe('anchoring recall to the turn it steered', () => {
  it('keys the ledger by the user message each recall travelled with', () => {
    const byItem = recallsByItem([
      recall({ itemId: 'item-1', forgotten: 1 }),
      recall({ itemId: 'item-2', prompt: 'And the totals' })
    ])
    expect([...byItem.keys()]).toEqual(['item-1', 'item-2'])
    expect(byItem.get('item-1')?.forgotten).toBe(1)
    expect(byItem.get('item-3')).toBeUndefined()
  })

  // The ledger is ordered oldest-first, so a resubmitted item id must resolve to the recall
  // that actually ran rather than the one it replaced.
  it('keeps the newest record for a reused item id and ignores unanchored rows', () => {
    const byItem = recallsByItem([
      recall({ prompt: 'first attempt' }),
      recall({ itemId: '', prompt: 'no anchor' }),
      recall({ prompt: 'second attempt' })
    ])
    expect(byItem.size).toBe(1)
    expect(byItem.get('item-1')?.prompt).toBe('second attempt')
  })
})
