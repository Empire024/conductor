import { describe, expect, it } from 'vitest'
import type { FieldObservation, ModelKey, RegistryField, RegistryValue, SourceRef } from '../../../shared/model-routing'
import { ModelRegistry } from '../registry'
import { ModelIntelligenceStore } from '../store'
import { linkedBatch, LINKED_SOURCE } from './linked'
import { mapOpenRouter } from './openrouter'

const AT = '2026-09-28T00:00:00.000Z'
const CONFIG: SourceRef = { kind: 'config', name: 'configured:claude' }
const CODEX: SourceRef = { kind: 'config', name: 'configured:codex' }
const OPENROUTER = { data: [
  { id: 'anthropic/claude-opus-5', name: 'Anthropic: Claude Opus 5', context_length: 400_000, pricing: { prompt: '0.000015', completion: '0.000075' } },
  { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', context_length: 1_000_000, pricing: { prompt: '0.000005', completion: '0.000025' }, supported_parameters: ['tools'] },
  { id: 'anthropic/claude-opus-5.5:thinking', name: 'Anthropic: Claude Opus 5.5 (thinking)', context_length: 1_000_000, pricing: { prompt: '0.00001', completion: '0.00005' } },
  { id: 'anthropic/claude-haiku-4.5', name: 'Anthropic: Claude Haiku 4.5', context_length: 200_000, pricing: { prompt: '0.000001', completion: '0.000005' } },
  { id: 'openai/gpt-5.6-sol', name: 'OpenAI: GPT-5.6 Sol', context_length: 400_000, pricing: { prompt: '0.00000025', completion: '0.000002' } }
] }

function setup() {
  const store = new ModelIntelligenceStore(':memory:', () => new Date(AT)), registry = new ModelRegistry(store)
  const obs = (source: SourceRef, key: ModelKey, field: RegistryField, value: RegistryValue): FieldObservation => ({ key, field, value, source, observedAt: AT })
  registry.applyBatch({ source: CONFIG, fetchedAt: AT, complete: true, benchmarks: [], observations: [
    obs(CONFIG, { provider: 'claude', model: 'opus[1m]' }, 'displayName', 'Opus (1M context)'),
    obs(CONFIG, { provider: 'claude', model: 'haiku' }, 'displayName', 'Haiku'),
    obs(CONFIG, { provider: 'claude', model: 'mystery' }, 'displayName', 'Mystery'),
    obs(CONFIG, { provider: 'claude', model: 'opus[1m]' }, 'contextTokens', 200_000)
  ] })
  registry.applyBatch({ source: CODEX, fetchedAt: AT, complete: true, benchmarks: [], observations: [obs(CODEX, { provider: 'codex', model: 'gpt-5.6-sol' }, 'displayName', 'GPT-5.6-Sol')] })
  registry.applyBatch(mapOpenRouter(OPENROUTER, AT))
  return { store, registry }
}

describe('linked pass (D1)', () => {
  it('links CLI keys to OpenRouter by family, unversioned Claude aliases to the newest of their tier', () => {
    const { registry } = setup()
    const batch = linkedBatch(registry.list(), AT)!
    expect(batch).toMatchObject({ source: LINKED_SOURCE, complete: false, benchmarks: [] })
    registry.applyBatch(batch)
    expect(registry.get({ provider: 'claude', model: 'opus[1m]' })).toMatchObject({ family: 'claude-opus-5.5', capabilityRank: 3, pricing: { inputPerMTok: 5, outputPerMTok: 25 }, toolUse: true })
    // A config fact outranks the linked aggregator one.
    expect(registry.get({ provider: 'claude', model: 'opus[1m]' })!.contextTokens).toBe(200_000)
    expect(registry.get({ provider: 'claude', model: 'haiku' })).toMatchObject({ family: 'claude-haiku-4.5', capabilityRank: 1, pricing: { inputPerMTok: 1 }, contextTokens: 200_000 })
    expect(registry.get({ provider: 'codex', model: 'gpt-5.6-sol' })).toMatchObject({ family: 'gpt-5.6-sol', capabilityRank: 1, pricing: { inputPerMTok: 0.25, outputPerMTok: 2 }, contextTokens: 400_000 })
    expect(registry.get({ provider: 'claude', model: 'mystery' })).toMatchObject({ family: null, pricing: null, capabilityRank: 2 })
    expect(registry.get({ provider: 'openrouter', model: 'anthropic/claude-opus-5.5' })!.pricing!.inputPerMTok).toBe(5)
  })

  it('re-links without duplicates, and follows a price change', () => {
    const { registry, store } = setup()
    registry.applyBatch(linkedBatch(registry.list(), AT)!)
    const again = registry.applyBatch(linkedBatch(registry.list(), '2026-09-29T00:00:00.000Z')!)
    expect(again.observationsAdded).toBe(0)
    expect(again.changes).toEqual([])
    const cheaper = { data: OPENROUTER.data.map(entry => entry.id === 'anthropic/claude-opus-5.5' ? { ...entry, pricing: { prompt: '0.000004', completion: '0.00002' } } : entry) }
    registry.applyBatch(mapOpenRouter(cheaper, '2026-09-30T00:00:00.000Z'))
    const relinked = registry.applyBatch(linkedBatch(registry.list(), '2026-09-30T00:00:00.000Z')!)
    expect(relinked.changes.filter(change => change.key.model === 'opus[1m]').map(change => [change.kind, change.after])).toEqual([['price', 4], ['price', 20]])
    expect(store.observations({ provider: 'claude', model: 'opus[1m]' }, 'priceInputPerMTok')).toHaveLength(2)
  })

  it('has nothing to link without aggregator records', () => {
    const store = new ModelIntelligenceStore(':memory:'), registry = new ModelRegistry(store)
    expect(linkedBatch(registry.list(), AT)).toBeNull()
  })
})
