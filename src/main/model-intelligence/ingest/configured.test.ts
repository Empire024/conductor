import { describe, expect, it } from 'vitest'
import { CLAUDE_MODELS } from '../../agent-manager'
import { defaultModelConfig, QWEN_35B, QWEN_9B } from '../../local-models/config'
import { fetchBatches, mapConfigured, type ConfiguredCatalogs } from './configured'

const AT = '2026-09-28T00:00:00.000Z'
const efforts = ['auto', 'low', 'medium', 'high'].map(id => ({ id: id as 'auto', label: id }))

/** Real catalog and config data: the shipped Claude catalog and the pinned local defaults. */
const catalogs = (local: ConfiguredCatalogs['localModels']): ConfiguredCatalogs => ({
  providers: [
    { id: 'claude', displayName: 'Claude Code', available: true, models: CLAUDE_MODELS, efforts },
    { id: 'grok', displayName: 'Grok', available: false, models: [{ id: 'default', label: 'Default' }, { id: 'grok-4.7', label: 'Grok 4.7' }], efforts },
    { id: 'local', displayName: 'Local', available: Boolean(local), models: (local ?? []).map(model => ({ id: model.id, label: model.label })), efforts: [{ id: 'auto', label: 'Provider default' }] }
  ],
  localModels: local
})

describe('configured source', () => {
  it('maps each provider catalog to its own complete config batch, without placeholder ids', () => {
    const local = [{ ...defaultModelConfig(QWEN_35B), vramBytes: 11.5 * 1024 ** 3 }, defaultModelConfig(QWEN_9B)]
    const batches = mapConfigured(catalogs(local), AT)
    expect(batches.map(batch => [batch.source, batch.complete])).toEqual([
      [{ kind: 'config', name: 'configured:claude' }, true], [{ kind: 'config', name: 'configured:grok' }, true], [{ kind: 'config', name: 'configured:local' }, true]
    ])
    const facts = (provider: string, model: string) => Object.fromEntries(batches.flatMap(batch => batch.observations).filter(entry => entry.key.provider === provider && entry.key.model === model).map(entry => [entry.field, entry.value]))
    expect(batches[0]!.observations.some(entry => entry.key.model === 'default')).toBe(false)
    expect(facts('claude', 'opus[1m]')).toEqual({ displayName: 'Claude Opus 5.5 (1M context)', family: 'claude-opus-5.5', efforts: ['low', 'medium', 'high'], availability: 'available' })
    expect(facts('grok', 'grok-4.7')).toMatchObject({ availability: 'unavailable', family: 'grok-4.7' })
    expect(facts('local', QWEN_35B)).toEqual({
      displayName: 'Qwen3.6 35B-A3B (local)', family: 'qwen3.6-35b-a3b', efforts: [], availability: 'available', contextTokens: 32768,
      localQuant: 'Q4_K_M', localSizeGb: 19.02, localVramGb: 11.5, localGpuLayers: 10, toolUse: true
    })
    expect(facts('local', QWEN_9B).localVramGb).toBeUndefined()
  })

  it('skips the local catalog when the local stack is not set up, instead of removing its models', async () => {
    const batches = await fetchBatches({ catalogs: () => catalogs(null) }, () => new Date(AT))
    expect(batches.map(batch => batch.source.name)).toEqual(['configured:claude', 'configured:grok'])
    expect(batches[0]!.fetchedAt).toBe(AT)
  })
})
