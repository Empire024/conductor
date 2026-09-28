import { describe, expect, it } from 'vitest'
import type { AgentProviderInfo } from '../../../shared/models'
import { ModelRegistry } from '../registry'
import { ModelIntelligenceStore } from '../store'
import type { ConfiguredCatalogs } from './configured'
import { refreshAll, type IngestionPorts } from './index'

const efforts: AgentProviderInfo['efforts'] = [{ id: 'high', label: 'High' }]
const catalogs = (models: Array<{ id: string; label: string }>): ConfiguredCatalogs => ({ providers: [{ id: 'codex', displayName: 'Codex', available: true, models, efforts }], localModels: null })
const openRouterBody = (price: string, extra: object[] = []) => JSON.stringify({ data: [{ id: 'openai/gpt-5.6-sol', name: 'OpenAI: GPT-5.6 Sol', context_length: 400000, pricing: { prompt: price, completion: '0.00001' }, supported_parameters: ['tools'] }, ...extra] })

function setup() {
  let now = new Date('2026-09-28T00:00:00Z')
  const store = new ModelIntelligenceStore(':memory:', () => now)
  return { store, registry: new ModelRegistry(store), tick: (hours: number) => { now = new Date(now.getTime() + hours * 3_600_000) }, now: () => now }
}

describe('refreshAll', () => {
  it('runs every source independently: one failing fetch leaves the registry untouched and the rest apply', async () => {
    const { registry, store, now } = setup()
    const ports: IngestionPorts = {
      now,
      configured: { catalogs: () => catalogs([{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }]) },
      openrouter: { fetch: async () => { throw new TypeError('getaddrinfo ENOTFOUND openrouter.ai') } },
      latestModels: { outputs: () => ({ cliCatalogs: null, primarySources: null }) },
      runtime: { modelsList: () => { throw new Error('control unavailable') } }
    }
    const result = await refreshAll(registry, ports)
    expect(result.results.map(entry => [entry.source, entry.status])).toEqual([['configured', 'ok'], ['runtime', 'failed'], ['latest-models', 'ok'], ['openrouter', 'failed'], ['benchmarks', 'skipped']])
    expect(result.results.find(entry => entry.source === 'openrouter')!.errors[0]).toMatch(/ENOTFOUND/)
    expect(registry.list().map(record => record.key)).toEqual([{ provider: 'codex', model: 'gpt-5.6-sol' }])
    expect(result.changes.map(change => change.kind)).toEqual(['new-model', 'new-provider'])
    expect(store.observations({ provider: 'openrouter', model: 'openai/gpt-5.6-sol' })).toEqual([])
  })

  it('an invalid batch from one source rolls back that source alone', async () => {
    const { registry } = setup()
    registry.applyBatch({ source: { kind: 'aggregator', name: 'openrouter' }, fetchedAt: '2026-09-27T00:00:00Z', complete: true, benchmarks: [], observations: [
      { key: { provider: 'openrouter', model: 'openai/gpt-5.6-sol' }, field: 'priceInputPerMTok', value: 2, source: { kind: 'aggregator', name: 'openrouter' }, observedAt: '2026-09-27T00:00:00Z' }
    ] })
    const result = await refreshAll(registry, {
      configured: { catalogs: () => ({ providers: [
        { id: 'codex', displayName: 'Codex', available: true, models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }], efforts },
        { id: 'claude', displayName: 'Claude', available: true, models: [{ id: 'x'.repeat(300), label: 'too long' }], efforts }
      ], localModels: null }) },
      openrouter: { fetch: async () => new Response('{"data": []}') }
    }, ['configured', 'openrouter'])
    expect(result.results.map(entry => [entry.source, entry.status, entry.batches])).toEqual([['configured', 'failed', 0], ['openrouter', 'failed', 0]])
    expect(result.results[0]!.errors[0]).toMatch(/^apply: Invalid model key/)
    expect(result.results[1]!.errors[0]).toMatch(/listed no models/)
    expect(registry.list().map(record => record.key.provider)).toEqual(['openrouter'])
    expect(registry.get({ provider: 'openrouter', model: 'openai/gpt-5.6-sol' })!.pricing?.inputPerMTok).toBe(2)
  })

  it('detects a new model and a price change across refreshes, and nothing on an unchanged one', async () => {
    const { registry, tick, now } = setup()
    let body = openRouterBody('0.000002')
    const ports: IngestionPorts = { now, openrouter: { fetch: async () => new Response(body) } }
    const first = await refreshAll(registry, ports, ['openrouter'])
    expect(first.changes.map(change => change.kind)).toEqual(['new-model', 'new-provider'])
    tick(24)
    expect((await refreshAll(registry, ports, ['openrouter'])).changes).toEqual([])
    tick(24)
    body = openRouterBody('0.0000015', [{ id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', context_length: 1000000, pricing: { prompt: '0.000005', completion: '0.000025' } }])
    const third = await refreshAll(registry, ports, ['openrouter'])
    expect(third.changes.map(change => [change.kind, change.key.model, change.before, change.after])).toEqual([
      ['price', 'openai/gpt-5.6-sol', 2, 1.5], ['new-model', 'anthropic/claude-opus-5.5', undefined, 'Anthropic: Claude Opus 5.5']
    ])
    expect(third.results[0]).toMatchObject({ status: 'ok', batches: 1, models: 2 })
  })

  it('marks records stale when their sources stop confirming them, and fresh again on the next refresh', async () => {
    const { registry, tick, now } = setup()
    const ports: IngestionPorts = { now, configured: { catalogs: () => catalogs([{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }]) } }
    await refreshAll(registry, ports, ['configured'])
    tick(24 * 8)
    expect(registry.get({ provider: 'codex', model: 'gpt-5.6-sol' })!.stale).toBe(true)
    await refreshAll(registry, ports, ['configured'])
    expect(registry.get({ provider: 'codex', model: 'gpt-5.6-sol' })!.stale).toBe(false)
  })
})
