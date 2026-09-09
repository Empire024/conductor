import { describe, expect, it } from 'vitest'
import type { AgentMemory } from '../shared/models'
import {
  captureMemories,
  capturedMemoryKey,
  formatRecalledMemories,
  isMemoryKind,
  MEMORY_KINDS,
  MEMORY_PROTOCOL,
  memoryPruneReason,
  memoryTokens,
  normalizeMemoryCues,
  rankMemoriesForPrune,
  scoreMemory,
  shouldConsolidateMemory,
  shouldForgetMemory,
  stripMemoryDirectives
} from './memory'

const memory = (patch: Partial<AgentMemory> = {}): AgentMemory => ({
  id: 'memory-1',
  projectId: 'project-1',
  agentKey: null,
  kind: 'episodic',
  source: 'agent',
  origin: null,
  gist: 'Checkout tax discrepancy was caused by stale totals',
  cues: ['checkout', 'tax', 'totals'],
  salience: 0.5,
  strength: 1,
  confidence: 0.75,
  occurredAt: '2025-09-06T12:00:00.000Z',
  lastRecalledAt: null,
  recallCount: 0,
  correctedAt: null,
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


describe('the memory-write contract agents are handed', () => {
  it('reads a sentinel with its kind, cues and weights out of ordinary reply text', () => {
    const captured = captureMemories([
      'Here is what I found, and I will remember it.',
      'CONDUCTOR_MEMORY[procedural]: Run npm.cmd on Windows, never npm | cues: windows, npm | salience: 0.9',
      'That should do it.'
    ].join("\n"))
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ kind: 'procedural', gist: 'Run npm.cmd on Windows, never npm', cues: ['windows', 'npm'], salience: 0.9 })
  })
  it('defaults to semantic, clamps weights, and drops duplicates within one reply', () => {
    const captured = captureMemories([
      'CONDUCTOR_MEMORY: The renderer is tested with renderToStaticMarkup | confidence: 4',
      'CONDUCTOR_MEMORY: the renderer is tested with renderToStaticMarkup'
    ].join("\n"))
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ kind: 'semantic', confidence: 1 })
  })
  // The protocol is injected into the prompt and terminals echo it straight back, so the
  // instruction itself must never parse as a memory the agent chose to write.
  it('never captures its own instructions back out of the transcript', () => {
    expect(captureMemories(MEMORY_PROTOCOL)).toEqual([])
  })
  it('keys a capture so a growing assistant snapshot cannot bank the same claim twice', () => {
    const [first] = captureMemories('CONDUCTOR_MEMORY: Vitest runs in a node environment here')
    const [again] = captureMemories('Some earlier prose. CONDUCTOR_MEMORY: vitest runs in a NODE environment here')
    expect(capturedMemoryKey('item-1', first!)).toBe(capturedMemoryKey('item-1', again!))
    expect(capturedMemoryKey('item-2', first!)).not.toBe(capturedMemoryKey('item-1', first!))
  })
  // The directive is still parsed here for capture; hiding it from the reply is the shared
  // helper's job, re-exported so the renderer strips the same pattern it was written against.
  it('re-exports the directive-stripping helper the renderer hides the sentinel with', () => {
    expect(stripMemoryDirectives('Noted.\nCONDUCTOR_MEMORY: Vitest runs in a node environment')).toBe('Noted.\n')
  })
})

describe('forgetting and recall context', () => {
  const ancient = { occurredAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }
  const now = Date.parse('2026-09-09T12:00:00.000Z')
  it('drops only unrehearsed, low-stakes episodes', () => {
    expect(shouldForgetMemory(memory({ ...ancient }), now)).toBe(true)
    expect(shouldForgetMemory(memory({ ...ancient, kind: 'semantic' }), now)).toBe(false)
    expect(shouldForgetMemory(memory({ ...ancient, source: 'human' }), now)).toBe(false)
    expect(shouldForgetMemory(memory({ ...ancient, recallCount: 1 }), now)).toBe(false)
    expect(shouldForgetMemory(memory({ ...ancient, salience: 0.8 }), now)).toBe(false)
    expect(shouldForgetMemory(memory(), now)).toBe(false)
  })
  it('renders recalled memories most-useful-first and stops at the budget', () => {
    const rendered = formatRecalledMemories([
      { kind: 'semantic', gist: 'The app is Electron with a React renderer' },
      { kind: 'procedural', gist: 'Extract pure logic and test it beside the component' }
    ])
    expect(rendered).toBe('- [semantic] The app is Electron with a React renderer\n- [procedural] Extract pure logic and test it beside the component')
    const budgeted = formatRecalledMemories([
      { kind: 'semantic', gist: 'first' },
      { kind: 'semantic', gist: 'second' }
    ], 20)
    expect(budgeted).toBe('- [semantic] first')
  })
})


