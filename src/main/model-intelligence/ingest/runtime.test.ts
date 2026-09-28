import { describe, expect, it } from 'vitest'
import { mapRuntime, type ModelsListEntry } from './runtime'

const AT = '2026-09-28T00:00:00.000Z'

describe('runtime source', () => {
  it('takes only what open tabs discovered, as cli facts that never remove anything', () => {
    const list: ModelsListEntry[] = [
      { provider: 'codex', available: true, source: 'runtime', models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', effort: ['low', 'high', 'max'], defaultEffort: 'high', isDefault: true }, { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', effort: ['low'] }] },
      { provider: 'claude', available: true, source: 'runtime', models: [{ id: 'default', label: 'Default (recommended)' }, { id: 'opus[1m]', label: 'Opus (1M context)', effort: ['auto', 'high'] }] },
      { provider: 'grok', available: true, source: 'configured', models: [{ id: 'grok-4.7', label: 'Grok 4.7' }] },
      { provider: 'cloud', available: false, source: 'configured', models: [{ id: 'default', label: 'Claude cloud session' }] }
    ]
    const batches = mapRuntime(list, AT)
    expect(batches.map(batch => [batch.source, batch.complete])).toEqual([[{ kind: 'cli', name: 'runtime:codex' }, false], [{ kind: 'cli', name: 'runtime:claude' }, false]])
    const facts = (provider: string, model: string) => Object.fromEntries(batches.flatMap(batch => batch.observations).filter(entry => entry.key.provider === provider && entry.key.model === model).map(entry => [entry.field, entry.value]))
    expect(facts('codex', 'gpt-6-astra')).toEqual({ displayName: 'GPT-6-Astra', family: 'gpt-6-astra', efforts: ['low', 'high', 'max'], availability: 'available' })
    // The real CLI label carries no version, so runtime makes no family claim and config's stands.
    expect(facts('claude', 'opus[1m]')).toEqual({ displayName: 'Opus (1M context)', efforts: ['high'], availability: 'available' })
    expect(facts('claude', 'default')).toEqual({})
  })
})
