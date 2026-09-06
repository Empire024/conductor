import { describe, expect, it } from 'vitest'
import type { AgentMemory } from '../shared/models'
import {
  memoryTokens,
  normalizeMemoryCues,
  scoreMemory,
  shouldConsolidateMemory
} from './memory'

const memory = (patch: Partial<AgentMemory> = {}): AgentMemory => ({
  id: 'memory-1',
  projectId: 'project-1',
  agentKey: null,
  kind: 'episodic',
  gist: 'Checkout tax discrepancy was caused by stale totals',
  cues: ['checkout', 'tax', 'totals'],
  salience: 0.5,
  strength: 1,
  confidence: 0.75,
  occurredAt: '2025-09-06T12:00:00.000Z',
  lastRecalledAt: null,
  recallCount: 0,
  createdAt: '2025-09-06T12:00:00.000Z',
  updatedAt: '2025-09-06T12:00:00.000Z',
  ...patch
})

describe('human-inspired memory helpers', () => {
  it('normalizes unique multilingual retrieval cues', () => {
    expect(memoryTokens('ÁFA checkout és 支付 checkout')).toEqual(['áfa', 'checkout', 'és', '支付'])
    expect(normalizeMemoryCues([' Checkout ', 'checkout', 'Tax discrepancy'])).toEqual([
      'checkout', 'tax', 'discrepancy'
    ])
  })

  it('consolidates strong same-kind cue matches without merging broad single-cue memories', () => {
    expect(shouldConsolidateMemory('semantic', ['checkout', 'tax', 'totals'], 'semantic', ['tax', 'checkout']))
      .toBe(true)
    expect(shouldConsolidateMemory('episodic', ['checkout', 'tax'], 'semantic', ['checkout', 'tax']))
      .toBe(false)
    expect(shouldConsolidateMemory('semantic', ['checkout'], 'semantic', ['checkout', 'checkout']))
      .toBe(false)
  })

  it('scores cue matches above unrelated but otherwise salient memories', () => {
    const now = Date.parse('2026-09-06T12:00:00.000Z')
    const query = new Set(['checkout', 'tax'])
    const matching = scoreMemory(memory(), query, now)
    const unrelated = scoreMemory(memory({ gist: 'Deployment SSH process', cues: ['deployment', 'ssh'], salience: 1 }), query, now)
    expect(matching.overlap).toBe(1)
    expect(unrelated.overlap).toBe(0)
    expect(matching.score).toBeGreaterThan(unrelated.score)
  })

  it('lets semantic knowledge decay more slowly and refreshes accessibility on recall', () => {
    const now = Date.parse('2026-09-06T12:00:00.000Z')
    const query = new Set(['checkout'])
    const episodic = scoreMemory(memory({ kind: 'episodic' }), query, now)
    const semantic = scoreMemory(memory({ kind: 'semantic' }), query, now)
    const recalled = scoreMemory(memory({ lastRecalledAt: '2026-09-05T12:00:00.000Z' }), query, now)
    expect(semantic.score).toBeGreaterThan(episodic.score)
    expect(recalled.score).toBeGreaterThan(episodic.score)
  })
})
