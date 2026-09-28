import { describe, expect, it } from 'vitest'
import type { FieldObservation, IngestionBatch, ModelKey, RegistryField, RegistryValue, SourceRef } from '../../shared/model-routing'
import { familyOf, ModelRegistry } from './registry'
import { ModelIntelligenceStore } from './store'

const CLI: SourceRef = { kind: 'cli', name: 'runtime:claude' }
const CONFIG: SourceRef = { kind: 'config', name: 'configured:claude' }
const ROUTER: SourceRef = { kind: 'aggregator', name: 'openrouter', url: 'https://openrouter.ai/api/v1/models' }
const opus: ModelKey = { provider: 'claude', model: 'opus[1m]' }
const routedOpus: ModelKey = { provider: 'openrouter', model: 'anthropic/claude-opus-5.5' }
const sonnet: ModelKey = { provider: 'claude', model: 'sonnet' }

function setup(start = '2026-09-28T00:00:00Z') {
  let now = new Date(start)
  const store = new ModelIntelligenceStore(':memory:', () => now)
  return { store, registry: new ModelRegistry(store), advance: (days: number) => { now = new Date(now.getTime() + days * 86_400_000) } }
}

type Facts = Partial<Record<RegistryField, RegistryValue>>
function batch(source: SourceRef, models: Array<[ModelKey, Facts]>, fetchedAt = '2026-09-28T00:00:00Z', complete = true): IngestionBatch {
  const observations: FieldObservation[] = models.flatMap(([key, facts]) => Object.entries(facts).map(([field, value]) => ({ key, field: field as RegistryField, value: value!, source, observedAt: fetchedAt })))
  return { source, fetchedAt, observations, benchmarks: [], complete }
}

