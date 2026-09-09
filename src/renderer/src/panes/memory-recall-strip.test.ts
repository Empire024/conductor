import { describe, expect, it } from 'vitest'
import type { AgentMemory, TurnMemoryRecall } from '../../../shared/models'
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

const memory = (patch: Partial<AgentMemory> = {}): AgentMemory => ({
  id: 'memory-1',
  projectId: 'project-1',
  agentKey: null,
  kind: 'semantic',
  source: 'agent',
  origin: null,
  gist: 'The checkout tax bug was a stale total',
  cues: ['checkout', 'tax'],
  salience: 0.5,
  strength: 1,
  confidence: 0.75,
  occurredAt: '2026-09-06T12:00:00.000Z',
  lastRecalledAt: null,
  recallCount: 0,
  correctedAt: null,
  createdAt: '2026-09-06T12:00:00.000Z',
  updatedAt: '2026-09-06T12:00:00.000Z',
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

describe('not re-announcing the same memories on every message', () => {
  it('keeps a memory on the first turn that recalled it and drops it from every later repeat', () => {
    const standing = memory({ id: 'standing', kind: 'procedural' })
    const fresh = memory({ id: 'fresh', kind: 'episodic' })
    const byItem = recallsByItem([
      recall({ itemId: 'item-1', memories: [standing] }),
      recall({ itemId: 'item-2', memories: [standing] }),
      recall({ itemId: 'item-3', memories: [standing, fresh] })
    ])
    expect(byItem.get('item-1')?.memories.map((m) => m.id)).toEqual(['standing'])
    expect(byItem.get('item-2')?.memories).toEqual([])
    expect(byItem.get('item-3')?.memories.map((m) => m.id)).toEqual(['fresh'])
  })

  it('leaves a turn with nothing new to show renderable as empty rather than repeating stale memories', () => {
    const standing = memory({ id: 'standing' })
    const byItem = recallsByItem([
      recall({ itemId: 'item-1', memories: [standing] }),
      recall({ itemId: 'item-2', memories: [standing], forgotten: 1 })
    ])
    expect(byItem.get('item-2')?.memories).toEqual([])
    // A memory recalled again but since forgotten is still worth surfacing even with nothing new.
    expect(byItem.get('item-2')?.forgotten).toBe(1)
  })

  it('does not let a superseded resubmission both hide a memory and be skipped itself', () => {
    const standing = memory({ id: 'standing' })
    const byItem = recallsByItem([
      recall({ itemId: 'item-1', prompt: 'first attempt', memories: [standing] }),
      recall({ itemId: 'item-1', prompt: 'second attempt', memories: [standing] })
    ])
    expect(byItem.size).toBe(1)
    expect(byItem.get('item-1')?.prompt).toBe('second attempt')
    expect(byItem.get('item-1')?.memories.map((m) => m.id)).toEqual(['standing'])
  })
})