describe('the canonical kind list', () => {
  it('is the single source every kind menu, validator and parser reads', () => {
    expect(MEMORY_KINDS).toEqual(['episodic', 'semantic', 'procedural'])
    expect(MEMORY_KINDS.every((kind) => isMemoryKind(kind))).toBe(true)
    expect(isMemoryKind('reflexive')).toBe(false)
    expect(isMemoryKind(undefined)).toBe(false)
  })
  // The sentinel and the written contract are both generated from the list, so a kind the
  // protocol offers can never be one the parser silently downgrades to `semantic`.
  it('drives both halves of the agent write contract', () => {
    for (const kind of MEMORY_KINDS) {
      expect(MEMORY_PROTOCOL).toContain(kind)
      const [captured] = captureMemories(`CONDUCTOR_MEMORY[${kind}]: A durable claim about this project`)
      expect(captured?.kind).toBe(kind)
    }
  })
})

describe('the visible prune', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z')
  const ancient = { occurredAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }

  it('leaves a memory a person corrected out of reach of automatic forgetting', () => {
    expect(shouldForgetMemory(memory({ ...ancient }), now)).toBe(true)
    expect(shouldForgetMemory(memory({ ...ancient, correctedAt: '2026-09-01T00:00:00.000Z' }), now)).toBe(false)
  })

  it('ranks decayed memories ahead of ones that are holding their standing', () => {
    const faded = memory({ id: 'faded', ...ancient, salience: 0.2, confidence: 0.3 })
    const held = memory({ id: 'held', kind: 'procedural', salience: 0.9, confidence: 0.95, occurredAt: '2026-09-08T12:00:00.000Z' })
    const ranked = rankMemoriesForPrune([held, faded], now)
    expect(ranked.map((item) => item.memory.id)).toEqual(['faded', 'held'])
    expect(ranked[0]!.standing).toBeLessThan(ranked[1]!.standing)
    expect(ranked[0]!.retrievability).toBeLessThan(0.1)
  })

  // Automatic forgetting only ever drops unrehearsed episodes, so the prune has to explain
  // decay for the kinds it will never touch — otherwise stale knowledge has no route out.
  it('explains why a memory is fading, including for kinds that never decay out on their own', () => {
    expect(memoryPruneReason(memory({ ...ancient }), now)).toBe('Faded, and nothing has ever recalled it')
    // Semantic knowledge outlives an episode, so the same age reads as unused rather than gone.
    expect(memoryPruneReason(memory({ ...ancient, kind: 'semantic' }), now)).toBe('Never recalled since it was written')
    expect(memoryPruneReason(memory({ ...ancient, recallCount: 3, lastRecalledAt: '2020-06-01T00:00:00.000Z' }), now))
      .toBe('Faded since the last time it was recalled')
    expect(memoryPruneReason(memory({ occurredAt: '2026-09-08T12:00:00.000Z', confidence: 0.2 }), now)).toBe('Written with low confidence')
    expect(memoryPruneReason(memory({ occurredAt: '2026-09-08T12:00:00.000Z', salience: 0.2 }), now)).toBe('Never recalled, and marked low-stakes')
    expect(memoryPruneReason(memory({ occurredAt: '2026-09-08T12:00:00.000Z', recallCount: 4, lastRecalledAt: '2026-09-09T00:00:00.000Z' }), now))
      .toBe('Holding its standing')
  })
})