describe('familyOf', () => {
  it('maps aliases, API ids and aggregator ids of the same weights to one family', () => {
    expect(familyOf('opus[1m]', 'Claude Opus 5.5 (1M context)')).toBe('claude-opus-5.5')
    expect(familyOf('claude-opus-5-5')).toBe('claude-opus-5.5')
    expect(familyOf('anthropic/claude-opus-5.5')).toBe('claude-opus-5.5')
    expect(familyOf('haiku', 'Claude Haiku 4.5')).toBe('claude-haiku-4.5')
    expect(familyOf('claude-haiku-4-5-20251001')).toBe('claude-haiku-4.5')
    expect(familyOf('claude-3-5-sonnet-20241022')).toBe('claude-sonnet-3.5')
    expect(familyOf('claude-fable-5-1', 'Claude Fable 5.1')).toBe('claude-fable-5.1')
    expect(familyOf('gpt-5.6-sol', 'GPT-5.6-Sol')).toBe('gpt-5.6-sol')
    expect(familyOf('openai/gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(familyOf('local/qwen3.6-35b-a3b', 'Qwen 3.6 35B-A3B')).toBe('qwen3.6-35b-a3b')
    expect(familyOf('qwen/qwen3.6-35b-a3b:free')).toBe('qwen3.6-35b-a3b')
    expect(familyOf('default', 'Default for account')).toBeNull()
    expect(familyOf('opus[1m]', 'Opus (1M context)')).toBeNull()
    expect(familyOf('sonnet', 'Sonnet 5')).toBe('claude-sonnet-5')
    expect(familyOf('pro', 'Gemini Pro')).toBeNull()
  })
})

describe('ModelRegistry', () => {
  it('round-trips a record with every field, provenance and an unproven status', () => {
    const { registry } = setup()
    const applied = registry.applyBatch(batch(CLI, [[opus, { displayName: 'Claude Opus 5.5 (1M context)', contextTokens: 1_000_000, efforts: ['low', 'high'], toolUse: true, availability: 'available', priceInputPerMTok: 5 }]]))
    expect(applied).toMatchObject({ keys: 1, observationsAdded: 6, observationsConfirmed: 0 })
    const record = registry.get(opus)!
    expect(record).toMatchObject({
      key: opus, status: 'unproven', displayName: 'Claude Opus 5.5 (1M context)', family: 'claude-opus-5.5', contextTokens: 1_000_000, efforts: ['low', 'high'], toolUse: true,
      availability: 'available', pricing: { inputPerMTok: 5, outputPerMTok: null, cachedInputPerMTok: null, currency: 'USD' }, local: null, stale: false,
      firstSeenAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z'
    })
    expect(record.provenance.contextTokens).toEqual({ source: CLI, observedAt: '2026-09-28T00:00:00.000Z' })
    expect(registry.list()).toEqual([record])
    expect(registry.list({ provider: 'codex' })).toEqual([])
  })

  it('keeps two providers of one family as separate records and relates them through family()', () => {
    const { registry } = setup()
    registry.applyBatch(batch(CLI, [[opus, { displayName: 'Claude Opus 5.5 (1M context)' }], [sonnet, { displayName: 'Claude Sonnet 5' }]]))
    registry.applyBatch(batch(ROUTER, [[routedOpus, { displayName: 'Anthropic: Claude Opus 5.5', family: 'claude-opus-5.5', priceInputPerMTok: 5, priceOutputPerMTok: 25 }]]))
    expect(registry.get(opus)!.pricing).toBeNull()
    expect(registry.get(routedOpus)!.pricing).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 })
    expect(registry.family(opus).map(record => record.key)).toEqual([routedOpus])
    expect(registry.family(routedOpus).map(record => record.key)).toEqual([opus])
    expect(registry.family(sonnet)).toEqual([])
  })

  it('keeps provenance: higher authority wins, recency breaks ties, and every value stays auditable', () => {
    const { registry } = setup()
    registry.applyBatch(batch(CONFIG, [[opus, { contextTokens: 200_000, efforts: ['low'] }]], '2026-09-20T00:00:00Z'))
    registry.applyBatch(batch(CLI, [[opus, { contextTokens: 1_000_000 }]], '2026-09-21T00:00:00Z', false))
    registry.applyBatch(batch(CONFIG, [[opus, { contextTokens: 400_000, efforts: ['low', 'high'] }]], '2026-09-22T00:00:00Z'))
    const record = registry.get(opus)!
    expect(record.contextTokens).toBe(1_000_000)
    expect(record.provenance.contextTokens?.source).toEqual(CLI)
    expect(record.efforts).toEqual(['low', 'high'])
    expect(record.provenance.efforts).toEqual({ source: CONFIG, observedAt: '2026-09-22T00:00:00.000Z' })
    expect(registry.observations(opus, 'contextTokens').map(entry => [entry.source.name, entry.value])).toEqual([['configured:claude', 400_000], ['runtime:claude', 1_000_000], ['configured:claude', 200_000]])
    const second = { kind: 'conductor' as const, name: 'conductor:probe' }
    registry.applyBatch(batch(second, [[opus, { efforts: ['max'] }]], '2026-09-23T00:00:00Z', false))
    expect(registry.get(opus)!.efforts).toEqual(['max'])
  })

  it('re-applying the same batch confirms instead of duplicating, and moves only the confirmation time', () => {
    const { registry, store } = setup()
    const first = batch(CLI, [[opus, { displayName: 'Opus', contextTokens: 1_000_000 }]], '2026-09-20T00:00:00Z')
    registry.applyBatch(first)
    const again = registry.applyBatch({ ...first, fetchedAt: '2026-09-27T00:00:00Z', observations: first.observations.map(entry => ({ ...entry, observedAt: '2026-09-27T00:00:00Z' })) })
    expect(again).toMatchObject({ observationsAdded: 0, observationsConfirmed: 2, changes: [] })
    expect(store.observations(opus)).toHaveLength(2)
    expect(store.observations(opus)[0]).toMatchObject({ observedAt: '2026-09-20T00:00:00.000Z', confirmedAt: '2026-09-27T00:00:00.000Z' })
    expect(registry.get(opus)).toMatchObject({ firstSeenAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z' })
    expect(registry.list()).toHaveLength(1)
  })

  it('rolls back a batch that throws part-way: no observation, record or change survives', () => {
    const { registry, store } = setup()
    registry.applyBatch(batch(CLI, [[opus, { contextTokens: 1_000_000 }]]))
    const bad = batch(CLI, [[opus, { contextTokens: 2_000_000 }], [sonnet, { displayName: 'Sonnet' }], [sonnet, { contextTokens: -5 }]], '2026-09-28T01:00:00Z')
    expect(() => registry.applyBatch(bad)).toThrow(/non-negative number/)
    const unknownField = { ...batch(CLI, [[sonnet, { displayName: 'Sonnet' }]]), observations: [{ key: sonnet, field: 'weights' as RegistryField, value: 1, source: CLI, observedAt: '2026-09-28T00:00:00Z' }] }
    expect(() => registry.applyBatch(unknownField)).toThrow(/Unknown registry field/)
    expect(() => registry.applyBatch(batch(CLI, [], '2026-09-28T01:00:00Z'))).toThrow(/lists no models/)
    expect(registry.get(opus)!.contextTokens).toBe(1_000_000)
    expect(registry.get(sonnet)).toBeNull()
    expect(store.observations(opus)).toHaveLength(1)
    expect(registry.changes({ since: '2026-01-01T00:00:00Z' }).map(change => change.kind)).toEqual(['new-model', 'new-provider'])
    const partial = [batch(CLI, [[sonnet, { displayName: 'Sonnet' }]]), batch(CLI, [[sonnet, { availability: 'gone' }]])]
    expect(() => registry.applyBatches(partial)).toThrow(/availability/)
    expect(registry.get(sonnet)).toBeNull()
  })

  it('detects new models, new providers, price, context, capability and availability changes', () => {
    const { registry } = setup()
    const first = registry.applyBatch(batch(ROUTER, [[routedOpus, { priceInputPerMTok: 5, contextTokens: 200_000, toolUse: false, availability: 'available' }]], '2026-09-20T00:00:00Z'))
    expect(first.changes.map(change => [change.kind, change.key.model])).toEqual([['new-model', routedOpus.model], ['new-provider', routedOpus.model]])
    const second = registry.applyBatch(batch(ROUTER, [
      [routedOpus, { priceInputPerMTok: 4, contextTokens: 1_000_000, toolUse: true, availability: 'limited' }],
      [{ provider: 'openrouter', model: 'openai/gpt-5.6-sol' }, { priceInputPerMTok: 2 }]
    ], '2026-09-21T00:00:00Z'))
    expect(second.changes.map(change => ({ kind: change.kind, field: change.field, before: change.before, after: change.after }))).toEqual([
      { kind: 'context', field: 'contextTokens', before: 200_000, after: 1_000_000 },
      { kind: 'capability', field: 'toolUse', before: false, after: true },
      { kind: 'price', field: 'priceInputPerMTok', before: 5, after: 4 },
      { kind: 'availability', field: 'availability', before: 'available', after: 'limited' },
      { kind: 'new-model', field: undefined, before: undefined, after: 'openai/gpt-5.6-sol' }
    ])
    expect(second.changes.every(change => change.source === ROUTER && change.at === '2026-09-21T00:00:00.000Z')).toBe(true)
    expect(registry.changes({ since: '2026-09-21T00:00:00Z' })).toHaveLength(5)
    expect(registry.changes({ since: '2026-09-20T00:00:00Z', key: routedOpus }).map(change => change.kind)).toEqual(['new-model', 'new-provider', 'context', 'capability', 'price', 'availability'])
  })

  it('treats a key a complete source stops listing as removed, and retires it only when every source dropped it', () => {
    const { registry } = setup()
    registry.applyBatch(batch(CONFIG, [[opus, { displayName: 'Opus' }], [sonnet, { displayName: 'Sonnet' }]], '2026-09-20T00:00:00Z'))
    registry.applyBatch(batch(CLI, [[opus, { availability: 'available' }], [sonnet, { availability: 'available' }]], '2026-09-20T00:00:00Z'))
    const dropped = registry.applyBatch(batch(CONFIG, [[opus, { displayName: 'Opus' }]], '2026-09-21T00:00:00Z'))
    expect(dropped.changes).toMatchObject([{ kind: 'removed', key: sonnet, source: CONFIG }])
    expect(registry.get(sonnet)!.status).toBe('unproven')
    registry.applyBatch(batch(CLI, [[opus, { availability: 'available' }]], '2026-09-22T00:00:00Z'))
    expect(registry.get(sonnet)!.status).toBe('retired')
    expect(registry.list().map(record => record.key.model)).toEqual(['opus[1m]'])
    expect(registry.list({ includeRetired: true })).toHaveLength(2)
    const incomplete = registry.applyBatch(batch({ kind: 'cli', name: 'runtime:claude-2' }, [[opus, { availability: 'available' }]], '2026-09-23T00:00:00Z', false))
    expect(incomplete.changes.filter(change => change.kind === 'removed')).toEqual([])
    const back = registry.applyBatch(batch(CLI, [[opus, { availability: 'available' }], [sonnet, { availability: 'available' }]], '2026-09-24T00:00:00Z'))
    expect(back.changes).toMatchObject([{ kind: 'new-model', key: sonnet }])
    expect(registry.get(sonnet)!.status).toBe('unproven')
    expect(registry.get(sonnet)!.displayName).toBe('Sonnet')
  })

  it('computes stale on read from the last confirmation', () => {
    const { registry, advance } = setup('2026-09-20T00:00:00Z')
    registry.applyBatch(batch(CLI, [[opus, { displayName: 'Opus' }]], '2026-09-20T00:00:00Z'))
    advance(6)
    expect(registry.get(opus)!.stale).toBe(false)
    advance(2)
    expect(registry.get(opus)!.stale).toBe(true)
    expect(registry.list()[0]!.stale).toBe(true)
    registry.applyBatch(batch(CLI, [[opus, { displayName: 'Opus' }]], '2026-09-28T00:00:00Z'))
    expect(registry.get(opus)!.stale).toBe(false)
    registry.applyBatch(batch(CONFIG, [[opus, { displayName: 'Opus' }]], '2026-09-01T00:00:00Z'))
    expect(registry.get(opus)!.updatedAt).toBe('2026-09-28T00:00:00.000Z')
  })

  it('sets and promotes status without letting ingestion or promote revive a retired key', () => {
    const { registry } = setup()
    registry.applyBatch(batch(CLI, [[opus, { displayName: 'Opus' }]]))
    expect(registry.setStatus(opus, 'evaluating').status).toBe('evaluating')
    registry.applyBatch(batch(CLI, [[opus, { displayName: 'Opus 5.5' }]], '2026-09-28T01:00:00Z'))
    expect(registry.get(opus)!.status).toBe('evaluating')
    expect(registry.promote(opus).status).toBe('proven')
    expect(registry.list({ status: 'proven' })).toHaveLength(1)
    registry.setStatus(opus, 'retired')
    expect(registry.promote(opus).status).toBe('retired')
    expect(() => registry.setStatus(sonnet, 'proven')).toThrow(/not registered/)
  })

  it('gives local keys a local block, and stores benchmarks without touching factual fields', () => {
    const { registry, store } = setup()
    const qwen = { provider: 'local', model: 'local/qwen3.6-35b-a3b' }
    const bench = { kind: 'benchmark' as const, name: 'benchmark:swe' }
    registry.applyBatch(batch({ kind: 'config', name: 'configured:local' }, [[qwen, { localQuant: 'Q4_K_M', localSizeGb: 19.02, localGpuLayers: 10 }]]))
    const applied = registry.applyBatch({ source: bench, fetchedAt: '2026-09-28T00:00:00Z', observations: [], complete: false, benchmarks: [{ key: qwen, benchmark: 'swe-bench-verified', score: 0.5, raw: '50%', categories: ['difficult-coding'], source: bench, observedAt: '2026-09-28T00:00:00Z' }] })
    expect(applied).toMatchObject({ keys: 0, benchmarksAdded: 1, changes: [] })
    expect(registry.get(qwen)!.local).toEqual({ sizeGb: 19.02, quant: 'Q4_K_M', vramGb: null, gpuLayers: 10, loaded: false })
    expect(store.benchmarks(qwen).map(entry => entry.score)).toEqual([0.5])
  })
})
